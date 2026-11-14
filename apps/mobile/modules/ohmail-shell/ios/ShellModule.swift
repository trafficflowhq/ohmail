import ExpoModulesCore
import WebKit

/** The shell's counts: numbers by name, what the diagnostics may carry; and the views alive now. */
enum ShellRuntime {
  private static var counts: [String: Int] = [:]
  private static let lock = NSLock()
  private static let views = NSHashTable<ShellView>.weakObjects()
  static func count(_ name: String) { lock.lock(); counts[name, default: 0] += 1; lock.unlock() }
  static func snapshot() -> [String: Int] { lock.lock(); defer { lock.unlock() }; return counts }
  static func attach(_ view: ShellView) { lock.lock(); views.add(view); lock.unlock() }
  static func live() -> [ShellView] { lock.lock(); defer { lock.unlock() }; return views.allObjects }
}

/** The shell's module (iOS). Written, not compiled here. */
public final class ShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OhmailShell")

    // iOS has one web view, the system's; it always names a message's frame and origin.
    Function("webViewCheck") { ["installed": true, "major": nil, "listener": true, "sealed": true] as [String: Any?] }

    Function("stats") { ShellRuntime.snapshot() }

    /* Where a scope's keeper and the web view's data live: what the backup claim measures (Library/WebKit). */
    Function("storagePaths") { (scope: String) -> [String: String] in
      let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      return ["keeper": Keeper.shared.pathOf(scope), "webData": library.appendingPathComponent("WebKit").path]
    }

    AsyncFunction("keeperScopes") { (promise: Promise) in Keeper.shared.run({ Keeper.shared.scopes() }) { promise.resolve($0) } }

    AsyncFunction("keeperForget") { (scope: String, promise: Promise) in
      Keeper.shared.run({ Keeper.shared.forget(scope) }) { promise.resolve($0) }
    }

    AsyncFunction("keeperKeep") { (scope: String, key: String, value: String?, promise: Promise) in
      Keeper.shared.run({ Keeper.shared.keep(scope, key, value) }) { promise.resolve($0) }
    }

    AsyncFunction("keeperKeptWords") { (scope: String, promise: Promise) in
      Keeper.shared.run({ Keeper.shared.kept(scope)?.map { [$0.0, $0.1] } }) { promise.resolve($0) }
    }

    AsyncFunction("keeperKeepRows") { (scope: String, rows: [[String: String]], promise: Promise) in
      let puts = rows.map { Keeper.Row(type: $0["type"] ?? "", id: $0["id"] ?? "", json: $0["json"] ?? "") }
      Keeper.shared.run({ Keeper.shared.keepRows(scope, puts, []) }) { promise.resolve($0) }
    }

    AsyncFunction("keeperKeptRows") { (scope: String, promise: Promise) in
      Keeper.shared.run({ Keeper.shared.keptRows(scope)?.map { ["type": $0.type, "id": $0.id, "json": $0.json] } }) { promise.resolve($0) }
    }

    /* Every scope's copy and every cookie deleted: every live view down first, made again after. Answers what the
       store then reads: a record left is listed, with no count (the store gives none); the take-back judges it. */
    AsyncFunction("clearWebData") { (promise: Promise) in
      let live = ShellRuntime.live()
      for view in live { view.destroyWeb() }
      let store = WKWebsiteDataStore.default()
      let all = WKWebsiteDataStore.allWebsiteDataTypes()
      store.removeData(ofTypes: all, modifiedSince: .distantPast) {
        store.fetchDataRecords(ofTypes: all) { records in
          if !records.isEmpty { ShellRuntime.count("webDataRemains") }
          for view in live { view.rebuild() }
          let usage: Int? = records.isEmpty ? 0 : nil
          promise.resolve(["listed": !records.isEmpty, "usage": usage as Any])
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("setFamilies") { (prefixes: [String]) -> Bool in
      Keeper.shared.families = prefixes.filter { !$0.isEmpty }
      return true
    }

    View(ShellView.self) {
      Events("onMessage", "onEpoch", "onLinkAsk", "onMailto", "onRefused")
      Prop("scope") { (view: ShellView, scope: String?) in view.setScope(scope) }
      AsyncFunction("post") { (view: ShellView, epoch: String, json: String) in view.post(epoch, json) }
      AsyncFunction("openHeld") { (view: ShellView, token: String) -> Bool in view.openHeld(token) }.runOnQueue(.main)
    }
  }
}
