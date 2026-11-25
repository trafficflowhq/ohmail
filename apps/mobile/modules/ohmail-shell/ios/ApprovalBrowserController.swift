import UIKit
import WebKit

/** A self-hosted sign-in gets one HTTPS origin, a fresh cookie jar, and no native bridge. */
final class ApprovalBrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIAdaptivePresentationControllerDelegate {
  private let start: URL
  private let launchCookie: HTTPCookie
  private var answer: ((String) -> Void)?
  private var web: WKWebView?

  init?(address: String, launchCookie: String, answer: @escaping (String) -> Void) {
    guard let start = URL(string: address), start.scheme == "https", start.host != nil,
          start.user == nil, start.password == nil,
          let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": launchCookie], for: start).first,
          cookie.isSecure, cookie.isHTTPOnly else { return nil }
    self.start = start
    self.launchCookie = cookie
    self.answer = answer
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = start.host
    if let port = start.port, port != 443 { title = "\(start.host ?? ""):\(port)" }
    navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(close))
    prepare()
  }

  private func admits(_ url: URL?) -> Bool {
    guard let url, url.scheme == "https", url.user == nil, url.password == nil else { return false }
    return url.host?.lowercased() == start.host?.lowercased() && (url.port ?? 443) == (start.port ?? 443)
  }

  private func prepare() {
    guard let host = start.host else { return finish("failed") }
    let port = start.port ?? 443
    let exactOrigin = "^https://" + NSRegularExpression.escapedPattern(for: host) +
      (port == 443 ? "(:443)?" : ":\(port)") + "/"
    let rules = [
      ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
      ["trigger": ["url-filter": exactOrigin], "action": ["type": "ignore-previous-rules"]],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: rules),
          let json = String(data: data, encoding: .utf8) else { return finish("failed") }

    // WebKit applies the restriction to loads and redirects. The navigation delegate also
    // rejects non-network destinations and windows, which cannot use the approved origin.
    let ruleStore: WKContentRuleListStore? = WKContentRuleListStore.default()
    guard let store = ruleStore else { return finish("failed") }
    let identifier = UUID().uuidString
    store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: json) { [weak self] list, _ in
      DispatchQueue.main.async {
        defer { store.removeContentRuleList(forIdentifier: identifier) { _ in } }
        guard let self, self.answer != nil else { return }
        guard let list else { return self.finish("failed") }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(list)
        let web = WKWebView(frame: .zero, configuration: config)
        self.web = web
        web.navigationDelegate = self
        web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        self.view.addSubview(web)
        NSLayoutConstraint.activate([
          web.leadingAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.leadingAnchor),
          web.trailingAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.trailingAnchor),
          web.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor),
          web.bottomAnchor.constraint(equalTo: self.view.bottomAnchor),
        ])
        config.websiteDataStore.httpCookieStore.setCookie(self.launchCookie) { [weak self, weak web] in
          guard let self, self.answer != nil else { return }
          web?.load(URLRequest(url: self.start))
        }
      }
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let admitted = admits(action.request.url) && action.targetFrame != nil
    decisionHandler(admitted ? .allow : .cancel)
    if !admitted && action.targetFrame?.isMainFrame != false { finish("wrong-server") }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let admitted = admits(response.response.url)
    decisionHandler(admitted ? .allow : .cancel)
    if !admitted && response.isForMainFrame { finish("wrong-server") }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { finish("failed") }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish("failed") }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish("cancelled") }

  @objc func close() { finish("cancelled") }

  private func finish(_ result: String) {
    guard let answer else { return }
    self.answer = nil
    web?.isHidden = true
    web?.stopLoading()
    if let sheet = navigationController, sheet.presentingViewController != nil {
      sheet.dismiss(animated: true) { answer(result) }
    } else {
      answer(result)
    }
  }
}
