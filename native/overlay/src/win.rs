//! Windows: a plain Win32 popup, restacked directly above Chrome's window. No tao: its style
//! changes call ShowWindow(SW_SHOW), which activates (a `blur` in the page). Never activated:
//! WS_EX_NOACTIVATE, MA_NOACTIVATE, every show and move with SWP_NOACTIVATE. Not owned by Chrome's
//! window: a cross-process owner attaches the input queues, so a stall here would stall Chrome.
//! Coordinates: physical pixels (per-monitor DPI aware).
use crate::core::{Ev, Host, Os, Rect, builder, emit, read_stdin};
use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use serde_json::json;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::num::NonZeroIsize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    DwmEnableBlurBehindWindow, DwmGetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::OleInitialize;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumChildWindows, EnumWindows, GW_HWNDPREV,
    GWL_EXSTYLE, GetClassNameW, GetCursorPos, GetMessageW, GetWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, HWND_TOP, IDC_ARROW, IsIconic, IsWindow,
    IsWindowVisible, LoadCursorW, MA_NOACTIVATE, MSG, PostMessageW, RegisterClassW, SW_HIDE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage,
    WM_APP, WM_CLOSE, WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{BOOL, w};

const WM_POST: u32 = WM_APP + 1;
static PANEL: AtomicIsize = AtomicIsize::new(0);
/// Events from other threads (stdin) and from wry's callbacks; drained on the UI thread.
static QUEUE: Mutex<VecDeque<Ev>> = Mutex::new(VecDeque::new());

thread_local! {
    static HOST: RefCell<Option<Host<Win>>> = const { RefCell::new(None) };
}

fn post(ev: Ev) {
    QUEUE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push_back(ev);
    let h = PANEL.load(Ordering::Acquire);
    if h != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(h as _)), WM_POST, WPARAM(0), LPARAM(0));
        }
    }
}

/// Runs queued events; a call nested in another (wry pumping messages) leaves them to the outer one.
fn drain(tick: bool) {
    HOST.with(|c| {
        let Ok(mut g) = c.try_borrow_mut() else {
            return;
        };
        let Some(host) = g.as_mut() else { return };
        if tick {
            host.on(Ev::Tick);
        }
        loop {
            let ev = QUEUE.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
            match ev {
                Some(ev) => host.on(ev),
                None => break,
            }
        }
    });
}

unsafe extern "system" fn wndproc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        // a click on the panel (or WebView2's child, which asks its parent) never activates us
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_POST => {
            drain(false);
            LRESULT(0)
        }
        WM_TIMER => {
            drain(true);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        // only stdin's end closes us
        WM_CLOSE => LRESULT(0),
        _ => unsafe { DefWindowProcW(h, msg, wp, lp) },
    }
}

struct Handle(NonZeroIsize);

impl HasWindowHandle for Handle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::Win32(Win32WindowHandle::new(self.0));
        // the window lives for the whole process
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

pub struct Win {
    hwnd: HWND,
    placed: Rect,
    ignoring: bool,
}

fn hwnd(id: isize) -> HWND {
    HWND(id as _)
}

/// Visible bounds (no invisible resize borders), physical pixels.
fn bounds(h: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut r).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .is_ok()
        || unsafe { GetWindowRect(h, &mut r) }.is_ok();
    ok.then(|| Rect {
        x: f64::from(r.left),
        y: f64::from(r.top),
        w: f64::from(r.right - r.left),
        h: f64::from(r.bottom - r.top),
    })
}

/// Bounds with the invisible resize borders.
fn outer(h: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(h, &mut r) }.ok()?;
    Some(Rect {
        x: f64::from(r.left),
        y: f64::from(r.top),
        w: f64::from(r.right - r.left),
        h: f64::from(r.bottom - r.top),
    })
}

fn class_is(h: HWND, name: &str) -> bool {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..n.min(buf.len())]) == name
}

fn dpi_scale(h: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(h) };
    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

unsafe extern "system" fn collect(h: HWND, lp: LPARAM) -> BOOL {
    // lp is the `&mut Vec<isize>` of the caller, alive for the whole enumeration
    let out = unsafe { &mut *(lp.0 as *mut Vec<isize>) };
    out.push(h.0 as isize);
    BOOL(1)
}

fn top_windows() -> Vec<isize> {
    let mut out: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM((&raw mut out) as isize));
    }
    out
}

fn children(of: HWND) -> Vec<isize> {
    let mut out: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(of), Some(collect), LPARAM((&raw mut out) as isize));
    }
    out
}

impl Win {
    fn set_ex(&self, add: u32, remove: u32) {
        unsafe {
            let ex = GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) as u32;
            let next = (ex | add) & !remove;
            if next != ex {
                SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, next as isize);
                let _ = SetWindowPos(
                    self.hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }
}

impl Os for Win {
    type Id = isize;

    fn find(&self, pid: u32, want: Rect) -> Option<isize> {
        top_windows()
            .into_iter()
            .filter_map(|id| {
                let h = hwnd(id);
                let mut owner = 0u32;
                unsafe { GetWindowThreadProcessId(h, Some(&mut owner)) };
                let ok = unsafe { IsWindowVisible(h) }.as_bool()
                    && (if pid != 0 {
                        owner == pid
                    } else {
                        class_is(h, "Chrome_WidgetWin_1")
                    });
                if !ok || id == self.hwnd.0 as isize {
                    return None;
                }
                // CDP's bounds are DIPs
                let s = dpi_scale(h);
                let dist = |b: Rect| {
                    (b.x / s - want.x).abs()
                        + (b.y / s - want.y).abs()
                        + (b.w / s - want.w).abs()
                        + (b.h / s - want.h).abs()
                };
                // CDP's bounds may count the invisible resize borders
                let d = dist(bounds(h)?).min(outer(h).map_or(f64::MAX, dist));
                Some((id, d))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .filter(|(_, d)| *d < 40.0)
            .map(|(id, _)| id)
    }

    fn frame(&self, id: isize) -> Option<(Rect, bool)> {
        let h = hwnd(id);
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return None;
        }
        let mut cloaked = 0u32;
        let _ = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                (&raw mut cloaked).cast(),
                size_of::<u32>() as u32,
            )
        };
        // minimized, hidden, or on another virtual desktop
        let on = unsafe { IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() } && cloaked == 0;
        Some((bounds(h)?, on))
    }

    fn scale(&self, id: isize, _at: Rect) -> (f64, f64) {
        let s = dpi_scale(hwnd(id));
        (s, s)
    }

    /// Chrome's render child is the viewport exactly, where Chrome still makes one.
    fn viewport(&self, id: isize) -> Option<Rect> {
        children(hwnd(id))
            .into_iter()
            .map(hwnd)
            .filter(|&h| {
                unsafe { IsWindowVisible(h) }.as_bool()
                    && class_is(h, "Chrome_RenderWidgetHostHWND")
            })
            .filter_map(outer)
            .filter(|r| r.w > 1.0 && r.h > 1.0)
            .max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
    }

    fn place(&mut self, r: Rect) {
        if r != self.placed {
            self.placed = r;
            unsafe {
                let _ = SetWindowPos(
                    self.hwnd,
                    None,
                    r.x.round() as i32,
                    r.y.round() as i32,
                    r.w.round() as i32,
                    r.h.round() as i32,
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
                );
            }
        }
    }

    /// Between Chrome's window and the one above it: other apps cover both, as they cover Chrome.
    fn order(&mut self, id: isize) {
        unsafe {
            let above = GetWindow(hwnd(id), GW_HWNDPREV).ok();
            let shown = IsWindowVisible(self.hwnd).as_bool();
            if shown && above == Some(self.hwnd) {
                return;
            }
            // inserted after a topmost window, ours would turn topmost
            let after = above
                .filter(|&a| a != self.hwnd)
                .filter(|&a| GetWindowLongPtrW(a, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 == 0)
                .unwrap_or(HWND_TOP);
            let _ = SetWindowPos(
                self.hwnd,
                Some(after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    fn hide(&mut self) {
        unsafe {
            if IsWindowVisible(self.hwnd).as_bool() {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
        }
    }

    fn visible(&self) -> bool {
        unsafe { IsWindowVisible(self.hwnd) }.as_bool()
    }

    fn cursor(&self) -> (f64, f64, bool) {
        let mut p = windows::Win32::Foundation::POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        let down = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
            .iter()
            .any(|k| unsafe { GetAsyncKeyState(i32::from(k.0)) } < 0);
        let s = dpi_scale(self.hwnd);
        (
            (f64::from(p.x) - self.placed.x) / s,
            (f64::from(p.y) - self.placed.y) / s,
            down,
        )
    }

    fn ignoring(&self) -> bool {
        self.ignoring
    }

    /// Click-through to other apps' windows needs layered + transparent (as tao does).
    fn ignore(&mut self, on: bool) {
        self.ignoring = on;
        let both = (WS_EX_TRANSPARENT | WS_EX_LAYERED).0;
        if on {
            self.set_ex(both, 0)
        } else {
            self.set_ex(0, both)
        }
    }
}

fn fail(what: &str, e: impl std::fmt::Display) -> ! {
    eprintln!("the overlay host failed: {what}: {e}");
    std::process::exit(1)
}

pub fn run() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        // WebView2 needs a single-threaded apartment
        if let Err(e) = OleInitialize(None) {
            fail("OleInitialize", e);
        }
    }
    let inst = unsafe { GetModuleHandleW(None) }.unwrap_or_else(|e| fail("module", e));
    let class = w!("AutobrowseOverlay");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: inst.into(),
        lpszClassName: class,
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default(),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&wc) } == 0 {
        fail("RegisterClassW", windows::core::Error::from_thread());
    }
    let h = unsafe {
        CreateWindowExW(
            // click-through comes after creation: layered at CreateWindowEx stays invisible
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class,
            w!(""),
            WS_POPUP,
            0,
            0,
            10,
            10,
            None,
            None,
            Some(inst.into()),
            None,
        )
    }
    .unwrap_or_else(|e| fail("CreateWindowExW", e));
    unsafe {
        // per-pixel transparency: DWM blur-behind with an empty region (as tao does)
        let rgn = CreateRectRgn(0, 0, -1, -1);
        let bb = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
            fEnable: true.into(),
            hRgnBlur: rgn,
            fTransitionOnMaximized: false.into(),
        };
        let _ = DwmEnableBlurBehindWindow(h, &bb);
        let _ = DeleteObject(rgn.into());
    }
    PANEL.store(h.0 as isize, Ordering::Release);
    let handle = Handle(NonZeroIsize::new(h.0 as isize).unwrap_or_else(|| fail("hwnd", "null")));
    let web = builder(post)
        .build(&handle)
        .unwrap_or_else(|e| fail("webview", e));
    HOST.with(|c| {
        *c.borrow_mut() = Some(Host::new(
            Win {
                hwnd: h,
                placed: Rect::default(),
                ignoring: false,
            },
            web,
        ));
        if let Some(host) = c.borrow_mut().as_mut() {
            host.os.ignore(true);
        }
    });
    read_stdin(post, || std::process::exit(0));
    unsafe {
        SetTimer(Some(h), 1, 16, None);
    }
    emit(&json!({"t": "ready"}));
    // events already queued (wry's first callbacks)
    post(Ev::Tick);
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
