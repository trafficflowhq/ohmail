import ExpoModulesCore
import Foundation

/**
 * THE MIRROR STAYS OUT OF THE DEVICE BACKUP — the iOS half.
 *
 * expo-sqlite opens the mirror under the app's documents, which the platform's cloud and
 * computer backups include unless the item carries `isExcludedFromBackup`. The subject is the
 * DIRECTORY holding the database file, not the file: SQLite writes `-wal` and `-shm` siblings,
 * and excluding the directory covers whatever it writes next. Both functions answer the
 * READ-BACK, never the outcome of the set — a `setResourceValues` that returned without
 * throwing has said nothing about what the platform recorded.
 */
public class OhmailBackupExclusionModule: Module {
  /** The directory the database file sits in, or nil where nothing is there to mark. */
  private static func subject(_ path: String) -> URL? {
    if path.isEmpty { return nil }
    let dir = URL(fileURLWithPath: path).deletingLastPathComponent()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDirectory),
          isDirectory.boolValue else { return nil }
    return dir
  }

  /**
   * The read, through a URL built fresh for it. A `URL` caches the resource values it was asked
   * for, so reading back through the same instance that was just written can answer from the
   * cache rather than from the file system — which is the shape of a measurement that agrees
   * with the thing it is measuring.
   */
  private static func readBack(_ path: String) -> Bool {
    guard let dir = subject(path) else { return false }
    let fresh = URL(fileURLWithPath: dir.path)
    guard let values = try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]) else {
      return false
    }
    return values.isExcludedFromBackup ?? false
  }

  public func definition() -> ModuleDefinition {
    Name("OhmailBackupExclusion")

    AsyncFunction("excludeFromBackup") { (path: String) -> Bool in
      if var dir = OhmailBackupExclusionModule.subject(path) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        // Swallowed on purpose: a refusal here is not the answer either, and the read below is.
        try? dir.setResourceValues(values)
      }
      return OhmailBackupExclusionModule.readBack(path)
    }

    AsyncFunction("isExcluded") { (path: String) -> Bool in
      return OhmailBackupExclusionModule.readBack(path)
    }
  }
}
