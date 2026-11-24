import ExpoModulesCore
import UIKit
import UserNotifications

final class CalendarNoticeDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = CalendarNoticeDelegate()

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let request = notification.request
    guard request.identifier.hasPrefix(CalendarAlerts.head) else { return done([.banner, .list, .sound]) }
    done(CalendarAlerts.mayShow(request.content) ? [.banner, .list, .sound] : [])
  }
}

public class CalendarNoticeSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = CalendarNoticeDelegate.shared
    return true
  }
}
