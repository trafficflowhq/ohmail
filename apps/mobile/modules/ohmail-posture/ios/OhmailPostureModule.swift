import ExpoModulesCore

/**
 * The iOS half of the posture pair. What it answers TODAY: the launch override — the door a
 * simulator test drives (`xcrun simctl launch … SIMCTL_CHILD_OHMAIL_POSTURE=<pose>`). What it answers
 * nil for, deliberately: the fold reading. The iPhone Duo SDK exposes the fold as division
 * reserved regions — `view.reservedRegions(kind: .division)`, active only while folded ("Flat,
 * it has no width at all", HIG designing-for-iphone-duo) — plus `UIHingeInteraction` /
 * SwiftUI's `onHingeChange` for closed | partiallyOpen | fullyOpen and the angle. Those
 * symbols are newer than any Xcode this repo has compiled against, and a reflective read of an
 * unreleased SDK is a crash on exactly the device that matters, so `getFolds` answers nil —
 * the JS side's honest "API absent", which `derive.ts` covers with the Duo aspect heuristic
 * (centre hinge on the inner display, the prototype's own fallback). Wiring the real read is
 * one function when the Mac's Xcode carries the SDK, and this comment names it.
 */
public class OhmailPostureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged")

    Function("getFolds") { () -> [[String: Any]]? in
      return nil
    }

    Function("getHasFold") { () -> Bool in
      return false
    }

    Function("getLaunchOverride") { () -> String? in
      return ProcessInfo.processInfo.environment["OHMAIL_POSTURE"]
    }
  }
}
