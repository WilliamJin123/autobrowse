// The headed overlay's window (designs/2026-11-04-overlay-out-of-page.md): a transparent
// panel glued over one Chrome window's viewport, out of the page. JSON lines on stdin/stdout.
// in:  {t:"html",html} {t:"js",js} {t:"target",pid,x,y,w,h} {t:"view",outerW,outerH,innerW,innerH,dpr} {t:"hide"} {t:"show"}
// out: {t:"ready"} {t:"found"} {t:"lost"} {t:"moved"} {t:"js",...} (from the panel's postMessage)
import AppKit
import WebKit

func emit(_ o: [String: Any]) {
  guard var d = try? JSONSerialization.data(withJSONObject: o) else { return }
  d.append(0x0a)
  FileHandle.standardOutput.write(d)
}

// never key, never main: a click on it leaves Chrome's window key (no blur in the page)
final class Panel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class Web: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Host: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let win: Panel
  let web: Web
  var loaded = false
  var queued: [String] = []
  var pid: pid_t = 0
  var want: CGRect? = nil
  var wid: CGWindowID = 0
  var cg = CGRect.zero
  var onscreen = false
  var shown = true
  /** viewport insets in the Chrome window, points */
  var top: CGFloat = 0
  var right: CGFloat = 0
  var view: [String: Double]? = nil
  /** the panel's rect in the window, top-left origin; the only part that takes the mouse */
  var hit = CGRect.zero
  var ticks = 0

  override init() {
    win = Panel(
      contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let conf = WKWebViewConfiguration()
    web = Web(frame: .zero, configuration: conf)
    super.init()
    conf.userContentController.add(self, name: "host")
    win.isOpaque = false
    win.backgroundColor = .clear
    win.hasShadow = false
    win.level = .normal
    win.hidesOnDeactivate = false
    win.isFloatingPanel = false
    win.becomesKeyOnlyIfNeeded = true
    win.ignoresMouseEvents = true
    win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self
    win.contentView = web
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any] else { return }
    if let r = body["rect"] as? [Double], r.count == 4 {
      hit = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    }
    var out = body
    out["t"] = "js"
    out.removeValue(forKey: "rect")
    if out.count > 1 { emit(out) }
  }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    loaded = true
    for js in queued { web.evaluateJavaScript(js) }
    queued = []
  }

  func handle(_ o: [String: Any]) {
    switch o["t"] as? String {
    case "html":
      loaded = false
      web.loadHTMLString(o["html"] as? String ?? "", baseURL: nil)
    case "js":
      let js = o["js"] as? String ?? ""
      if loaded { web.evaluateJavaScript(js) } else { queued.append(js) }
    case "target":
      pid = pid_t((o["pid"] as? Int) ?? 0)
      want = CGRect(
        x: o["x"] as? Double ?? 0, y: o["y"] as? Double ?? 0,
        width: o["w"] as? Double ?? 0, height: o["h"] as? Double ?? 0)
      wid = 0
      follow()
    case "view":
      view = o.compactMapValues { ($0 as? NSNumber)?.doubleValue }
      place()
    case "hide":
      shown = false
      win.orderOut(nil)
    case "show":
      shown = true
      place()
    default: break
    }
  }

  /** The Chrome window: the pid's layer-0 window nearest the bounds CDP gave. */
  func match() -> CGWindowID {
    guard let want = want,
      let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]
    else { return 0 }
    var best: (CGWindowID, CGFloat) = (0, .infinity)
    for w in list {
      guard (w[kCGWindowLayer as String] as? Int) == 0,
        let n = w[kCGWindowNumber as String] as? CGWindowID,
        let b = w[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: b)
      else { continue }
      let owner = (w[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) } ?? 0
      if pid != 0 && owner != pid { continue }
      if pid == 0 && !((w[kCGWindowOwnerName as String] as? String ?? "").contains("Chrom")) { continue }
      let d = abs(r.minX - want.minX) + abs(r.minY - want.minY) + abs(r.width - want.width) + abs(r.height - want.height)
      if d < best.1 { best = (n, d) }
    }
    return best.1 < 40 ? best.0 : 0
  }

  /** Track the Chrome window's frame, screen and order; 30 Hz. */
  func follow() {
    if wid == 0 {
      wid = match()
      if wid == 0 { win.orderOut(nil); return }
      emit(["t": "found"])
    }
    guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]])?.first,
      let b = info[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: b)
    else {
      wid = 0
      win.orderOut(nil)
      emit(["t": "lost"])
      return
    }
    let on = (info[kCGWindowIsOnscreen as String] as? Bool) ?? false
    let sized = r.size != cg.size
    if r != cg || on != onscreen {
      cg = r
      onscreen = on
      place()
      if sized { emit(["t": "moved"]) }
    }
    if onscreen && shown { order() }
  }

  /** Directly above the Chrome window: other apps cover both, as they cover Chrome. */
  func order() {
    let above = (CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], wid) as? [[String: Any]]) ?? []
    let next = above.last.flatMap { $0[kCGWindowNumber as String] as? Int }
    if next != win.windowNumber || !win.isVisible { win.order(.above, relativeTo: Int(wid)) }
  }

  /** The viewport on screen: the window less its toolbar and any right-side pane. */
  func place() {
    guard wid != 0, onscreen, shown, cg.width > 0 else { win.orderOut(nil); return }
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let ns = NSRect(x: cg.minX, y: primary - cg.maxY, width: cg.width, height: cg.height)
    let screen = NSScreen.screens.first { $0.frame.intersects(ns) } ?? NSScreen.main
    let backing = Double(screen?.backingScaleFactor ?? 2)
    if let v = view, let oh = v["outerH"], let ih = v["innerH"], let ow = v["outerW"], let iw = v["innerW"] {
      let zoom = (v["dpr"] ?? backing) / backing
      top = max(0, CGFloat(oh - ih * zoom))
      right = max(0, CGFloat(ow - iw * zoom))
    }
    let frame = NSRect(x: ns.minX, y: ns.minY, width: max(1, ns.width - right), height: max(1, ns.height - top))
    if win.frame != frame { win.setFrame(frame, display: true) }
    order()
  }

  /** Click-through except over the panel; a held button keeps the current state (a drag). */
  func pointer() {
    guard win.isVisible else { return }
    if NSEvent.pressedMouseButtons != 0 && !win.ignoresMouseEvents { return }
    let p = NSEvent.mouseLocation
    let f = win.frame
    let local = CGPoint(x: p.x - f.minX, y: f.maxY - p.y)
    let inside = hit.insetBy(dx: -6, dy: -6).contains(local)
    if win.ignoresMouseEvents == inside { win.ignoresMouseEvents = !inside }
  }

  func tick() {
    if getppid() == 1 { exit(0) }
    pointer()
    ticks += 1
    if ticks % 2 == 0 && want != nil { follow() }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = Host()

var buf = Data()
FileHandle.standardInput.readabilityHandler = { h in
  let d = h.availableData
  if d.isEmpty { exit(0) }
  buf.append(d)
  while let i = buf.firstIndex(of: 0x0a) {
    let line = buf.subdata(in: buf.startIndex..<i)
    buf.removeSubrange(buf.startIndex...i)
    guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
    DispatchQueue.main.async { host.handle(o) }
  }
}

let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in host.tick() }
RunLoop.main.add(timer, forMode: .common)
emit(["t": "ready"])
app.run()
