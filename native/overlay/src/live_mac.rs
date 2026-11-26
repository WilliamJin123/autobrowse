//! The live view's window (designs/2026-11-25-live-view.md): `overlay-host live`. A normal Mac window
//! that never activates itself; the page (the session's viewer) does all drawing and talks to the
//! session over its own socket. Here only what a page cannot: the window, Dock bounce, a toast that
//! floats over every app, the clipboard.
//! in:  {t:"open",url,frame?:[x,y,w,h]} {t:"place",frame} {t:"front"} {t:"js",js} {t:"clip",text}
//!      {t:"attention",html} (toast + Dock bounce) {t:"calm"} {t:"pick",id,multiple} (Mac open panel)
//!      {t:"hit",x,y}: the view a click at x,y (window points, top-left) lands on (tests)
//! ipc (viewer): {t:"clip-read"} {t:"clip-write",text} {t:"title",text} {t:"drag"} {t:"zoom"} {t:"hide"}; else out as {t:"js",...}
//! ipc (toast):  {t:"open"} {t:"later"}
//! out: {t:"ready"} {t:"shown"} {t:"closed"} {t:"opened"} {t:"later"} {t:"visible",on} {t:"picked",id,paths}
//!      {t:"hit",view} {t:"js",...}
use crate::core::emit;
use dispatch2::DispatchQueue;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2::{MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
    NSBackingStoreType, NSColor, NSEventModifierFlags, NSMenu, NSMenuItem, NSPanel, NSPasteboard, NSPasteboardTypeString,
    NSRequestUserAttentionType, NSRunningApplication, NSScreen, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize, NSString};
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::io::BufRead;
use std::ptr::NonNull;
use wry::{WebView, WebViewBuilder};

enum Ev {
    In(Map<String, Value>),
    Viewer(String),
    Toast(String),
}

struct ViewHandle(NonNull<std::ffi::c_void>);

impl HasWindowHandle for ViewHandle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(self.0));
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

define_class!(
    // never key: a click on the toast must not take the person's keyboard
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    #[name = "AutobrowseLiveToast"]
    struct Toast;

    impl Toast {
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

define_class!(
    // window and app delegate: close hides (the session lives on), a Dock click shows it again
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AutobrowseLiveDelegate"]
    struct Delegate;

    impl Delegate {
        #[unsafe(method(windowShouldClose:))]
        fn should_close(&self, _sender: &AnyObject) -> bool {
            with(|l| l.win.orderOut(None));
            emit(&json!({"t": "closed"}));
            false
        }

        #[unsafe(method(windowDidChangeOcclusionState:))]
        fn occlusion(&self, _note: &AnyObject) {
            with(|l| {
                // NSWindowOcclusionStateVisible = 1 << 1
                let on = l.win.occlusionState().0 & 2 != 0;
                if on != l.visible {
                    l.visible = on;
                    emit(&json!({"t": "visible", "on": on}));
                }
            });
        }

        #[unsafe(method(applicationShouldTerminate:))]
        fn should_terminate(&self, _app: &AnyObject) -> usize {
            // Quit (Dock, ⌘Q) hides: the session owns the process, stdin's end quits it
            with(|l| l.win.orderOut(None));
            emit(&json!({"t": "closed"}));
            // NSTerminateCancel
            0
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn reopen(&self, _app: &AnyObject, _visible: bool) -> bool {
            // the person clicked the Dock icon: they asked for it
            with(|l| l.front());
            true
        }
    }
);

struct Live {
    mtm: MainThreadMarker,
    win: Retained<NSWindow>,
    web: WebView,
    toast: Retained<Toast>,
    toast_web: WebView,
    shown: bool,
    visible: bool,
    attention: isize,
    _delegate: Retained<Delegate>,
}

thread_local! {
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
}

fn with(f: impl FnOnce(&mut Live)) {
    LIVE.with(|l| {
        if let Ok(mut l) = l.try_borrow_mut()
            && let Some(l) = l.as_mut()
        {
            f(l)
        }
    })
}

fn post(ev: Ev) {
    DispatchQueue::main().exec_async(move || autoreleasepool(|_| with(|l| l.on(ev))));
}

fn primary_h(mtm: MainThreadMarker) -> f64 {
    NSScreen::screens(mtm)
        .firstObject()
        .map(|s| s.frame().size.height)
        .unwrap_or(900.0)
}

/// [x,y,w,h], top-left origin (as CDP and the presets give it) → AppKit's bottom-left.
fn ns_rect(mtm: MainThreadMarker, f: &[f64]) -> NSRect {
    NSRect::new(
        NSPoint::new(f[0], primary_h(mtm) - f[1] - f[3]),
        NSSize::new(f[2], f[3]),
    )
}

fn frame_of(v: Option<&Value>) -> Option<Vec<f64>> {
    let a: Vec<f64> = v?.as_array()?.iter().filter_map(Value::as_f64).collect();
    (a.len() == 4 && a[2] >= 200.0 && a[3] >= 150.0).then_some(a)
}

fn pasteboard_read() -> String {
    let pb = NSPasteboard::generalPasteboard();
    unsafe { pb.stringForType(NSPasteboardTypeString) }
        .map(|s| s.to_string())
        .unwrap_or_default()
}

fn pasteboard_write(text: &str) {
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    unsafe { pb.setString_forType(&NSString::from_str(text), NSPasteboardTypeString) };
}

impl Live {
    /// Only on the person's ask (toast Open, Dock click, `front`): never on a page event.
    fn front(&mut self) {
        NSRunningApplication::currentApplication()
            .activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
        self.win.makeKeyAndOrderFront(None);
        self.calm();
        self.shown = true;
    }

    fn calm(&mut self) {
        if self.attention != 0 {
            NSApplication::sharedApplication(self.mtm).cancelUserAttentionRequest(self.attention);
            self.attention = 0;
        }
        self.toast.orderOut(None);
    }

    fn on(&mut self, ev: Ev) {
        match ev {
            Ev::In(o) => self.input(o),
            Ev::Viewer(s) => self.viewer(s),
            Ev::Toast(s) => {
                let o: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
                match o.get("t").and_then(Value::as_str) {
                    Some("open") => {
                        self.front();
                        emit(&json!({"t": "opened"}));
                    }
                    Some("later") => {
                        // the bounce goes too: Later means not now
                        self.calm();
                        emit(&json!({"t": "later"}));
                    }
                    _ => {}
                }
            }
        }
    }

    fn input(&mut self, o: Map<String, Value>) {
        let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
        match s("t") {
            "open" => {
                if let Some(f) = frame_of(o.get("frame")) {
                    self.win.setFrame_display(ns_rect(self.mtm, &f), true);
                }
                let _ = self.web.load_url(s("url"));
                if !self.shown {
                    // behind every window: it opens in the background, the Dock icon brings it
                    self.win.orderBack(None);
                    self.shown = true;
                    emit(&json!({"t": "shown"}));
                    // the first state: occlusion notes only report changes
                    self.visible = self.win.occlusionState().0 & 2 != 0;
                    emit(&json!({"t": "visible", "on": self.visible}));
                }
            }
            "place" => {
                if let Some(f) = frame_of(o.get("frame")) {
                    self.win.setFrame_display(ns_rect(self.mtm, &f), true);
                }
            }
            "front" => self.front(),
            "js" => {
                let _ = self.web.evaluate_script(s("js"));
            }
            "clip" => pasteboard_write(s("text")),
            "attention" => {
                let _ = self.toast_web.load_html(s("html"));
                self.place_toast();
                self.toast.orderFrontRegardless();
                let app = NSApplication::sharedApplication(self.mtm);
                // a no-op while we are the active app: the person is already here
                if self.attention == 0 && !app.isActive() {
                    self.attention =
                        app.requestUserAttention(NSRequestUserAttentionType::CriticalRequest);
                }
            }
            "calm" => self.calm(),
            "pick" => {
                let paths = pick(o.get("multiple").and_then(Value::as_bool).unwrap_or(false));
                emit(&json!({"t": "picked", "id": o.get("id"), "paths": paths}));
            }
            "hit" => {
                let x = o.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                let y = o.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                let h = self.win.frame().size.height;
                let view = self
                    .win
                    .contentView()
                    .and_then(|v| unsafe { v.superview() })
                    .and_then(|top| top.hitTest(NSPoint::new(x, h - y)))
                    .map(|v| v.class().name().to_string_lossy().into_owned());
                emit(&json!({"t": "hit", "view": view}));
            }
            _ => {}
        }
    }

    fn viewer(&mut self, s: String) {
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&s) else {
            return;
        };
        match o.get("t").and_then(Value::as_str).unwrap_or("") {
            "clip-read" => {
                let text = serde_json::to_string(&pasteboard_read()).unwrap_or_default();
                let _ = self
                    .web
                    .evaluate_script(&format!("window.live&&live.clip({text})"));
            }
            "clip-write" => pasteboard_write(o.get("text").and_then(Value::as_str).unwrap_or("")),
            "title" => self.win.setTitle(&NSString::from_str(
                o.get("text").and_then(Value::as_str).unwrap_or("autobrowse"),
            )),
            "drag" => {
                let app = NSApplication::sharedApplication(self.mtm);
                if let Some(e) = app.currentEvent() {
                    self.win.performWindowDragWithEvent(&e);
                }
            }
            "zoom" => self.win.zoom(None),
            "hide" => {
                self.win.orderOut(None);
                emit(&json!({"t": "closed"}));
            }
            _ => {
                let mut o = o;
                o.insert("t".into(), json!("js"));
                emit(&Value::Object(o));
            }
        }
    }

    /// Top right of the screen the viewer is on, under the menu bar.
    fn place_toast(&self) {
        let screen = self
            .win
            .screen()
            .or_else(|| NSScreen::mainScreen(self.mtm));
        let Some(screen) = screen else { return };
        let v = screen.visibleFrame();
        let (w, h) = (380.0, 96.0);
        let r = NSRect::new(
            NSPoint::new(
                v.origin.x + v.size.width - w - 12.0,
                v.origin.y + v.size.height - h - 12.0,
            ),
            NSSize::new(w, h),
        );
        self.toast.setFrame_display(r, true);
    }
}

/// The Mac open panel; the person clicked a file input, so the app is theirs already.
fn pick(multiple: bool) -> Vec<String> {
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class!(NSOpenPanel), openPanel];
        let _: () = msg_send![&panel, setCanChooseFiles: true];
        let _: () = msg_send![&panel, setCanChooseDirectories: false];
        let _: () = msg_send![&panel, setAllowsMultipleSelection: multiple];
        // NSModalResponseOK
        let r: isize = msg_send![&panel, runModal];
        if r != 1 {
            return Vec::new();
        }
        let urls: Retained<AnyObject> = msg_send![&panel, URLs];
        let n: usize = msg_send![&urls, count];
        (0..n)
            .filter_map(|i| {
                let u: Retained<AnyObject> = msg_send![&urls, objectAtIndex: i];
                let p: Option<Retained<NSString>> = msg_send![&u, path];
                p.map(|p| p.to_string())
            })
            .collect()
    }
}

fn menu_item(
    mtm: MainThreadMarker,
    title: &str,
    action: objc2::runtime::Sel,
    key: &str,
    shift: bool,
) -> Retained<NSMenuItem> {
    let it = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            Some(action),
            &NSString::from_str(key),
        )
    };
    if shift {
        it.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);
    }
    it
}

/// App and Edit menus: without Edit, ⌘C/⌘V/⌘X/⌘A never reach the page's copy and paste events.
fn menus(mtm: MainThreadMarker, app: &NSApplication) {
    let bar = NSMenu::new(mtm);
    let sub = |title: &str, items: Vec<Retained<NSMenuItem>>| {
        let m = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
        for i in items {
            m.addItem(&i);
        }
        let holder = NSMenuItem::new(mtm);
        holder.setSubmenu(Some(&m));
        bar.addItem(&holder);
    };
    sub(
        "Autobrowse Live",
        vec![menu_item(mtm, "Hide Autobrowse Live", sel!(hide:), "h", false)],
    );
    sub(
        "Edit",
        vec![
            menu_item(mtm, "Undo", sel!(undo:), "z", false),
            menu_item(mtm, "Redo", sel!(redo:), "z", true),
            NSMenuItem::separatorItem(mtm),
            menu_item(mtm, "Cut", sel!(cut:), "x", false),
            menu_item(mtm, "Copy", sel!(copy:), "c", false),
            menu_item(mtm, "Paste", sel!(paste:), "v", false),
            menu_item(mtm, "Select All", sel!(selectAll:), "a", false),
        ],
    );
    app.setMainMenu(Some(&bar));
}

fn read_stdin() {
    std::thread::spawn(|| {
        let mut stdin = std::io::stdin().lock();
        let mut line = Vec::with_capacity(4096);
        loop {
            line.clear();
            match stdin.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(Value::Object(o)) = serde_json::from_slice(&line) {
                        post(Ev::In(o));
                    }
                }
            }
        }
        // the session is gone
        std::process::exit(0);
    });
}

fn webview(
    view: &objc2_app_kit::NSView,
    transparent: bool,
    ipc: fn(String) -> Ev,
) -> wry::Result<WebView> {
    let handle = ViewHandle(NonNull::from(view).cast());
    WebViewBuilder::new()
        .with_transparent(transparent)
        .with_focused(false)
        .with_accept_first_mouse(true)
        .with_ipc_handler(move |req| post(ipc(req.into_body())))
        .build(&handle)
}

pub fn run() {
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    // Regular: a Dock icon (to bounce, to click); nothing here calls activate on launch
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    menus(mtm, &app);

    let screen = NSScreen::mainScreen(mtm).map(|s| s.visibleFrame());
    let rect = screen.unwrap_or(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(1280.0, 860.0),
    ));
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let win: Retained<NSWindow> = unsafe {
        msg_send![NSWindow::alloc(mtm), initWithContentRect: rect, styleMask: style,
            backing: NSBackingStoreType::Buffered, defer: false]
    };
    unsafe { win.setReleasedWhenClosed(false) };
    win.setTitle(&NSString::from_str("autobrowse"));
    win.setTitlebarAppearsTransparent(true);
    win.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    win.setMinSize(NSSize::new(480.0, 360.0));
    win.setFrame_display(rect, false);

    let toast: Retained<Toast> = unsafe {
        msg_send![Toast::alloc(mtm),
            initWithContentRect: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(380.0, 96.0)),
            styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered, defer: false]
    };
    unsafe { toast.setReleasedWhenClosed(false) };
    toast.setOpaque(false);
    toast.setBackgroundColor(Some(&NSColor::clearColor()));
    toast.setHasShadow(true);
    toast.setHidesOnDeactivate(false);
    toast.setFloatingPanel(true);
    // NSStatusWindowLevel: over every app's windows, under menus
    toast.setLevel(25);
    toast.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );

    let web = webview(&win.contentView().expect("content view"), false, Ev::Viewer);
    let toast_web = webview(&toast.contentView().expect("toast view"), true, Ev::Toast);
    let (web, toast_web) = match (web, toast_web) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("the live view webview failed: {e}");
            std::process::exit(1)
        }
    };

    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(mtm), init] };
    unsafe {
        let _: () = msg_send![&win, setDelegate: &*delegate];
        let _: () = msg_send![&app, setDelegate: &*delegate];
    }
    LIVE.with(|l| {
        *l.borrow_mut() = Some(Live {
            mtm,
            win,
            web,
            toast,
            toast_web,
            shown: false,
            visible: false,
            attention: 0,
            _delegate: delegate,
        })
    });
    read_stdin();
    emit(&json!({"t": "ready"}));
    app.run();
}
