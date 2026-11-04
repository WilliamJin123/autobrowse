//! macOS: our own non-activating NSPanel (never key, never main), Accessory policy, CGWindowList
//! for Chrome's window. No tao: its launch calls activateIgnoringOtherApps, which blurs the page.
//! Memory: every AppKit/CF object is a Retained/CFRetained (released on drop); each event runs
//! in an autorelease pool.
use crate::core::{Ev, Host, Os, Rect, builder, emit, read_stdin};
use dispatch2::DispatchQueue;
use objc2::rc::{Retained, autoreleasepool};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSColor, NSEvent, NSPanel,
    NSScreen, NSWindowCollectionBehavior, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
    kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerName,
    kCGWindowOwnerPID,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
};
use serde_json::json;
use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

define_class!(
    // never key, never main: a click on it leaves Chrome's window key (no blur in the page)
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    #[name = "AutobrowseOverlayPanel"]
    struct Panel;

    impl Panel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            false
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }
    }
);

impl Panel {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0));
        let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
        let win: Retained<Self> = unsafe {
            msg_send![Self::alloc(mtm), initWithContentRect: rect, styleMask: style,
                backing: NSBackingStoreType::Buffered, defer: false]
        };
        unsafe { win.setReleasedWhenClosed(false) };
        win.setOpaque(false);
        win.setBackgroundColor(Some(&NSColor::clearColor()));
        win.setHasShadow(false);
        win.setHidesOnDeactivate(false);
        win.setFloatingPanel(false);
        win.setBecomesKeyOnlyIfNeeded(true);
        win.setIgnoresMouseEvents(true);
        win.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        win
    }
}

/// wry attaches to any AppKit view's window: it becomes the window's contentView owner.
struct ViewHandle(NonNull<std::ffi::c_void>);

impl HasWindowHandle for ViewHandle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(self.0));
        // the view outlives the handle: both live through `run`'s build call
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

pub struct Mac {
    win: Retained<Panel>,
    mtm: MainThreadMarker,
}

/// One CGWindowList row, read into plain values (the CF objects drop with the list).
struct Info {
    id: u32,
    layer: i64,
    pid: i64,
    bounds: Rect,
    onscreen: bool,
    chrome: bool,
}

fn windows(opt: CGWindowListOption, rel: u32, names: bool) -> Vec<Info> {
    let Some(list) = CGWindowListCopyWindowInfo(opt, rel) else {
        return Vec::new();
    };
    // documented: an array of CFDictionary<CFString, CFType>
    let list = unsafe {
        CFRetained::cast_unchecked::<objc2_core_foundation::CFArray<CFDictionary<CFString, CFType>>>(
            list,
        )
    };
    let num = |d: &CFDictionary<CFString, CFType>, k: &CFString| {
        d.get(k)
            .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64))
    };
    list.iter()
        .map(|d| {
            let mut r = objc2_core_foundation::CGRect::default();
            let bounds = unsafe { d.get(kCGWindowBounds) }
                .and_then(|v| v.downcast::<CFDictionary>().ok())
                .filter(|b| unsafe { CGRectMakeWithDictionaryRepresentation(Some(b), &mut r) })
                .map(|_| Rect {
                    x: r.origin.x,
                    y: r.origin.y,
                    w: r.size.width,
                    h: r.size.height,
                });
            Info {
                id: unsafe { num(&d, kCGWindowNumber) }.unwrap_or(0) as u32,
                layer: unsafe { num(&d, kCGWindowLayer) }.unwrap_or(-1),
                pid: unsafe { num(&d, kCGWindowOwnerPID) }.unwrap_or(0),
                bounds: bounds.unwrap_or_default(),
                onscreen: unsafe { d.get(kCGWindowIsOnscreen) }
                    .and_then(|v| v.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
                    .unwrap_or(false),
                chrome: names
                    && unsafe { d.get(kCGWindowOwnerName) }
                        .and_then(|v| {
                            v.downcast_ref::<CFString>()
                                .map(|s| s.to_string().contains("Chrom"))
                        })
                        .unwrap_or(false),
            }
        })
        .collect()
}

impl Mac {
    /// Height of the primary screen: CG (top-left) to AppKit (bottom-left).
    fn primary(&self) -> f64 {
        NSScreen::screens(self.mtm)
            .firstObject()
            .map(|s| s.frame().size.height)
            .unwrap_or(0.0)
    }
}

impl Os for Mac {
    type Id = u32;

    fn find(&self, pid: u32, want: Rect) -> Option<u32> {
        let opt = CGWindowListOption::OptionAll | CGWindowListOption::ExcludeDesktopElements;
        windows(opt, 0, pid == 0)
            .into_iter()
            .filter(|w| {
                w.layer == 0
                    && if pid != 0 {
                        w.pid == pid as i64
                    } else {
                        w.chrome
                    }
            })
            .map(|w| {
                let b = w.bounds;
                (
                    w.id,
                    (b.x - want.x).abs()
                        + (b.y - want.y).abs()
                        + (b.w - want.w).abs()
                        + (b.h - want.h).abs(),
                )
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .filter(|(_, d)| *d < 40.0)
            .map(|(id, _)| id)
    }

    fn frame(&self, id: u32) -> Option<(Rect, bool)> {
        windows(CGWindowListOption::OptionIncludingWindow, id, false)
            .first()
            .map(|w| (w.bounds, w.onscreen))
    }

    fn scale(&self, _id: u32, at: Rect) -> (f64, f64) {
        let ns = NSRect::new(
            NSPoint::new(at.x, self.primary() - at.y - at.h),
            NSSize::new(at.w, at.h),
        );
        let screens = NSScreen::screens(self.mtm);
        let hit = screens
            .iter()
            .find(|s| objc2_foundation::NSIntersectsRect(s.frame(), ns));
        let backing = hit
            .or_else(|| NSScreen::mainScreen(self.mtm))
            .map(|s| s.backingScaleFactor())
            .unwrap_or(2.0);
        (backing, 1.0)
    }

    fn place(&mut self, r: Rect) {
        let ns = NSRect::new(
            NSPoint::new(r.x, self.primary() - r.y - r.h),
            NSSize::new(r.w, r.h),
        );
        if self.win.frame() != ns {
            self.win.setFrame_display(ns, true);
        }
    }

    fn order(&mut self, id: u32) {
        let above = windows(CGWindowListOption::OptionOnScreenAboveWindow, id, false);
        let next = above.last().map(|w| w.id as isize);
        if next != Some(self.win.windowNumber()) || !self.win.isVisible() {
            self.win
                .orderWindow_relativeTo(NSWindowOrderingMode::Above, id as isize);
        }
    }

    fn hide(&mut self) {
        self.win.orderOut(None);
    }

    fn visible(&self) -> bool {
        self.win.isVisible()
    }

    fn cursor(&self) -> (f64, f64, bool) {
        let p = NSEvent::mouseLocation();
        let f = self.win.frame();
        let down = NSEvent::pressedMouseButtons() != 0;
        (p.x - f.origin.x, f.origin.y + f.size.height - p.y, down)
    }

    fn ignoring(&self) -> bool {
        self.win.ignoresMouseEvents()
    }

    fn ignore(&mut self, on: bool) {
        self.win.setIgnoresMouseEvents(on);
    }
}

thread_local! {
    static HOST: RefCell<Option<Host<Mac>>> = const { RefCell::new(None) };
}
static TICK: AtomicBool = AtomicBool::new(false);

/// Every event reaches the host on the main queue; none runs inside another (no re-entrant borrow).
fn post(ev: Ev) {
    DispatchQueue::main().exec_async(move || {
        if let Ev::Tick = ev {
            TICK.store(false, Ordering::Release);
        }
        autoreleasepool(|_| {
            HOST.with(|h| match h.try_borrow_mut() {
                Ok(mut h) => {
                    if let Some(h) = h.as_mut() {
                        h.on(ev)
                    }
                }
                // cannot happen (posts are async); keep the event rather than drop it
                Err(_) => post(ev),
            })
        })
    });
}

pub fn run() {
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let win = Panel::new(mtm);
    let web = {
        let view = win.contentView().expect("panel content view");
        let handle = ViewHandle(NonNull::from(&*view).cast());
        builder(post).build(&handle)
    };
    let web = match web {
        Ok(w) => w,
        Err(e) => {
            eprintln!("the overlay webview failed: {e}");
            std::process::exit(1)
        }
    };
    HOST.with(|h| *h.borrow_mut() = Some(Host::new(Mac { win, mtm }, web)));
    read_stdin(post, || {
        DispatchQueue::main().exec_async(|| std::process::exit(0))
    });
    crate::ticker(|| post(Ev::Tick), &TICK);
    emit(&json!({"t": "ready"}));
    app.run();
}
