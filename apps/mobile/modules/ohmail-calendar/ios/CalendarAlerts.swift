import Foundation
import UserNotifications

enum CalendarAlerts {
  static let head = "ohcal.alert."
  static let pendingMax = 64
  private static var jobs: [(@escaping () -> Void) -> Void] = []

  private static func serialize(_ job: @escaping (@escaping () -> Void) -> Void) {
    DispatchQueue.main.async {
      jobs.append(job)
      if jobs.count == 1 { runNext() }
    }
  }

  private static func runNext() {
    guard let job = jobs.first else { return }
    job {
      DispatchQueue.main.async {
        jobs.removeFirst()
        runNext()
      }
    }
  }

  private static func ours(_ ids: [String]) -> [String] { ids.filter { $0.hasPrefix(head) } }

  /// Revoke happens in the store first. The system queues are then cleared and read back.
  static func clear(_ completed: @escaping (Bool) -> Void) {
    serialize { next in
      let center = UNUserNotificationCenter.current()
      center.getPendingNotificationRequests { pending in
        center.removePendingNotificationRequests(withIdentifiers: ours(pending.map { $0.identifier }))
        center.getDeliveredNotifications { shown in
          center.removeDeliveredNotifications(withIdentifiers: ours(shown.map { $0.request.identifier }))
          center.getPendingNotificationRequests { remaining in
            center.getDeliveredNotifications { visible in
              DispatchQueue.main.async {
                completed(ours(remaining.map { $0.identifier }).isEmpty &&
                  ours(visible.map { $0.request.identifier }).isEmpty)
                next()
              }
            }
          }
        }
      }
    }
  }

  static func arm(_ expected: CalendarStore.Generation, _ completed: @escaping (Bool) -> Void) {
    serialize { next in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        DispatchQueue.main.async {
          guard let active = CalendarStore.readLive(), active.generation == expected else {
            completed(false); next(); return
          }
          let enabled = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional ||
            settings.authorizationStatus == .ephemeral
          if !enabled { completed(true); next(); return }
          let now = Int64(Date().timeIntervalSince1970 * 1000)
          let pending = active.snapshot.alerts.filter { $0.atMs > now }.prefix(pendingMax)
          let group = DispatchGroup()
          var ok = true
          for (index, alert) in pending.enumerated() {
            guard CalendarStore.readLive()?.generation == expected else { ok = false; break }
            let content = UNMutableNotificationContent()
            content.body = CalendarWords.widget("calendar")
            content.sound = .default
            content.userInfo = ["generation": expected.id]
            let at = Date(timeIntervalSince1970: TimeInterval(alert.atMs) / 1000)
            var parts = Calendar(identifier: .gregorian).dateComponents(in: TimeZone(secondsFromGMT: 0)!, from: at)
            parts.nanosecond = nil
            let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            group.enter()
            let identifier = head + expected.id + "." + String(index)
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)) { error in
              DispatchQueue.main.async {
                if error != nil { ok = false }
                group.leave()
              }
            }
          }
          group.notify(queue: .main) {
            completed(ok && CalendarStore.readLive()?.generation == expected)
            next()
          }
        }
      }
    }
  }

  static func mayShow(_ content: UNNotificationContent) -> Bool {
    guard let generation = content.userInfo["generation"] as? String else { return false }
    return CalendarStore.readLive()?.generation.id == generation
  }

  static func permission(_ done: @escaping (String) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral: done("granted")
      case .denied: done("denied")
      default: done("default")
      }
    }
  }

  static func request(_ done: @escaping (String) -> Void) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
      done(granted ? "granted" : "denied")
    }
  }
}
