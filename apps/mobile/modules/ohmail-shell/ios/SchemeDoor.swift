import Foundation
import WebKit

let shellScheme = "ohmail-shell"
let shellHost = "app"
let shellStart = URL(string: "\(shellScheme)://\(shellHost)/index.html")!

/**
 * THE ONLY THING THE SHELL'S WEB VIEW MAY LOAD (iOS). The files the build copied into the bundle's
 * `shell/` folder, listed by name in its `shell.manifest.json`, served under the shell's own scheme
 * (never the product's `ohmail` scheme). Anything else is an empty 403, counted. The page's policy
 * goes with every file as a header. Written, not compiled here: an iPhone has not said yet whether
 * this scheme gives the page a secure context and storage.
 */
final class SchemeDoor: NSObject, WKURLSchemeHandler {
  private lazy var manifest: [String: Any]? = {
    guard let url = Bundle.main.url(forResource: "shell.manifest", withExtension: "json", subdirectory: "shell"),
          let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj
  }()

  var csp: String? { (manifest?["csp"] as? String).flatMap { $0.isEmpty ? nil : $0 } }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let name = fileName(task.request.httpMethod ?? "GET", url),
          let policy = csp,
          let file = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "shell"),
          let data = try? Data(contentsOf: file) else { return refuse(task) }
    let headers = [
      "Content-Type": Self.mime(name),
      "Content-Security-Policy": "\(policy); frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    ]
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  private func fileName(_ method: String, _ url: URL) -> String? {
    guard method == "GET", url.scheme == shellScheme, url.host == shellHost, url.port == nil else { return nil }
    let name = String(url.path.dropFirst())
    let parts = name.split(separator: "/", omittingEmptySubsequences: false)
    guard !name.isEmpty, name.range(of: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$", options: .regularExpression) != nil,
          !parts.contains(where: { $0 == "." || $0 == ".." || $0.isEmpty }),
          let files = manifest?["files"] as? [String: Any], files[name] != nil else { return nil }
    return name
  }

  private func refuse(_ task: WKURLSchemeTask) {
    ShellRuntime.count("nonAssetRequests")
    let url = task.request.url ?? shellStart
    task.didReceive(HTTPURLResponse(url: url, statusCode: 403, httpVersion: "HTTP/1.1", headerFields: ["Cache-Control": "no-store"])!)
    task.didFinish()
  }

  private static func mime(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "html": return "text/html"
    case "js": return "text/javascript"
    case "css": return "text/css"
    case "json": return "application/json"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "webp": return "image/webp"
    case "woff2": return "font/woff2"
    case "txt": return "text/plain"
    default: return "application/octet-stream"
    }
  }
}
