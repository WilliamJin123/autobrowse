//! Linux, X11 only: a GTK popup (override-redirect: the window manager never maps, focuses or
//! decorates it), restacked directly above Chrome's frame by us, as on macOS. No tao. Wayland
//! cannot place a window over another app's, so the session never starts us there.
//! Coordinates: X11 root pixels. Every Xlib call runs inside a gdk error trap: Chrome's window can
//! go at any time, and Xlib's default error handler exits the process.
use crate::core::{Ev, Host, Os, Rect, builder, emit, read_stdin};
use gdkx11::{X11Display, X11Window};
use gtk::gdk;
use gtk::glib::{self, ControlFlow, MainContext};
use gtk::prelude::*;
use serde_json::json;
use std::cell::RefCell;
use std::ffi::{CString, c_int, c_uint, c_ulong};
use std::time::Duration;
use wry::WebViewBuilderExtUnix;
use x11::xlib;

thread_local! {
    static HOST: RefCell<Option<Host<Lin>>> = const { RefCell::new(None) };
}

/// Every event reaches the host on the GTK thread, after the current callback (no re-entrant borrow).
fn post(ev: Ev) {
    MainContext::default().invoke(move || deliver(ev));
}

fn deliver(ev: Ev) {
    HOST.with(|h| match h.try_borrow_mut() {
        Ok(mut h) => {
            if let Some(h) = h.as_mut() {
                h.on(ev);
            }
        }
        // a callback inside the host's own call: run it next
        Err(_) => {
            glib::idle_add_local_once(move || deliver(ev));
        }
    });
}

pub struct Lin {
    win: gtk::Window,
    gdk: X11Display,
    xd: *mut xlib::Display,
    root: xlib::Window,
    client_list: xlib::Atom,
    wm_pid: xlib::Atom,
    placed: Rect,
    ignoring: bool,
}

fn atom(xd: *mut xlib::Display, name: &str) -> xlib::Atom {
    let c = CString::new(name).unwrap_or_default();
    unsafe { xlib::XInternAtom(xd, c.as_ptr(), xlib::False) }
}

impl Lin {
    /// An Xlib call on a window that may be gone: errors are dropped, not fatal.
    fn trap<T>(&self, f: impl FnOnce() -> T) -> T {
        self.gdk.error_trap_push();
        let out = f();
        unsafe { xlib::XSync(self.xd, xlib::False) };
        self.gdk.error_trap_pop_ignored();
        out
    }

    /// A CARDINAL/WINDOW array property; the Xlib buffer is freed here.
    fn prop(&self, w: xlib::Window, name: xlib::Atom) -> Vec<c_ulong> {
        self.trap(|| unsafe {
            let (mut kind, mut format) = (0, 0);
            let (mut n, mut after) = (0, 0);
            let mut data: *mut u8 = std::ptr::null_mut();
            let ok = xlib::XGetWindowProperty(
                self.xd,
                w,
                name,
                0,
                4096,
                xlib::False,
                xlib::AnyPropertyType as c_ulong,
                &mut kind,
                &mut format,
                &mut n,
                &mut after,
                &mut data,
            );
            let mut out = Vec::new();
            if ok == 0 && !data.is_null() {
                // format 32 is an array of C longs, whatever the long's size
                if format == 32 {
                    out.extend_from_slice(std::slice::from_raw_parts(
                        data.cast::<c_ulong>(),
                        n as usize,
                    ));
                }
                xlib::XFree(data.cast());
            }
            out
        })
    }

    /// Top-level client windows: the window manager's list, else the root's children.
    fn clients(&self) -> Vec<xlib::Window> {
        let list = self.prop(self.root, self.client_list);
        if !list.is_empty() {
            return list;
        }
        self.children(self.root)
    }

    fn children(&self, w: xlib::Window) -> Vec<xlib::Window> {
        self.trap(|| unsafe {
            let (mut root, mut parent) = (0, 0);
            let mut kids: *mut xlib::Window = std::ptr::null_mut();
            let mut n: c_uint = 0;
            let mut out = Vec::new();
            if xlib::XQueryTree(self.xd, w, &mut root, &mut parent, &mut kids, &mut n) != 0
                && !kids.is_null()
            {
                out.extend_from_slice(std::slice::from_raw_parts(kids, n as usize));
                xlib::XFree(kids.cast());
            }
            out
        })
    }

    /// The window's ancestor that is a child of the root: the window manager's frame, or itself.
    fn frame_of(&self, w: xlib::Window) -> Option<xlib::Window> {
        let mut cur = w;
        for _ in 0..16 {
            let parent = self.trap(|| unsafe {
                let (mut root, mut parent) = (0, 0);
                let mut kids: *mut xlib::Window = std::ptr::null_mut();
                let mut n: c_uint = 0;
                let ok = xlib::XQueryTree(self.xd, cur, &mut root, &mut parent, &mut kids, &mut n);
                if !kids.is_null() {
                    xlib::XFree(kids.cast());
                }
                (ok != 0).then_some(parent)
            })?;
            if parent == self.root || parent == 0 {
                return Some(cur);
            }
            cur = parent;
        }
        None
    }

    /// Root-relative bounds and whether it is mapped and viewable.
    fn geometry(&self, w: xlib::Window) -> Option<(Rect, bool)> {
        self.trap(|| unsafe {
            let mut a: xlib::XWindowAttributes = std::mem::zeroed();
            if xlib::XGetWindowAttributes(self.xd, w, &mut a) == 0 {
                return None;
            }
            let (mut x, mut y, mut child): (c_int, c_int, xlib::Window) = (0, 0, 0);
            if xlib::XTranslateCoordinates(self.xd, w, self.root, 0, 0, &mut x, &mut y, &mut child)
                == 0
            {
                return None;
            }
            Some((
                Rect {
                    x: f64::from(x),
                    y: f64::from(y),
                    w: f64::from(a.width),
                    h: f64::from(a.height),
                },
                a.map_state == xlib::IsViewable,
            ))
        })
    }

    fn ours(&self) -> Option<xlib::Window> {
        self.win
            .window()
            .and_then(|w| w.downcast::<X11Window>().ok())
            .map(|w| w.xid())
    }

    /// GDK's integer scale: GTK sizes are X pixels divided by it.
    fn gscale(&self) -> f64 {
        f64::from(self.win.scale_factor().max(1))
    }
}

impl Os for Lin {
    type Id = xlib::Window;

    fn find(&self, pid: u32, want: Rect) -> Option<xlib::Window> {
        let s = self.gscale();
        let mine = self.ours();
        self.clients()
            .into_iter()
            .filter(|&w| Some(w) != mine)
            .filter(|&w| pid == 0 || self.prop(w, self.wm_pid).first() == Some(&c_ulong::from(pid)))
            .filter_map(|w| {
                let (b, _) = self.geometry(w)?;
                // CDP's bounds are DIPs
                let d = (b.x / s - want.x).abs()
                    + (b.y / s - want.y).abs()
                    + (b.w / s - want.w).abs()
                    + (b.h / s - want.h).abs();
                Some((w, d))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .filter(|(_, d)| *d < 40.0)
            .map(|(w, _)| w)
    }

    fn frame(&self, id: xlib::Window) -> Option<(Rect, bool)> {
        self.geometry(id)
    }

    fn scale(&self, _id: xlib::Window, _at: Rect) -> (f64, f64) {
        let s = self.gscale();
        (s, s)
    }

    fn place(&mut self, r: Rect) {
        if r != self.placed {
            self.placed = r;
            let s = self.gscale();
            self.win
                .move_((r.x / s).round() as i32, (r.y / s).round() as i32);
            self.win.resize(
                ((r.w / s).round() as i32).max(1),
                ((r.h / s).round() as i32).max(1),
            );
        }
    }

    /// Directly above Chrome's frame in the root's stacking order (bottom to top).
    fn order(&mut self, id: xlib::Window) {
        if !self.win.is_visible() {
            self.win.show_all();
        }
        let (Some(mine), Some(frame)) = (self.ours(), self.frame_of(id)) else {
            return;
        };
        let stack = self.children(self.root);
        let at = |w| stack.iter().position(|&x| x == w);
        if let (Some(a), Some(b)) = (at(mine), at(frame))
            && a == b + 1
        {
            return;
        }
        self.trap(|| unsafe {
            let mut c: xlib::XWindowChanges = std::mem::zeroed();
            c.sibling = frame;
            c.stack_mode = xlib::Above;
            xlib::XConfigureWindow(
                self.xd,
                mine,
                (xlib::CWSibling | xlib::CWStackMode) as c_uint,
                &mut c,
            );
        });
    }

    fn hide(&mut self) {
        if self.win.is_visible() {
            self.win.hide();
        }
    }

    fn visible(&self) -> bool {
        self.win.is_visible()
    }

    fn cursor(&self) -> (f64, f64, bool) {
        let (x, y, mask) = self.trap(|| unsafe {
            let (mut r, mut c) = (0, 0);
            let (mut rx, mut ry, mut wx, mut wy): (c_int, c_int, c_int, c_int) = (0, 0, 0, 0);
            let mut mask: c_uint = 0;
            xlib::XQueryPointer(
                self.xd, self.root, &mut r, &mut c, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask,
            );
            (rx, ry, mask)
        });
        let down = mask & (xlib::Button1Mask | xlib::Button2Mask | xlib::Button3Mask) != 0;
        let s = self.gscale();
        (
            (f64::from(x) - self.placed.x) / s,
            (f64::from(y) - self.placed.y) / s,
            down,
        )
    }

    fn ignoring(&self) -> bool {
        self.ignoring
    }

    /// An empty input shape passes every click to the window below.
    fn ignore(&mut self, on: bool) {
        self.ignoring = on;
        let empty = gtk::cairo::Region::create();
        self.win.input_shape_combine_region(on.then_some(&empty));
    }
}

fn fail(what: &str) -> ! {
    eprintln!("the overlay host failed: {what}");
    std::process::exit(1)
}

pub fn run() {
    if gtk::init().is_err() {
        fail("GTK found no X11 display");
    }
    let Some(display) = gdk::Display::default() else {
        fail("no display")
    };
    let Ok(gdk) = display.clone().downcast::<X11Display>() else {
        fail("the display is not X11 (Wayland cannot place a window over Chrome's)")
    };
    // without a compositor the clear panel would paint black over the page
    let screen = display.default_screen();
    let visual = screen.rgba_visual();
    if visual.is_none() || !screen.is_composited() {
        fail("the overlay needs a compositing window manager on X11");
    }
    let xd = unsafe { gdkx11::ffi::gdk_x11_display_get_xdisplay(gdk.as_ptr()) };
    let root = unsafe { xlib::XDefaultRootWindow(xd) };
    // override-redirect: never managed, never focused, never in a taskbar
    let win = gtk::Window::new(gtk::WindowType::Popup);
    win.set_visual(visual.as_ref());
    win.set_app_paintable(true);
    win.set_decorated(false);
    win.set_accept_focus(false);
    win.set_focus_on_map(false);
    win.set_skip_taskbar_hint(true);
    win.set_skip_pager_hint(true);
    win.set_default_size(10, 10);
    let pane = gtk::Box::new(gtk::Orientation::Vertical, 0);
    win.add(&pane);
    let web = builder(post)
        .build_gtk(&pane)
        .unwrap_or_else(|e| fail(&format!("webview: {e}")));
    // realized (an X window exists) but not shown until Chrome's window is found
    win.realize();
    let lin = Lin {
        client_list: atom(xd, "_NET_CLIENT_LIST"),
        wm_pid: atom(xd, "_NET_WM_PID"),
        win,
        gdk,
        xd,
        root,
        placed: Rect::default(),
        ignoring: false,
    };
    HOST.with(|h| {
        let mut host = Host::new(lin, web);
        host.os.ignore(true);
        *h.borrow_mut() = Some(host);
    });
    read_stdin(post, || {
        MainContext::default().invoke(|| std::process::exit(0))
    });
    glib::timeout_add_local(Duration::from_micros(16_667), || {
        HOST.with(|h| {
            if let Ok(mut h) = h.try_borrow_mut()
                && let Some(h) = h.as_mut()
            {
                h.on(Ev::Tick);
            }
        });
        if std::os::unix::process::parent_id() == 1 {
            // the session died without closing stdin
            std::process::exit(0);
        }
        ControlFlow::Continue
    });
    emit(&json!({"t": "ready"}));
    gtk::main();
}
