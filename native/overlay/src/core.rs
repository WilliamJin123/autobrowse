//! The OS-free half: protocol, panel state, follow and pointer logic. Ported from host.swift.
//! in:  {t:"html",html} {t:"js",js} {t:"target",pid,x,y,w,h} {t:"view",outerW,outerH,innerW,innerH,dpr} {t:"hide"} {t:"show"}
//! out: {t:"ready"} {t:"found"} {t:"lost"} {t:"moved"} {t:"js",...} (the panel's postMessage, less `rect`)
use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use wry::{PageLoadEvent, WebView, WebViewBuilder};

/// Global screen, top-left origin, the OS's logical units.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Everything the host reacts to; posted to the UI thread by each OS's loop.
pub enum Ev {
    In(Map<String, Value>),
    Ipc(String),
    Loaded,
    Tick,
}

pub trait Os {
    type Id: Copy + PartialEq;
    /// The pid's top-level window nearest `want` (CDP's bounds), within 40 units.
    fn find(&self, pid: u32, want: Rect) -> Option<Self::Id>;
    /// Bounds and on-screen state; None once the window is gone.
    fn frame(&self, id: Self::Id) -> Option<(Rect, bool)>;
    /// (device pixels per CSS px at zoom 1, OS units per CSS px) for window `id` at `at`.
    fn scale(&self, id: Self::Id, at: Rect) -> (f64, f64);
    /// The page's viewport on screen when the OS shows it (a render child window); else insets from `view`.
    fn viewport(&self, _id: Self::Id) -> Option<Rect> {
        None
    }
    fn place(&mut self, r: Rect);
    /// Directly above `id`: other apps cover both, as they cover Chrome.
    fn order(&mut self, id: Self::Id);
    fn hide(&mut self);
    fn visible(&self) -> bool;
    /// Cursor in the panel's CSS px, and whether any button is down.
    fn cursor(&self) -> (f64, f64, bool);
    fn ignoring(&self) -> bool;
    fn ignore(&mut self, on: bool);
}

pub fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    // a closed pipe means the session is gone; stdin's EOF ends us
    let _ = writeln!(out, "{v}").and_then(|_| out.flush());
}

/// Panel's contract is `webkit.messageHandlers.host.postMessage(obj)`; wry's bridge takes a string.
/// WebKit's `ipc` handler is held first: wry's `window.ipc` reaches it through `window.webkit`, replaced here.
const BRIDGE: &str = "(()=>{const h=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.ipc;\
const send=h?s=>h.postMessage(s):window.ipc.postMessage;\
window.webkit={messageHandlers:{host:{postMessage:m=>send(JSON.stringify(m))}}}})()";

/// The webview, unfocused: building it never activates us or takes key.
pub fn builder<'a>(post: impl Fn(Ev) + Clone + 'static) -> WebViewBuilder<'a> {
    let ipc = post.clone();
    WebViewBuilder::new()
        .with_transparent(true)
        .with_focused(false)
        .with_accept_first_mouse(true)
        .with_initialization_script(BRIDGE)
        .with_ipc_handler(move |req| ipc(Ev::Ipc(req.into_body())))
        .with_on_page_load_handler(move |e, _| {
            if let PageLoadEvent::Finished = e {
                post(Ev::Loaded)
            }
        })
}

/// One JSON object per line; EOF (the session closed) ends the process.
pub fn read_stdin(post: impl Fn(Ev) + Send + 'static, eof: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
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
        eof();
        // the UI thread may be stuck (a full stdout pipe): go anyway
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
}

/// js waiting on a load; past this, the oldest goes (a stuck load must not grow without end)
const QUEUE_CAP: usize = 1024;

pub struct Host<O: Os> {
    pub os: O,
    web: WebView,
    loaded: bool,
    queued: VecDeque<String>,
    pid: u32,
    want: Option<Rect>,
    wid: Option<O::Id>,
    cg: Rect,
    onscreen: bool,
    shown: bool,
    /// outerW, outerH, innerW, innerH, dpr
    view: Option<[f64; 5]>,
    /// viewport insets in the Chrome window, OS units
    top: f64,
    right: f64,
    /// Chrome's own frame border (Linux, restored): left, right and bottom alike
    border: f64,
    /// the panel's rect, CSS px; the only part that takes the mouse
    hit: Rect,
    ticks: u64,
}

impl<O: Os> Host<O> {
    pub fn new(os: O, web: WebView) -> Self {
        Host {
            os,
            web,
            loaded: false,
            queued: VecDeque::new(),
            pid: 0,
            want: None,
            wid: None,
            cg: Rect::default(),
            onscreen: false,
            shown: true,
            view: None,
            top: 0.0,
            right: 0.0,
            border: 0.0,
            hit: Rect::default(),
            ticks: 0,
        }
    }

    pub fn on(&mut self, ev: Ev) {
        match ev {
            Ev::In(o) => self.handle(o),
            Ev::Ipc(s) => self.ipc(&s),
            Ev::Loaded => {
                self.loaded = true;
                for js in std::mem::take(&mut self.queued) {
                    let _ = self.web.evaluate_script(&js);
                }
            }
            Ev::Tick => self.tick(),
        }
    }

    fn handle(&mut self, o: Map<String, Value>) {
        let num = |k: &str| o.get(k).and_then(Value::as_f64);
        let text = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
        match o.get("t").and_then(Value::as_str) {
            Some("html") => {
                self.loaded = false;
                let _ = self.web.load_html(text("html"));
            }
            Some("js") => {
                if self.loaded {
                    let _ = self.web.evaluate_script(text("js"));
                } else {
                    if self.queued.len() >= QUEUE_CAP {
                        self.queued.pop_front();
                    }
                    self.queued.push_back(text("js").to_owned());
                }
            }
            Some("target") => {
                self.pid = num("pid").unwrap_or(0.0) as u32;
                let n = |k| num(k).unwrap_or(0.0);
                self.want = Some(Rect {
                    x: n("x"),
                    y: n("y"),
                    w: n("w"),
                    h: n("h"),
                });
                self.wid = None;
                self.follow();
            }
            Some("view") => {
                self.view = match (num("outerW"), num("outerH"), num("innerW"), num("innerH")) {
                    (Some(ow), Some(oh), Some(iw), Some(ih)) => {
                        Some([ow, oh, iw, ih, num("dpr").unwrap_or(f64::NAN)])
                    }
                    _ => None,
                };
                self.place();
            }
            Some("hide") => {
                self.shown = false;
                self.os.hide();
            }
            Some("show") => {
                self.shown = true;
                self.place();
            }
            _ => {}
        }
    }

    fn ipc(&mut self, body: &str) {
        let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(body) else {
            return;
        };
        if let Some(Value::Array(r)) = o.remove("rect")
            && let [x, y, w, h] = r.as_slice()
            && let (Some(x), Some(y), Some(w), Some(h)) =
                (x.as_f64(), y.as_f64(), w.as_f64(), h.as_f64())
        {
            self.hit = Rect { x, y, w, h };
        }
        o.insert("t".into(), "js".into());
        if o.len() > 1 {
            emit(&Value::Object(o));
        }
    }

    /// Track the Chrome window's frame, screen and order; 30 Hz.
    fn follow(&mut self) {
        let Some(want) = self.want else { return };
        let wid = match self.wid {
            Some(w) => w,
            None => match self.os.find(self.pid, want) {
                Some(w) => {
                    self.wid = Some(w);
                    emit(&json!({"t": "found"}));
                    w
                }
                None => {
                    self.os.hide();
                    return;
                }
            },
        };
        let Some((r, on)) = self.os.frame(wid) else {
            self.wid = None;
            self.os.hide();
            emit(&json!({"t": "lost"}));
            return;
        };
        let sized = r.w != self.cg.w || r.h != self.cg.h;
        if r != self.cg || on != self.onscreen {
            self.cg = r;
            self.onscreen = on;
            self.place();
            if sized {
                emit(&json!({"t": "moved"}));
            }
        }
        if self.onscreen && self.shown {
            self.os.order(wid);
        }
    }

    /// The viewport on screen: the window less its toolbar and any right-side pane.
    fn place(&mut self) {
        let Some(wid) = self
            .wid
            .filter(|_| self.onscreen && self.shown && self.cg.w > 0.0)
        else {
            self.os.hide();
            return;
        };
        if let Some(v) = self.os.viewport(wid) {
            self.os.place(v);
            self.os.order(wid);
            return;
        }
        let (backing, units) = self.os.scale(wid, self.cg);
        if let Some([ow, oh, iw, ih, dpr]) = self.view {
            let zoom = if dpr.is_nan() { 1.0 } else { dpr / backing };
            let side = (ow - iw * zoom).max(0.0);
            // a small gap is a frame on both sides; a wide one is a side pane (assumed frameless)
            let b = if side <= 16.0 { side / 2.0 } else { 0.0 };
            self.border = b * units;
            self.top = ((oh - ih * zoom - b) * units).max(0.0);
            self.right = ((side - b) * units).max(0.0);
        }
        let (c, b) = (self.cg, self.border);
        self.os.place(Rect {
            x: c.x + b,
            y: c.y + self.top,
            w: (c.w - b - self.right).max(1.0),
            h: (c.h - self.top - b).max(1.0),
        });
        self.os.order(wid);
    }

    /// Click-through except over the panel; a held button keeps the current state (a drag).
    fn pointer(&mut self) {
        if !self.os.visible() {
            return;
        }
        let (x, y, down) = self.os.cursor();
        if down && !self.os.ignoring() {
            return;
        }
        let h = self.hit;
        let inside =
            x >= h.x - 6.0 && x <= h.x + h.w + 6.0 && y >= h.y - 6.0 && y <= h.y + h.h + 6.0;
        if self.os.ignoring() == inside {
            self.os.ignore(!inside);
        }
    }

    fn tick(&mut self) {
        self.pointer();
        self.ticks += 1;
        if self.ticks.is_multiple_of(2) && self.want.is_some() {
            self.follow();
        }
    }
}
