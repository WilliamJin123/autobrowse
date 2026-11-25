//! macOS: our own non-activating NSPanel (key only while the note box asks, never main), Accessory policy, CGWindowList
//! for Chrome's window. No tao: its launch calls activateIgnoringOtherApps, which blurs the page.
//! Memory: every AppKit/CF object is a Retained/CFRetained (released on drop); each event runs
//! in an autorelease pool.
//! The menu bar item (Pause/Resume, Show/Hide overlay) and ⌃⌥P: pause with the panel hidden.
use crate::core::{Ev, Host, Os, Rect, builder, emit, read_stdin};
use dispatch2::DispatchQueue;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyObject, NSObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
    NSBackingStoreType, NSColor, NSEvent, NSEventModifierFlags, NSImage, NSMenu, NSMenuItem,
    NSPanel, NSRunningApplication, NSScreen, NSStatusBar, NSStatusItem, NSWindowCollectionBehavior,
    NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
    kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerName,
    kCGWindowOwnerPID,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
};
use serde_json::json;
use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

define_class!(
    // key only while KEYABLE (the note box): a click elsewhere leaves Chrome's window key (no blur in the page)
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    #[name = "AutobrowseOverlayPanel"]
    struct Panel;

    impl Panel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            KEYABLE.load(Ordering::Relaxed)
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

define_class!(
    // the menu items' target; both post as the panel's own buttons would
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AutobrowseTrayTarget"]
    struct TrayTarget;

    impl TrayTarget {
        #[unsafe(method(pause:))]
        fn pause(&self, _sender: Option<&AnyObject>) {
            tray_pause();
        }

        #[unsafe(method(overlay:))]
        fn overlay(&self, _sender: Option<&AnyObject>) {
            let on = !SHOWN.fetch_xor(true, Ordering::AcqRel);
            emit(&json!({"t": "overlay", "on": on}));
            repaint();
        }
    }
);

/// the session's last word: paused (or arming), and the panel shown
static HELD: AtomicBool = AtomicBool::new(false);
static SHOWN: AtomicBool = AtomicBool::new(true);

/// Flipped at once: a second press before the session answers flips it back (the panel does the same).
fn tray_pause() {
    let on = !HELD.fetch_xor(true, Ordering::AcqRel);
    emit(&json!({"t": "js", "pause": on}));
    repaint();
}

thread_local! {
    // apart from HOST: menu and hot key handlers run while HOST may be borrowed
    static TRAY: RefCell<Option<Tray>> = const { RefCell::new(None) };
}

/// labels follow the flip at once, not the session's answer
fn repaint() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    TRAY.with(|t| {
        if let Ok(t) = t.try_borrow()
            && let Some(t) = &*t
        {
            t.set(
                mtm,
                HELD.load(Ordering::Acquire),
                SHOWN.load(Ordering::Acquire),
            );
        }
    });
}

fn item(
    mtm: MainThreadMarker,
    title: &str,
    action: Option<Sel>,
    key: &str,
) -> Retained<NSMenuItem> {
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            action,
            &NSString::from_str(key),
        )
    }
}

/// SF Symbol as a template: the menu bar tints it for light, dark and the active state.
fn symbol(name: &str) -> Option<Retained<NSImage>> {
    let img = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        Some(&NSString::from_str("autobrowse")),
    )?;
    img.setTemplate(true);
    Some(img)
}

struct Tray {
    item: Retained<NSStatusItem>,
    pause: Retained<NSMenuItem>,
    show: Retained<NSMenuItem>,
    /// menu items hold their target weakly
    _target: Retained<TrayTarget>,
}

impl Tray {
    fn new(mtm: MainThreadMarker) -> Self {
        let target: Retained<TrayTarget> = unsafe { msg_send![TrayTarget::alloc(mtm), init] };
        // NSVariableStatusItemLength
        let it = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        let head = item(mtm, "autobrowse", None, "");
        head.setEnabled(false);
        // shown beside the item; the key itself is Carbon's (hotkey), so it works from any app
        let pause = item(mtm, "Pause the agent", Some(sel!(pause:)), "p");
        pause.setKeyEquivalentModifierMask(
            NSEventModifierFlags::Control | NSEventModifierFlags::Option,
        );
        let show = item(mtm, "Hide overlay", Some(sel!(overlay:)), "");
        unsafe {
            pause.setTarget(Some(&target));
            show.setTarget(Some(&target));
        }
        menu.addItem(&head);
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        menu.addItem(&pause);
        menu.addItem(&show);
        it.setMenu(Some(&menu));
        hotkey();
        Tray {
            item: it,
            pause,
            show,
            _target: target,
        }
    }

    fn set(&self, mtm: MainThreadMarker, held: bool, shown: bool) {
        if let Some(b) = self.item.button(mtm) {
            b.setImage(
                symbol(if held {
                    "play.circle.fill"
                } else {
                    "pause.circle"
                })
                .as_deref(),
            );
            b.setToolTip(Some(&NSString::from_str(if held {
                "autobrowse is paused (⌃⌥P resumes)"
            } else {
                "autobrowse (⌃⌥P pauses)"
            })));
        }
        self.pause.setTitle(&NSString::from_str(if held {
            "Resume the agent"
        } else {
            "Pause the agent"
        }));
        self.show.setTitle(&NSString::from_str(if shown {
            "Hide overlay"
        } else {
            "Show overlay"
        }));
    }
}

#[repr(C)]
struct EventTypeSpec {
    class: u32,
    kind: u32,
}

#[repr(C)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

type CarbonHandler = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn InstallEventHandler(
        target: *mut c_void,
        handler: CarbonHandler,
        n: u32,
        list: *const EventTypeSpec,
        user: *mut c_void,
        out: *mut *mut c_void,
    ) -> i32;
    fn RegisterEventHotKey(
        code: u32,
        mods: u32,
        id: EventHotKeyID,
        target: *mut c_void,
        options: u32,
        out: *mut *mut c_void,
    ) -> i32;
}

extern "C" fn on_hotkey(_: *mut c_void, _: *mut c_void, _: *mut c_void) -> i32 {
    tray_pause();
    0
}

/// ⌃⌥P from any app. Carbon's hot key, not an NSEvent global monitor: that one needs the Accessibility grant.
fn hotkey() {
    const KEYBOARD: u32 = u32::from_be_bytes(*b"keyb"); // kEventClassKeyboard
    const PRESSED: u32 = 5; // kEventHotKeyPressed
    const KEY_P: u32 = 35; // kVK_ANSI_P
    const MODS: u32 = 0x1000 | 0x0800; // controlKey | optionKey
    unsafe {
        let target = GetApplicationEventTarget();
        let spec = EventTypeSpec {
            class: KEYBOARD,
            kind: PRESSED,
        };
        let (mut h, mut k) = (std::ptr::null_mut(), std::ptr::null_mut());
        if InstallEventHandler(target, on_hotkey, 1, &spec, std::ptr::null_mut(), &mut h) != 0 {
            eprintln!("the overlay host has no ⌃⌥P: InstallEventHandler failed");
            return;
        }
        let id = EventHotKeyID {
            signature: u32::from_be_bytes(*b"abrw"),
            id: 1,
        };
        // a second session's host gets an error here: the first one's key stands
        if RegisterEventHotKey(KEY_P, MODS, id, target, 0, &mut k) != 0 {
            eprintln!("the overlay host has no ⌃⌥P: another session holds it");
        }
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
        let all: Vec<_> = windows(opt, 0, pid == 0)
            .into_iter()
            .filter(|w| {
                w.layer == 0
                    && if pid != 0 {
                        w.pid == pid as i64
                    } else {
                        w.chrome
                    }
            })
            .collect();
        let near = all
            .iter()
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
            .map(|(id, _)| id);
        // stale `want` (moved before the match): the pid's one big on-screen window; tab strips, 1x1s and offscreen ones skipped
        near.or_else(|| {
            let mut big = all
                .iter()
                .filter(|w| pid != 0 && w.onscreen && w.bounds.w >= 200.0 && w.bounds.h >= 200.0);
            match (big.next(), big.next()) {
                (Some(w), None) => Some(w.id),
                _ => None,
            }
        })
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

    fn float(&mut self) {
        // NSStatusWindowLevel: over every app's windows, under menus
        if self.win.level() != 25 {
            self.win.setLevel(25);
        }
        if !self.win.isVisible() {
            self.win.orderFrontRegardless();
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

    fn key(&mut self, on: bool, pid: u32) {
        KEYABLE.store(on, Ordering::Relaxed);
        if on {
            self.win.makeKeyWindow();
            return;
        }
        if !self.win.isKeyWindow() {
            return;
        }
        self.win.resignKeyWindow();
        // pid 0: a screen overlay, no app to hand key back to
        if pid == 0 {
            return;
        }
        // hand key back to Chrome's window; a no-op when Chrome is still the active app
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)
        {
            #[allow(deprecated)]
            app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    }

    fn tray(&mut self, held: bool, shown: bool) {
        HELD.store(held, Ordering::Release);
        SHOWN.store(shown, Ordering::Release);
        let mtm = self.mtm;
        TRAY.with(|t| {
            t.borrow_mut()
                .get_or_insert_with(|| Tray::new(mtm))
                .set(mtm, held, shown);
        });
    }
}

thread_local! {
    static HOST: RefCell<Option<Host<Mac>>> = const { RefCell::new(None) };
}
static TICK: AtomicBool = AtomicBool::new(false);
/// the note box has focus: the panel may take key
static KEYABLE: AtomicBool = AtomicBool::new(false);

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
