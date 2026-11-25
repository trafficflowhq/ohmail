import ExpoModulesCore
import UIKit
import WebKit

/**
 * THE PHONE'S SHELL (iOS): one WKWebView showing the shared views from the bundle, under the
 * shell's own scheme, sealed as Android's `ShellView.kt` is: a compiled content rule list blocks
 * every load that is not the shell's scheme (no view is made if it does not compile); only the
 * main frame of the shell's origin may post, answered as data through the reply handler; the main
 * frame stays on the start page and a pressed link is held under a token while the page asks; the
 * keeper's kinds are answered here. Each web view instance has an epoch. A view shows one scope's
 * page, or, asked to be the door's and given no scope, the second start page (`door.html`); asked to
 * be the door's and handed a scope, it shows neither and says so. Written, not compiled here: no
 * line of this has run on an iPhone.
 */
final class ShellView: ExpoView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
  let onMessage = EventDispatcher()
  let onEpoch = EventDispatcher()
  let onLinkAsk = EventDispatcher()
  let onMailto = EventDispatcher()
  let onRefused = EventDispatcher()

  private let door = SchemeDoor()
  private var web: WKWebView?
  private var epoch = ""
  private var scope: String?
  private var doorPage = false
  /** The start page the web view was made at: the one place its main frame may stand. */
  private var startPage = shellStart
  private var held: (token: String, epoch: String, url: URL, at: Date)?
  private var ends: [Date] = []
  private var pieces: [Int: String] = [:]

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    ShellRuntime.attach(self)
  }

  func setScope(_ next: String?) {
    guard next != scope else { return }
    scope = next
    asked()
  }

  /** Whether this view is the door's. A change is a new page. */
  func setDoor(_ next: Bool) {
    guard next != doorPage else { return }
    doorPage = next
    asked()
  }

  /**
   * The page this view shows, by what it was asked to be: the door's page with no scope, one scope's page with a
   * scope of the keeper's shape, and none otherwise. The door's with a scope is none: a page with no scope must
   * never stand over a live one's keeper.
   */
  private var page: URL? {
    if doorPage { return scope == nil ? shellDoor : nil }
    if let s = scope, Keeper.isScope(s) { return shellStart }
    return nil
  }

  private func asked() {
    destroyWeb()
    if doorPage, scope != nil { onRefused(["why": "door"]); return }
    if page != nil { build() }
  }

  /** A new web view at the start page, a new epoch: the page starts over from its keeper. */
  func rebuild() {
    destroyWeb()
    if page != nil { build() }
  }

  private func build() {
    guard let at = page else { return }
    // A build whose page carries no door has none to show.
    guard door.csp != nil, door.lists(String(at.path.dropFirst())) else { onRefused(["why": "noShell"]); return }
    let live = scope
    let rules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^\(shellScheme)://\(shellHost)/"},"action":{"type":"ignore-previous-rules"}}]
    """
    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "shell-seal", encodedContentRuleList: rules) { [weak self] list, error in
      DispatchQueue.main.async {
        guard let self = self else { return }
        guard let list = list, error == nil else { self.onRefused(["why": "rules"]); return }
        // A scope or a page that changed while the rules compiled builds its own.
        guard self.scope == live, self.page == at, self.web == nil else { return }
        self.make(list, at)
      }
    }
  }

  private func make(_ rules: WKContentRuleList, _ at: URL) {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(door, forURLScheme: shellScheme)
    config.userContentController.add(rules)
    // Before any script of the page's: no peer connection, which no rule list governs (a frame the page makes is not reached).
    config.userContentController.addUserScript(WKUserScript(
      source: "(function(){for(var n of ['RTCPeerConnection','webkitRTCPeerConnection']){"
        + "try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}}})();",
      injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "ohmailShell")
    config.websiteDataStore = .default()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.dataDetectorTypes = []
    config.allowsInlineMediaPlayback = false
    config.mediaTypesRequiringUserActionForPlayback = .all
    let w = WKWebView(frame: bounds, configuration: config)
    w.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    w.allowsLinkPreview = false
    w.navigationDelegate = self
    w.uiDelegate = self
    if #available(iOS 16.4, *) { w.isInspectable = ShellView.debuggable }
    epoch = ShellView.mint()
    pieces = [:]
    addSubview(w)
    web = w
    startPage = at
    onEpoch(["epoch": epoch])
    var parts = URLComponents(url: at, resolvingAgainstBaseURL: false)!
    parts.queryItems = [URLQueryItem(name: "epoch", value: epoch)]
    w.load(URLRequest(url: parts.url!))
  }

  func destroyWeb() {
    held = nil
    pieces = [:]
    epoch = ""
    web?.configuration.userContentController.removeAllScriptMessageHandlers()
    web?.removeFromSuperview()
    web = nil
  }

  // ── the bridge ──────────────────────────────────────────────────────────────────────────────────

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == shellScheme, origin.host == shellHost,
          let text = message.body as? String, let data = text.data(using: .utf8),
          let head = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          head["epoch"] as? String == epoch, !epoch.isEmpty else {
      ShellRuntime.count("bridgeDropped")
      replyHandler(nil, nil)
      return
    }
    replyHandler(nil, nil)
    route(text, head)
  }

  private func route(_ text: String, _ head: [String: Any]) {
    let id = head["id"] as? Int ?? -1
    switch head["kind"] as? String {
    case "piece":
      let chunk = head["chunk"] as? String ?? ""
      let sofar = pieces[id] ?? ""
      if sofar.utf16.count + chunk.utf16.count > 96 * 1024 * 1024 { pieces[id] = nil; return }
      pieces[id] = sofar + chunk
    case "joined":
      guard let whole = pieces.removeValue(forKey: id), let d = whole.data(using: .utf8),
            let inner = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
            inner["id"] as? Int == id, inner["epoch"] as? String == epoch else { ShellRuntime.count("bridgeDropped"); return }
      route(whole, inner)
    case "keep", "kept", "keepRows", "keptRows":
      keep(head, epoch)
    default:
      onMessage(["epoch": epoch, "origin": "\(shellScheme)://\(shellHost)", "mainFrame": true, "data": text])
    }
  }

  /** Data to the page of `at`, as an argument, never as source text. */
  func post(_ at: String, _ json: String) {
    DispatchQueue.main.async {
      guard !at.isEmpty, at == self.epoch, let w = self.web else { ShellRuntime.count("postDropped"); return }
      w.callAsyncJavaScript("window.__ohmailShell && window.__ohmailShell(m)", arguments: ["m": json], in: nil, in: .page, completionHandler: nil)
    }
  }

  private func answer(_ at: String, _ id: Int, _ body: [String: Any]) {
    var b = body
    b["id"] = id
    b["epoch"] = at
    if let d = try? JSONSerialization.data(withJSONObject: b), let s = String(data: d, encoding: .utf8) { post(at, s) }
  }

  private func keep(_ m: [String: Any], _ at: String) {
    let id = m["id"] as? Int ?? -1
    let kind = m["kind"] as? String
    let nested = kind == "keepRows" && doorPage && scope == nil ? m["ask"] as? [String: Any] : nil
    let ask = nested ?? m
    let legacy = kind == "keepRows" && ask["legacy"] as? Bool == true
    guard let live = (legacy && nested != nil) ? ask["scope"] as? String : scope else {
      return answer(at, id, ["ok": false, "refused": "notReady"])
    }
    let k = Keeper.shared
    switch kind {
    case "keep":
      guard let key = m["key"] as? String else { return answer(at, id, ["ok": false, "refused": "malformed"]) }
      let value = m["value"] as? String
      k.run({ k.keep(live, key, value) }) { ok in
        if !ok { ShellRuntime.count("keeperRefused") }
        self.answer(at, id, ["ok": true, "kept": ok])
      }
    case "kept":
      // The live scope's words, and its refusals alone.
      k.run({ k.kept(live).map { ($0, k.refused(live)) } }) { reading in
        guard let r = reading else { return self.answer(at, id, ["ok": false, "refused": "notKept"]) }
        let refused: [[Any]] = r.1.map { (name: (String, String?)) -> [Any] in [name.0, (name.1 as Any?) ?? NSNull()] }
        self.answer(at, id, ["ok": true, "words": r.0.map { [$0.0, $0.1] }, "refused": refused])
      }
    case "keepRows":
      guard ask["scope"] as? String == live else { return answer(at, id, ["ok": false, "refused": "foreignScope"]) }
      let puts = (ask["puts"] as? [[String: Any]] ?? []).compactMap { r -> Keeper.Row? in
        guard let t = r["type"] as? String, let i = r["id"] as? String, let j = r["json"] as? String else { return nil }
        return Keeper.Row(type: t, id: i, json: j)
      }
      let deletes = (ask["deletes"] as? [[String]] ?? []).compactMap { p in p.count == 2 ? (p[0], p[1]) : nil }
      k.run({ k.keepRows(live, puts, deletes, legacy: legacy) }) { ok in
        let response: [String: Any] = nested == nil ? ["ok": true, "kept": ok] : ["ok": true, "answer": ["kept": ok]]
        self.answer(at, id, response)
      }
    case "keptRows":
      guard m["scope"] as? String == live else { return answer(at, id, ["ok": false, "refused": "foreignScope"]) }
      k.run({ k.keptRows(live) }) { rows in
        guard let r = rows else { return self.answer(at, id, ["ok": false, "refused": "notKept"]) }
        self.answer(at, id, ["ok": true, "rows": r.map { ["type": $0.type, "id": $0.id, "json": $0.json] }])
      }
    default: break
    }
  }

  // ── navigation ──────────────────────────────────────────────────────────────────────────────────

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    let mainFrame = action.targetFrame?.isMainFrame ?? true
    if mainFrame, url.scheme == shellScheme, url.host == shellHost, url.path == startPage.path, action.navigationType == .other {
      return decisionHandler(.allow)
    }
    if !mainFrame, url.absoluteString == "about:srcdoc" { return decisionHandler(.allow) }
    let pressed = action.navigationType == .linkActivated || action.targetFrame == nil
    let scheme = url.scheme?.lowercased() ?? ""
    if pressed, scheme == "mailto" {
      onMailto(["epoch": epoch, "url": url.absoluteString])
    } else if pressed, ["https", "http", "tel"].contains(scheme), url.host != shellHost {
      let token = ShellView.mint()
      held = (token, epoch, url, Date())
      onLinkAsk(["epoch": epoch, "token": token, "url": url.absoluteString])
    } else {
      ShellRuntime.count("navigationCancelled")
    }
    decisionHandler(.cancel)
  }

  func openHeld(_ token: String) -> Bool {
    guard let h = held else { return false }
    held = nil
    guard h.token == token, h.epoch == epoch, Date().timeIntervalSince(h.at) <= 60 else { return false }
    UIApplication.shared.open(h.url)
    return true
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    ShellRuntime.count("windowRefused")
    return nil
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    let ended = epoch
    destroyWeb()
    ShellRuntime.count("rendererKilled")
    let now = Date()
    ends = ends.filter { now.timeIntervalSince($0) <= 60 } + [now]
    if ends.count > 3 { onRefused(["why": "ended", "epoch": ended]); return }
    if page != nil { build() }
  }

  private static var debuggable: Bool {
    #if DEBUG
    return true
    #else
    return false
    #endif
  }

  private static func mint() -> String {
    var b = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
    return b.map { String(format: "%02x", $0) }.joined()
  }
}
