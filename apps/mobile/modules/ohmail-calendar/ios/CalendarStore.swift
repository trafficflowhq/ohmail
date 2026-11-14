import Foundation

enum CalendarStore {
  static let dirName = "ohcal"
  static let liveName = "ohcal-live"
  static let rungName = "ohcal-rung"
  private static let generationFile = "ohcal-widget-generation"
  private static let cleanupFile = "ohcal-widget-cleanup"
  private static let revoked = "revoked"
  private static let lock = NSRecursiveLock()

  struct Generation: Equatable { let pairing: String; let id: String }
  struct Active { let generation: Generation; let snapshot: CalSnapshot }

  static func isInstance(_ text: String?) -> Bool {
    guard let text = text, text.utf8.count >= 7, text.utf8.count <= 31, text.first == "p" else { return false }
    return text.utf8.dropFirst().allSatisfy { (48...57).contains($0) || (97...122).contains($0) }
  }

  private static func generationID(_ value: String) -> String? {
    guard let id = UUID(uuidString: value), id.uuidString.lowercased() == value else { return nil }
    return value
  }

  private static func directory(_ root: URL?) -> URL? {
    guard let root = root else { return nil }
    var dir = root.appendingPathComponent(dirName, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try dir.setResourceValues(values)
      return dir
    } catch { return nil }
  }

  private static func shared() -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OhcalGroup") as? String, !group.isEmpty else { return nil }
    return directory(FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group))
  }

  private static func privateRecords() -> URL? {
    directory(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
  }

  private static func read(_ url: URL, limit: Int) -> Data? {
    guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
          values.isRegularFile == true, let size = values.fileSize, size <= limit else { return nil }
    return try? Data(contentsOf: url)
  }

  private static func marker(_ directory: URL?) -> String? {
    guard let path = directory?.appendingPathComponent(generationFile), let data = read(path, limit: 128) else { return nil }
    return String(data: data, encoding: .ascii)
  }

  private static func mark(_ directory: URL?, _ value: String) -> Bool {
    guard let path = directory?.appendingPathComponent(generationFile), let data = value.data(using: .ascii) else { return false }
    do {
      try data.write(to: path, options: [.atomic, .completeFileProtection])
      return marker(directory) == value
    } catch { return false }
  }

  /// The extension can read only an opaque shortcut. It never reads the app-private event or alarm record.
  static func widgetLink() -> URL? {
    guard let path = shared(), let value = marker(path), let id = generationID(value),
          let scheme = Bundle.main.object(forInfoDictionaryKey: "OhcalWidgetScheme") as? String,
          marker(path) == id else { return nil }
    return URL(string: "\(scheme)://calendar-widget/\(id)")
  }

  private static func cleanupPending(_ local: URL) -> Bool {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: local.path) else { return true }
    return names.contains(cleanupFile)
  }

  private static func oweCleanup(_ local: URL?) -> Bool {
    guard let local = local else { return false }
    let file = local.appendingPathComponent(cleanupFile)
    do {
      // This marker carries no event data. It can fence a generation even after the device locks.
      try Data([1]).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return read(file, limit: 1) == Data([1])
    } catch { return false }
  }

  static func finishCleanup() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return erase(privateRecords()) { $0 == cleanupFile }
  }

  static func revoke() -> Bool {
    lock.lock(); defer { lock.unlock() }
    let local = privateRecords()
    let owed = oweCleanup(local)
    let publicRevoked = mark(shared(), revoked)
    let privateRevoked = mark(local, revoked)
    return owed && publicRevoked && privateRevoked
  }

  /// Both marker reads must agree before a snapshot may be used.
  static func readLive() -> Active? {
    lock.lock(); defer { lock.unlock() }
    guard let local = privateRecords(), !cleanupPending(local), let group = shared(), let before = marker(local) else { return nil }
    let parts = before.components(separatedBy: "\n")
    guard parts.count == 2, isInstance(parts[0]), let id = generationID(parts[1]), marker(group) == id,
          let data = read(recordURL(local, parts[0]), limit: CalendarRecord.most),
          let snapshot = CalendarRecord.read(data), !snapshot.hasTitles, marker(local) == before, marker(group) == id, !cleanupPending(local) else { return nil }
    return Active(generation: Generation(pairing: parts[0], id: id), snapshot: snapshot)
  }

  private static func recordURL(_ root: URL, _ pairing: String) -> URL {
    root.appendingPathComponent(pairing, isDirectory: true).appendingPathComponent(CalendarRecord.fileName)
  }

  static func recordPath(_ pairing: String) -> String {
    guard isInstance(pairing), let root = privateRecords() else { return "" }
    return recordURL(root, pairing).path
  }

  static func publish(_ pairing: String, _ snapshot: CalSnapshot) -> Active? {
    lock.lock(); defer { lock.unlock() }
    guard !snapshot.hasTitles, isInstance(pairing), let local = privateRecords(), !cleanupPending(local), let group = shared(),
          marker(local) == revoked, marker(group) == revoked, let data = CalendarRecord.write(snapshot) else { return nil }
    let id = UUID().uuidString.lowercased()
    let path = recordURL(local, pairing)
    do {
      try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: path, options: [.atomic, .completeFileProtection])
      guard mark(local, "\(pairing)\n\(id)"), mark(group, id), let current = readLive(),
            current.snapshot == snapshot, current.generation.id == id else {
        _ = revoke()
        return nil
      }
      return current
    } catch { return nil }
  }

  /// A directory that cannot be listed is an unresolved wipe.
  private static func erase(_ root: URL?, where remove: (String) -> Bool) -> Bool {
    guard let root = root else { return false }
    let fm = FileManager.default
    do {
      let names = try fm.contentsOfDirectory(atPath: root.path)
      for name in names where remove(name) { try fm.removeItem(at: root.appendingPathComponent(name)) }
      return try fm.contentsOfDirectory(atPath: root.path).allSatisfy { !remove($0) }
    } catch { return false }
  }

  static func eraseRecords() -> Bool {
    lock.lock(); defer { lock.unlock() }
    let local = erase(privateRecords()) { $0 != generationFile && $0 != cleanupFile }
    let legacy = erase(shared()) { $0 != generationFile }
    return local && legacy
  }

  static func eraseInactive(_ pairing: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard isInstance(pairing) else { return false }
    let local = erase(privateRecords()) { $0 == pairing }
    let legacy = erase(shared()) { $0 == pairing || $0 == liveName }
    return local && legacy
  }

  static func widgetOccurrence(_ snapshot: CalSnapshot) -> CalEvent? {
    snapshot.days.flatMap { $0.events }.filter { $0.label.word != "busy" && $0.startMs >= snapshot.writtenAt }
      .min { $0.startMs < $1.startMs }
  }
}
