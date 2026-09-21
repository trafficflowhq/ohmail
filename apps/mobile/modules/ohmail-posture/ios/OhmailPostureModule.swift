import ExpoModulesCore
import UIKit

/**
 * The iOS half of the posture pair. `getHasFold` names the hardware: the iPhone Duo by its
 * model identifier (`hw.machine` on a device, `SIMULATOR_MODEL_IDENTIFIER` on the simulator) —
 * the door that sends the navigation to the right-edge rail on the closed face, which a
 * literal `false` here kept shut on the real device. `getStatusCluster` reads the status bar's
 * frame, the closed face's right-strip cluster the rail starts below. `getFolds` still answers
 * nil: the fold's reserved-region read is newer than every toolchain this repo compiled
 * against, and `derive.ts` covers the open face with the centre-hinge heuristic meanwhile.
 * `getLaunchOverride` is the simulator door (`SIMCTL_CHILD_OHMAIL_POSTURE=<pose>[@canvas]`).
 */
public class OhmailPostureModule: Module {
  /** Apple's model identifiers for the iPhone Duo (iPhone19,4 read on the 27.1 simulator). */
  private static let duoModels: Set<String> = ["iPhone19,4", "iPhone19,5"]

  private static func modelIdentifier() -> String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !sim.isEmpty {
      return sim
    }
    var sys = utsname()
    uname(&sys)
    return withUnsafePointer(to: &sys.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
    }
  }

  private static func isDuo() -> Bool {
    if duoModels.contains(modelIdentifier()) { return true }
    let name = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? ""
    return name.localizedCaseInsensitiveContains("iPhone Duo")
  }

  public func definition() -> ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged")

    Function("getFolds") { () -> [[String: Any]]? in
      return nil
    }

    Function("getHasFold") { () -> Bool in
      return OhmailPostureModule.isDuo()
    }

    Function("getModelIdentifier") { () -> String in
      return OhmailPostureModule.modelIdentifier()
    }

    // The status bar's frame in window points — on the closed Duo the cluster in the right
    // strip; nil where no scene answers (app not yet in the foreground) or the frame is empty.
    // Async so it can run on the main queue, where UIKit's scenes are read.
    AsyncFunction("getStatusCluster") { () -> [String: Double]? in
      guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let bar = scene.statusBarManager else { return nil }
      let f = bar.statusBarFrame
      if f.width <= 0 || f.height <= 0 { return nil }
      return ["x": f.origin.x, "y": f.origin.y, "width": f.width, "height": f.height]
    }.runOnQueue(.main)

    Function("getLaunchOverride") { () -> String? in
      return ProcessInfo.processInfo.environment["OHMAIL_POSTURE"]
    }
  }
}
