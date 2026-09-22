import ExpoModulesCore
import Foundation
import os

/**
 * THE ENGINE'S LOG REACHES A SHIPPED BUILD'S SYSTEM LOG — the iOS half.
 *
 * `console.log` is dropped entirely by a Release build (React Native pins its iOS threshold to
 * error when `RCT_DEBUG` is off), so until this existed no shipped iPhone build could hand
 * anybody the engine's log. `os_log` is not RN's console and does not travel through it: the
 * line lands in the unified log under a subsystem of this app's own, readable on a device with
 * `log stream --predicate 'subsystem == "app.ohmail.engine"'` and on a simulator through
 * `xcrun simctl spawn <udid> log stream …`.
 *
 * `%{public}@` and nothing else: os_log redacts every dynamic string as `<private>` by default,
 * and a log of `<private>` is the silence this module exists to end. What makes that safe is
 * that the line arrives ALREADY REDACTED — the field allowlist, the value scrubber and the
 * bounds all ran in the engine's own logger before this call. This module composes nothing.
 */
public class OhmailEngineLogSinkModule: Module {
  private static let log = OSLog(subsystem: "app.ohmail.engine", category: "engine")

  /**
   * The level map, and `info` → `.default` is the load-bearing entry: `log stream` shows
   * `.default` and above without a flag and drops `.info` unless the reader passes `--level
   * info`, so mapping the engine's ordinary level to `.info` would have made a correct build
   * read as a silent one. `warn` takes `.default` too — the JSON line carries `"level":"warn"`
   * and is the authority; promoting it to `.error` would put warnings in a class readers filter
   * on to find failures. `.debug` stays `.debug`: it is off by default on both sides.
   */
  private static func osType(_ level: String) -> OSLogType {
    switch level {
    case "error": return .error
    case "debug": return .debug
    default: return .default
    }
  }

  public func definition() -> ModuleDefinition {
    Name("OhmailEngineLogSink")

    // Synchronous on purpose: a promise per line would reorder the log against the work it
    // describes, and the whole value of these lines is the order they arrived in.
    Function("write") { (level: String, line: String) in
      os_log("%{public}@", log: OhmailEngineLogSinkModule.log, type: OhmailEngineLogSinkModule.osType(level), line)
    }
  }
}
