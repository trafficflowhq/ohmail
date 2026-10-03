import ExpoModulesCore
import Network
import UIKit
import os

/**
 * The iOS half of the posture pair. `getHasFold` names the hardware: the iPhone Duo by its
 * model identifier (`hw.machine` on a device, `SIMULATOR_MODEL_IDENTIFIER` on the simulator) —
 * the door that sends the navigation to the right-edge rail on the closed face, which a
 * literal `false` here kept shut on the real device. `getStatusCluster` reads the status bar's
 * frame, the closed face's right-strip cluster the rail starts below. `getFolds` still answers
 * nil: the fold's reserved-region read is newer than every toolchain this repo compiled
 * against, and `derive.ts` covers the open face with the centre-hinge heuristic meanwhile.
 * `getLaunchOverride` is the simulator door (`SIMCTL_CHILD_OHMAIL_POSTURE=<pose>[@canvas]`).
 * The network door's reader lives here too (`src/net/network-door.ts`): a path monitor answers
 * "online" or "offline" through `getNetwork`, "unknown" before its first path, and sends
 * `onNetworkChanged` on each change. The state is read and written under one lock.
 */
public class OhmailPostureModule: Module {
  /** Apple's model identifiers for the iPhone Duo (iPhone19,4 read on the 27.1 simulator). */
  private static let duoModels: Set<String> = ["iPhone19,4", "iPhone19,5"]

  private var monitor: NWPathMonitor?
  private let networkLock = NSLock()
  private var network = "unknown"

  private func readNetwork() -> String {
    networkLock.lock()
    defer { networkLock.unlock() }
    return network
  }

  /** Stores the reading and answers whether it changed. */
  private func storeNetwork(_ next: String) -> Bool {
    networkLock.lock()
    defer { networkLock.unlock() }
    if next == network { return false }
    network = next
    return true
  }

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

  /**
   * The mail frame's memory class in MB (`src/mail/frame-ceiling.ts`). iOS has no Java heap; the bound
   * is the jetsam limit, so the class is what this process may still allocate (`os_proc_available_memory`,
   * read at the call) divided by 16 MB: 2 GB free reads 128, 1.5 GB 96, 1 GB 64. The simulator has no
   * limit and answers 0, which the JS takes as the floor. iOS names no low-RAM device.
   */
  private static let availableMbPerClassMb: UInt64 = 16

  private static func memoryClass() -> Int {
    let available = UInt64(os_proc_available_memory())
    return Int(available / (1024 * 1024) / availableMbPerClassMb)
  }

  private static func isDuo() -> Bool {
    if duoModels.contains(modelIdentifier()) { return true }
    let name = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? ""
    return name.localizedCaseInsensitiveContains("iPhone Duo")
  }

  public func definition() -> ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged", "onNetworkChanged")

    OnCreate {
      let m = NWPathMonitor()
      m.pathUpdateHandler = { [weak self] path in
        guard let self = self else { return }
        let state = path.status == .satisfied ? "online" : "offline"
        if self.storeNetwork(state) {
          self.sendEvent("onNetworkChanged", ["state": state])
        }
      }
      m.start(queue: DispatchQueue(label: "app.ohmail.network"))
      self.monitor = m
    }

    OnDestroy {
      self.monitor?.cancel()
      self.monitor = nil
    }

    Function("getNetwork") { () -> String in
      return self.readNetwork()
    }

    Function("getFolds") { () -> [[String: Any]]? in
      return nil
    }

    Function("getHasFold") { () -> Bool in
      return OhmailPostureModule.isDuo()
    }

    Function("getMemoryClass") { () -> Int in
      return OhmailPostureModule.memoryClass()
    }

    Function("isLowRamDevice") { () -> Bool in
      return false
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

    // The key window's frame in its screen's coordinate space, and the screen's width — which
    // half a split window is in (`windowBoundsOf` in derive.ts). Main queue, for the reason above.
    AsyncFunction("getWindowFrame") { () -> [String: Double]? in
      guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
      let screen = scene.screen.bounds
      let frame = window.convert(window.bounds, to: scene.screen.coordinateSpace)
      if frame.width <= 0 || screen.width <= 0 { return nil }
      return ["x": Double(frame.origin.x), "w": Double(frame.width), "screenW": Double(screen.width)]
    }.runOnQueue(.main)

    Function("getLaunchOverride") { () -> String? in
      return ProcessInfo.processInfo.environment["OHMAIL_POSTURE"]
    }
  }
}
