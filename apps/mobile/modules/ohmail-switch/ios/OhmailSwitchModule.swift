// THE SWITCH'S LINK HAS ONE GRAMMAR, and it is here: `SwitchArrivals.take` reads a link and `openSibling` writes one.
// https, the app's own host, the exact path, no query, the payload in the fragment with known keys once each; anything
// else is dropped whole. Android carries the same fields as extras, and the JavaScript reads only the fields native
// hands over (`src/switch/payload.ts`).
import CryptoKit
import ExpoModulesCore
import Security
import UIKit

/// Where the switch's links land, as `plugins/app-switch.js` writes it into Info.plist.
private func lands() -> [String: String]? {
  Bundle.main.object(forInfoDictionaryKey: "OhmailSwitch") as? [String: String]
}

private let arrivalName = Notification.Name("OhmailSwitchArrival")
/// How long an arrival waits for the page, an armed press for the sibling's ask, and a pending ask for its code.
private let arrivalTTL: TimeInterval = 60
private let armTTL: TimeInterval = 60
private let askTTL: TimeInterval = 120
private let pressGap: TimeInterval = 2
private let fieldNames: Set<String> = ["v", "k", "p", "d", "c", "l"]
/// Each leg's fields: those it must carry, then those it may.
private let legs: [String: (need: [String], may: [String])] = [
  "open": (["v", "k", "p"], ["d"]),
  "ask": (["v", "k", "c"], []),
  "done": (["v", "k", "c", "l"], []),
]
/// The characters a fragment's value keeps as they are, all ASCII; every other byte is percent-encoded.
private let kept = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~:")
private let base64url = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

/// A digest or a challenge as the switch carries them: 32 bytes, base64url, no padding.
private func isDigest(_ text: String?) -> Bool {
  guard let text = text, text.unicodeScalars.count == 43 else { return false }
  return text.unicodeScalars.allSatisfy { base64url.contains($0) }
}

private func encoded(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

/// Two strings compared in time that does not depend on where they differ.
private func sameText(_ a: String, _ b: String) -> Bool {
  let x = Array(a.utf8), y = Array(b.utf8)
  guard x.count == y.count else { return false }
  var diff: UInt8 = 0
  for i in 0..<x.count { diff |= x[i] ^ y[i] }
  return diff == 0
}

/// THE ONE PENDING ASK of a receiving iPhone app: a verifier of 32 random bytes from the system's own source, its
/// challenge (SHA-256 of the verifier, base64url), the digest and the place of the arrival it answers, and when it was
/// made, in one file of the app's own support folder, kept out of backups and locked with the phone. One at a time;
/// handed over once, only for its own challenge, within two minutes, and gone after any taking. Never logged.
enum SwitchAsk {
  private static let askFile = "ohmail-switch-ask"

  private static func url() -> URL? {
    guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(askFile)
  }

  /// A fresh ask in place of any other: its challenge, or nil when it could not be kept.
  static func make(digest: String, place: String) -> String? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess, var file = url() else {
      return nil
    }
    let verifier = encoded(Data(bytes))
    let challenge = encoded(Data(SHA256.hash(data: Data(verifier.utf8))))
    let record: [String: String] = [
      "v": "1", "verifier": verifier, "challenge": challenge, "d": digest, "p": place,
      "at": String(Date().timeIntervalSince1970),
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: record)
      try data.write(to: file, options: [.atomic, .completeFileProtection])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try file.setResourceValues(values)
      return challenge
    } catch {
      try? FileManager.default.removeItem(at: file)
      return nil
    }
  }

  private static func read() -> [String: String]? {
    guard let file = url(), let data = try? Data(contentsOf: file) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
  }

  private static func fresh(_ record: [String: String]) -> Bool {
    guard record["v"] == "1", let at = record["at"].flatMap(Double.init) else { return false }
    let age = Date().timeIntervalSince1970 - at
    return age >= 0 && age <= askTTL
  }

  /// Whether an ask is pending for this challenge; nothing is taken.
  static func pending(for challenge: String) -> Bool {
    guard isDigest(challenge), let record = read(), fresh(record), let made = record["challenge"] else { return false }
    return sameText(made, challenge)
  }

  /// The pending ask's verifier with its digest and place, once and only for `challenge`. Any taking clears it.
  static func take(_ challenge: String) -> [String: String]? {
    let record = read()
    if let file = url() { try? FileManager.default.removeItem(at: file) }
    guard isDigest(challenge), let record = record, fresh(record), let made = record["challenge"], sameText(made, challenge),
          let verifier = record["verifier"], let digest = record["d"], let place = record["p"] else {
      return nil
    }
    return ["verifier": verifier, "d": digest, "p": place]
  }

  static func drop() {
    if let file = url() { try? FileManager.default.removeItem(at: file) }
  }

  /// An ask no arrival can take any more (past two minutes, or of another shape), dropped at the app's launch. One the
  /// locked phone will not let this app read is left for a later launch.
  static func dropStale() {
    guard let file = url(), let data = try? Data(contentsOf: file) else { return }
    let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
    if record.map(fresh) != true { try? FileManager.default.removeItem(at: file) }
  }
}

/// One arrival, held for the page and handed over once; and the two short states of a sign-in handed over in three
/// legs. The scene delegate hands a switch link here and to nothing else (plugins/with-ios-scene-lifecycle.js); the
/// subscriber below listens from the app's launch, before any scene connects, so a cold link is held too.
///
///  - A press ARMS this app for a minute: the sibling may then ask back once (`ask`), which spends the arm and lets
///    this app answer that one challenge (`done`). An ask that finds no arm is dropped without a word.
///  - An opening leg handed over to the app lets it ask back once, in direct answer to it.
///  - A `done` is held only while this app's own ask for its challenge is pending.
final class SwitchArrivals {
  static let shared = SwitchArrivals()
  private(set) var held: [String: String]?
  private var heldAt = Date.distantPast
  private var armedUntil = Date.distantPast
  private var granting: (challenge: String, until: Date)?
  private var askableUntil = Date.distantPast
  var arrived: (() -> Void)?

  func take(_ url: URL) {
    guard let own = lands(), url.scheme == "https", url.host == own["ownHost"], url.path == own["ownPath"],
          url.query == nil, let fragment = url.fragment, !fragment.isEmpty else {
      return
    }
    var fields: [String: String] = [:]
    for pair in fragment.split(separator: "&", omittingEmptySubsequences: false) {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2, let key = String(parts[0]).removingPercentEncoding, fieldNames.contains(key),
            fields[key] == nil, let value = String(parts[1]).removingPercentEncoding else {
        return
      }
      fields[key] = value
    }
    switch fields["k"] ?? "" {
    case "open":
      break
    case "ask":
      // Only while this app's own press armed it, and only the first ask: the arm is spent here.
      guard Date() < armedUntil, let challenge = fields["c"], isDigest(challenge) else { return }
      armedUntil = .distantPast
      granting = (challenge, Date().addingTimeInterval(armTTL))
    case "done":
      guard let challenge = fields["c"], SwitchAsk.pending(for: challenge) else { return }
    default:
      return
    }
    held = fields
    heldAt = Date()
    arrived?()
  }

  func handOver() -> [String: String]? {
    defer { held = nil }
    guard let fields = held, Date().timeIntervalSince(heldAt) <= arrivalTTL else { return nil }
    if fields["k"] == "open" { askableUntil = Date().addingTimeInterval(arrivalTTL) }
    return fields
  }

  func arm() { armedUntil = Date().addingTimeInterval(armTTL) }
  func disarm() { armedUntil = .distantPast }

  /// The one ask an opening leg allows, spent.
  func spendAsk() -> Bool {
    guard Date() < askableUntil else { return false }
    askableUntil = .distantPast
    return true
  }

  /// The one answer an armed ask allows, for its own challenge, spent.
  func spendGrant(_ challenge: String) -> Bool {
    guard let grant = granting, Date() < grant.until, sameText(grant.challenge, challenge) else { return false }
    granting = nil
    return true
  }
}

/// Listens for the scene delegate's hand-over from the app's launch on.
public class SwitchArrivalSubscriber: ExpoAppDelegateSubscriber {
  private var observer: NSObjectProtocol?

  public func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    SwitchAsk.dropStale()
    observer = NotificationCenter.default.addObserver(forName: arrivalName, object: nil, queue: .main) { note in
      if let text = note.userInfo?["url"] as? String, let url = URL(string: text) { SwitchArrivals.shared.take(url) }
    }
    return true
  }
}

/// The sibling's link for one leg, its fields as the fragment, opened only if an installed app takes it
/// (`universalLinksOnly`): nothing opens otherwise, no browser either. False for a leg without its fields.
private func openSibling(_ fields: [String: String], leg: String, done: @escaping (Bool) -> Void) {
  guard let own = lands(), let host = own["siblingHost"], let path = own["siblingPath"], let shape = legs[leg],
        fields["k"] == leg, fields["v"] == "1" else {
    done(false)
    return
  }
  var parts: [String] = []
  for key in shape.need + shape.may {
    guard let value = fields[key] else {
      if shape.need.contains(key) {
        done(false)
        return
      }
      continue
    }
    guard let escaped = value.addingPercentEncoding(withAllowedCharacters: kept) else {
      done(false)
      return
    }
    parts.append("\(key)=\(escaped)")
  }
  var components = URLComponents()
  components.scheme = "https"
  components.host = host
  components.path = path
  components.percentEncodedFragment = parts.joined(separator: "&")
  guard let url = components.url else {
    done(false)
    return
  }
  UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
    done(opened)
  }
}

/// THE SWITCH BETWEEN THE TWO APPS, native's whole on the iPhone. `appId` is the bundle identifier this app was
/// installed under. Whether the other app is here cannot be asked before a press (`unknown`); a press opens the
/// other app's universal link only if an installed app takes it, and reads a refusal as absent. The payload is the
/// link's fragment, never its path or query, and nothing of it is logged.
///
/// A sign-in crosses in three legs, each its own universal link: the press opens the sibling with the place and this
/// app's pairing's digest and arms this app for a minute (`open`); a signed-out sibling asks back once with the
/// challenge of a verifier it made and keeps (`askBack`); the armed sender answers that one challenge with the code it
/// minted for it (`answer`), and the sibling spends it with its verifier (`takeVerifier`).
public class OhmailSwitchModule: Module {
  private var lastOpen = Date.distantPast

  public func definition() -> ModuleDefinition {
    Name("OhmailSwitch")

    Constant("appId") {
      Bundle.main.bundleIdentifier ?? ""
    }

    Events("onArrival")

    OnCreate { [weak self] in
      SwitchArrivals.shared.arrived = { self?.sendEvent("onArrival", [:]) }
    }

    Function("otherState") { () -> String in
      "unknown"
    }

    AsyncFunction("open") { (fields: [String: String], promise: Promise) in
      guard UIApplication.shared.applicationState == .active, Date().timeIntervalSince(self.lastOpen) >= pressGap,
            fields["k"] == "open" else {
        promise.resolve(false)
        return
      }
      self.lastOpen = Date()
      // Armed before the link opens: the sibling's ask may come back before the system says it opened.
      SwitchArrivals.shared.arm()
      openSibling(fields, leg: "open") { opened in
        if opened {
          promise.resolve(true)
          return
        }
        SwitchArrivals.shared.disarm()
        // Opening the mail app at its root carries no place, pairing digest or handoff.
        guard fields["p"] == "last", let scheme = lands()?["siblingScheme"],
              let url = URL(string: "\(scheme):///") else {
          promise.resolve(false)
          return
        }
        UIApplication.shared.open(url, options: [:]) { promise.resolve($0) }
      }
    }.runOnQueue(.main)

    AsyncFunction("askBack") { (digest: String, place: String, promise: Promise) in
      guard UIApplication.shared.applicationState == .active, isDigest(digest), !place.isEmpty, place.count <= 64,
            place.unicodeScalars.allSatisfy({ kept.contains($0) }), SwitchArrivals.shared.spendAsk(),
            let challenge = SwitchAsk.make(digest: digest, place: place) else {
        promise.resolve(false)
        return
      }
      openSibling(["v": "1", "k": "ask", "c": challenge], leg: "ask") { opened in
        if !opened { SwitchAsk.drop() }
        promise.resolve(opened)
      }
    }.runOnQueue(.main)

    AsyncFunction("answer") { (challenge: String, link: String, promise: Promise) in
      guard UIApplication.shared.applicationState == .active, isDigest(challenge), !link.isEmpty, link.count <= 2048,
            SwitchArrivals.shared.spendGrant(challenge) else {
        promise.resolve(false)
        return
      }
      openSibling(["v": "1", "k": "done", "c": challenge, "l": link], leg: "done") { opened in
        promise.resolve(opened)
      }
    }.runOnQueue(.main)

    // No App Store page of the calendar exists yet: the app's own download page is the way (src/net/account.ts).
    AsyncFunction("openStore") { () -> Bool in
      false
    }

    AsyncFunction("takeArrival") { () -> [String: String]? in
      SwitchArrivals.shared.handOver()
    }.runOnQueue(.main)

    AsyncFunction("takeVerifier") { (challenge: String) -> [String: String]? in
      SwitchAsk.take(challenge)
    }.runOnQueue(.main)
  }
}
