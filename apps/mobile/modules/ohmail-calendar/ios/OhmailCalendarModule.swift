import ExpoModulesCore
import Foundation
import WidgetKit

public final class OhmailCalendarModule: Module {
  private var admitted: String?
  private var writable: String?
  private var clearing = UUID()

  public func definition() -> ModuleDefinition {
    Name("OhmailCalendar")

    AsyncFunction("keep") { (pairing: String, record: String, publication: String?, promise: Promise) in
      DispatchQueue.main.async {
        guard self.admitted == pairing, let publication = publication, self.writable == publication,
              let data = record.data(using: .utf8), let snapshot = CalendarRecord.read(data) else {
          promise.resolve(false); return
        }
        self.writable = nil
        guard let active = CalendarStore.publish(pairing, snapshot) else {
          self.clean { _ in promise.resolve(false) }
          return
        }
        WidgetCenter.shared.reloadAllTimelines()
        CalendarAlerts.arm(active.generation) { ok in
          self.finishArming(ok, active.generation, promise)
        }
      }
    }

    Function("recordPath") { (pairing: String) -> String in CalendarStore.recordPath(pairing) }

    AsyncFunction("setLive") { (instance: String?, promise: Promise) in
      DispatchQueue.main.async {
        self.admitted = nil
        self.writable = nil
        if let instance = instance, let active = CalendarStore.readLive(), active.generation.pairing == instance {
          // This call follows the selected profile check and the durable wipe drain.
          CalendarAlerts.clear { cleared in
            guard cleared, CalendarStore.readLive()?.generation == active.generation else {
              self.finishArming(false, active.generation, promise)
              return
            }
            CalendarAlerts.arm(active.generation) { ok in
              if ok {
                self.admitted = instance
                WidgetCenter.shared.reloadAllTimelines()
              }
              self.finishArming(ok, active.generation, promise)
            }
          }
        } else {
          self.clean { ok in
            if ok && CalendarStore.isInstance(instance) { self.admitted = instance }
            promise.resolve(ok)
          }
        }
      }
    }

    AsyncFunction("forget") { (pairing: String, promise: Promise) in
      DispatchQueue.main.async {
        if self.admitted == pairing { self.admitted = nil }
        if let active = CalendarStore.readLive(), active.generation.pairing != pairing {
          promise.resolve(CalendarStore.eraseInactive(pairing))
        } else {
          self.clean { promise.resolve($0) }
        }
      }
    }

    AsyncFunction("clear") { (pairing: String, publication: String, promise: Promise) in
      DispatchQueue.main.async {
        guard self.admitted == pairing else { promise.resolve(false); return }
        self.clean { ok in
          let allowed = ok && self.admitted == pairing
          self.writable = allowed ? publication : nil
          promise.resolve(allowed)
        }
      }
    }

    Function("target") { (pairing: String, generation: String) -> [String: Any]? in
      guard let active = CalendarStore.readLive(), active.generation.pairing == pairing,
            active.generation.id == generation, let event = CalendarStore.widgetOccurrence(active.snapshot),
            event.startMs >= Int64(Date().timeIntervalSince1970 * 1000) else { return nil }
      return ["event": event.eventId, "startMs": NSNumber(value: event.startMs)]
    }

    AsyncFunction("permission") { (promise: Promise) in CalendarAlerts.permission { promise.resolve($0) } }
    AsyncFunction("request") { (promise: Promise) in CalendarAlerts.request { promise.resolve($0) } }
  }

  private func finishArming(_ ok: Bool, _ generation: CalendarStore.Generation, _ promise: Promise) {
    if !ok && CalendarStore.readLive()?.generation == generation {
      clean { _ in promise.resolve(false) }
    } else {
      promise.resolve(ok)
    }
  }

  private func clean(_ completed: @escaping (Bool) -> Void) {
    writable = nil
    let current = UUID()
    clearing = current
    let revoked = CalendarStore.revoke()
    WidgetCenter.shared.reloadAllTimelines()
    CalendarAlerts.clear { cancelled in
      guard self.clearing == current else { completed(false); return }
      let erased = CalendarStore.eraseRecords()
      completed(revoked && cancelled && erased && CalendarStore.finishCleanup())
    }
  }
}
