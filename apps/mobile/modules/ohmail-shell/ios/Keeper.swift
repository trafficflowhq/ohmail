import CryptoKit
import Foundation
import SQLite3

/**
 * THE KEEPER (iOS): a person's words and intent and the queue's rows, one SQLite database per scope
 * in expo-sqlite's directory, each write a transaction at synchronous EXTRA, read back at open. The
 * same rules as Android's `Keeper.kt`: only the families the native side was given, only the queue's
 * carried types, bounds refuse and nothing is evicted; a refused word is remembered for its scope
 * with the digest of what was asked, until a later keep of it lands (`refused`). One serial queue;
 * nothing here runs on React Native's thread. Written, not compiled here.
 */
final class Keeper {
  struct Row { let type: String; let id: String; let json: String }

  static let shared = Keeper()
  private let queue = DispatchQueue(label: "shell keeper")
  private var open: [String: OpaquePointer] = [:]
  /** Refused names the scope's file could not take, with their digests (nil: a removal): this process's alone. */
  private var unwritten: [String: [String: String?]] = [:]
  var families: [String] = []

  static let filePrefix = "ohmail-keeper-"
  static let carried: Set<String> = ["outbox_entry", "outbox_abandoned", "routing_journal", "compose_letter", "compose_file"]
  static let keyMax = 512, valueMax = 10 * 1024 * 1024, wordsMax = 32 * 1024 * 1024
  static let idMax = 256, rowMax = 64 * 1024 * 1024, rowsMax = 10_000
  /** Refused words remembered per scope, as on Android. */
  static let refusedMax = 1_000

  static func isScope(_ s: String) -> Bool { s.range(of: "^p[0-9a-f]{32}$", options: .regularExpression) != nil }

  func run<T>(_ work: @escaping () -> T, _ done: @escaping (T) -> Void) { queue.async { done(work()) } }

  private func dir() -> URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let d = docs.appendingPathComponent("SQLite", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  private func fileOf(_ scope: String) -> URL { dir().appendingPathComponent("\(Keeper.filePrefix)\(scope).db") }

  /** The scope's file, as a path; empty for a name that is no scope. */
  func pathOf(_ scope: String) -> String { Keeper.isScope(scope) ? fileOf(scope).path : "" }

  private func db(_ scope: String) -> OpaquePointer? {
    guard Keeper.isScope(scope) else { return nil }
    if let d = open[scope] { return d }
    var d: OpaquePointer?
    guard sqlite3_open(fileOf(scope).path, &d) == SQLITE_OK, let h = d else { return nil }
    sqlite3_exec(h, "PRAGMA synchronous = EXTRA", nil, nil, nil)
    guard intOf(h, "PRAGMA synchronous") == 3 else { sqlite3_close(h); return nil }
    sqlite3_exec(h, "CREATE TABLE IF NOT EXISTS words (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)", nil, nil, nil)
    sqlite3_exec(h, "CREATE TABLE IF NOT EXISTS rows (type TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (type, id))", nil, nil, nil)
    sqlite3_exec(h, "CREATE TABLE IF NOT EXISTS refused (key TEXT PRIMARY KEY NOT NULL, digest TEXT)", nil, nil, nil)
    open[scope] = h
    return h
  }

  func isKeptFamily(_ key: String) -> Bool { key.count <= Keeper.keyMax && families.contains { key.hasPrefix($0) } }

  /** False: refused, and the word is remembered as refused. Kept: a refusal of it remembered earlier goes in the same commit. */
  func keep(_ scope: String, _ key: String, _ value: String?) -> Bool {
    guard isKeptFamily(key), Keeper.isScope(scope) else { return false }
    let h = db(scope)
    guard let d = h, write(d, key, value) else {
      remember(scope, h, key, value)
      return false
    }
    unwritten[scope]?.removeValue(forKey: key)
    if unwritten[scope]?.isEmpty == true { unwritten[scope] = nil }
    return true
  }

  private func write(_ h: OpaquePointer, _ key: String, _ value: String?) -> Bool {
    guard (value?.utf16.count ?? 0) <= Keeper.valueMax else { return false }
    guard sqlite3_exec(h, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    var ok: Bool
    if let v = value {
      let others = intOf(h, "SELECT coalesce(sum(length(value)), 0) FROM words WHERE key <> ?", [key])
      ok = others >= 0 && others + v.utf16.count <= Keeper.wordsMax
        && exec(h, "INSERT OR REPLACE INTO words (key, value) VALUES (?, ?)", [key, v])
    } else {
      ok = exec(h, "DELETE FROM words WHERE key = ?", [key])
    }
    if ok { ok = exec(h, "DELETE FROM refused WHERE key = ?", [key]) }
    if ok { ok = sqlite3_exec(h, "COMMIT", nil, nil, nil) == SQLITE_OK }
    if !ok { sqlite3_exec(h, "ROLLBACK", nil, nil, nil) }
    return ok
  }

  /** The scope's refused words, not kept since: each name with the digest of what was asked (nil: a removal). */
  func refused(_ scope: String) -> [(String, String?)] {
    var names: [(String, String?)] = []
    if let h = db(scope), let st = prepare(h, "SELECT key, digest FROM refused ORDER BY key", []) {
      defer { sqlite3_finalize(st) }
      while sqlite3_step(st) == SQLITE_ROW {
        let digest = sqlite3_column_type(st, 1) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(st, 1))
        names.append((String(cString: sqlite3_column_text(st, 0)), digest))
      }
    }
    if let waiting = unwritten[scope] {
      names.removeAll { waiting[$0.0] != nil }
      for key in waiting.keys.sorted() { names.append((key, waiting[key] ?? nil)) }
    }
    return names
  }

  /** A refused word, remembered for its scope: in its file when the file takes it, else for this process. */
  private func remember(_ scope: String, _ h: OpaquePointer?, _ key: String, _ value: String?) {
    let known = refused(scope)
    if known.count >= Keeper.refusedMax && !known.contains(where: { $0.0 == key }) {
      ShellRuntime.count("keeperRefusedUnnoted")
      return
    }
    let digest = Keeper.digestOf(value)
    let stored = h.map { exec($0, "INSERT OR REPLACE INTO refused (key, digest) VALUES (?, ?)", [key, digest]) } ?? false
    var waiting = unwritten[scope] ?? [:]
    if stored { waiting.removeValue(forKey: key) } else { waiting.updateValue(digest, forKey: key) }
    unwritten[scope] = waiting.isEmpty ? nil : waiting
  }

  /** The bridge's word digest: SHA-256 over the UTF-16 code units, low byte first, as lowercase hex; nil: a removal. */
  static func digestOf(_ value: String?) -> String? {
    guard let v = value else { return nil }
    var hasher = SHA256()
    var chunk: [UInt8] = []
    chunk.reserveCapacity(16_384)
    for unit in v.utf16 {
      chunk.append(UInt8(truncatingIfNeeded: unit))
      chunk.append(UInt8(truncatingIfNeeded: unit >> 8))
      if chunk.count >= 16_384 {
        hasher.update(data: chunk)
        chunk.removeAll(keepingCapacity: true)
      }
    }
    hasher.update(data: chunk)
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  func kept(_ scope: String) -> [(String, String)]? {
    guard let h = db(scope) else { return nil }
    return rowsOf(h, "SELECT key, value FROM words ORDER BY key", []).map { ($0[0], $0[1]) }
  }

  func keepRows(_ scope: String, _ puts: [Row], _ deletes: [(String, String)]) -> Bool {
    guard puts.allSatisfy({ Keeper.carried.contains($0.type) && $0.id.count <= Keeper.idMax && $0.json.utf16.count <= Keeper.rowMax }),
          deletes.allSatisfy({ Keeper.carried.contains($0.0) }), let h = db(scope) else { return false }
    guard sqlite3_exec(h, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    var ok = true
    for (type, id) in deletes where ok { ok = exec(h, "DELETE FROM rows WHERE type = ? AND id = ?", [type, id]) }
    for r in puts where ok { ok = exec(h, "INSERT OR REPLACE INTO rows (type, id, json) VALUES (?, ?, ?)", [r.type, r.id, r.json]) }
    if ok { ok = intOf(h, "SELECT count(*) FROM rows") <= Keeper.rowsMax }
    sqlite3_exec(h, ok ? "COMMIT" : "ROLLBACK", nil, nil, nil)
    return ok
  }

  func keptRows(_ scope: String) -> [Row]? {
    guard let h = db(scope) else { return nil }
    return rowsOf(h, "SELECT type, id, json FROM rows ORDER BY type, id", []).map { Row(type: $0[0], id: $0[1], json: $0[2]) }
  }

  func scopes() -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir().path)) ?? []
    return names.compactMap { n in
      guard n.hasPrefix(Keeper.filePrefix), n.hasSuffix(".db") else { return nil }
      let s = String(n.dropFirst(Keeper.filePrefix.count).dropLast(3))
      return Keeper.isScope(s) ? s : nil
    }.sorted()
  }

  func forget(_ scope: String) -> Bool {
    guard Keeper.isScope(scope) else { return false }
    if let h = open.removeValue(forKey: scope) { sqlite3_close(h) }
    unwritten[scope] = nil
    let base = fileOf(scope).path
    for suffix in ["", "-journal", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: base + suffix) }
    return ["", "-journal", "-wal", "-shm"].allSatisfy { !FileManager.default.fileExists(atPath: base + $0) }
  }

  // ── SQLite, by hand ──────────────────────────────────────────────────────────────────────────────

  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private func prepare(_ h: OpaquePointer, _ sql: String, _ args: [String?]) -> OpaquePointer? {
    var st: OpaquePointer?
    guard sqlite3_prepare_v2(h, sql, -1, &st, nil) == SQLITE_OK else { return nil }
    for (i, a) in args.enumerated() {
      if let a = a { sqlite3_bind_text(st, Int32(i + 1), a, -1, transient) } else { sqlite3_bind_null(st, Int32(i + 1)) }
    }
    return st
  }

  private func exec(_ h: OpaquePointer, _ sql: String, _ args: [String?]) -> Bool {
    guard let st = prepare(h, sql, args) else { return false }
    defer { sqlite3_finalize(st) }
    return sqlite3_step(st) == SQLITE_DONE
  }

  private func intOf(_ h: OpaquePointer, _ sql: String, _ args: [String?] = []) -> Int {
    guard let st = prepare(h, sql, args) else { return -1 }
    defer { sqlite3_finalize(st) }
    return sqlite3_step(st) == SQLITE_ROW ? Int(sqlite3_column_int64(st, 0)) : -1
  }

  private func rowsOf(_ h: OpaquePointer, _ sql: String, _ args: [String?]) -> [[String]] {
    guard let st = prepare(h, sql, args) else { return [] }
    defer { sqlite3_finalize(st) }
    var out: [[String]] = []
    while sqlite3_step(st) == SQLITE_ROW {
      out.append((0..<sqlite3_column_count(st)).map { String(cString: sqlite3_column_text(st, $0)) })
    }
    return out
  }
}
