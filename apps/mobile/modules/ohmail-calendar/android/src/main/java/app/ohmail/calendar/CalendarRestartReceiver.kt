package app.ohmail.calendar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Only the checked application launch may restore a generation after restart or update. */
class CalendarRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    CalendarLive.cancelBeforeAdmission(context.applicationContext)
  }
}
