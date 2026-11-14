package app.ohmail.calendar

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * THE ALERTS SET AHEAD ON ANDROID: one system alarm per alert of the set, in a fixed range of slots, so that the
 * whole range is taken back whatever the record on disk still says.
 *
 * A set is REPLACED WHOLE: slot k holds the k-th alert of the new set that has not rung and may still ring; every
 * other slot is cancelled, so an alert missing from the new set is taken back. Each alarm carries the pairing it
 * was set for and nothing else: when it fires, the receiver asks again whether that pairing is the one signed in
 * and what of the set is due ([CalendarAlertReceiver]).
 *
 * THE KIND OF ALARM, by what the platform documents: `setExactAndAllowWhileIdle`, which fires at its minute in
 * Doze too, wherever the app may set exact alarms (below Android 12 always; from 12 on where
 * `canScheduleExactAlarms` says so: the calendar app declares `USE_EXACT_ALARM`, which Android grants a calendar
 * app that shows notifications for upcoming events, and `SCHEDULE_EXACT_ALARM` up to Android 12L); elsewhere
 * `setAndAllowWhileIdle`, which the system may hold back. Never `setAlarmClock`: that is an alarm clock's, and
 * shows one. It logs nothing.
 */
internal object CalendarAlarms {
  /** The slots of the alerts: the set's bound. */
  const val SLOTS = CalendarSnapshot.AHEAD_MAX
  /** What an alarm's intent carries: the pairing it was set for. */
  const val EXTRA_PAIRING = "pairing"
  const val EXTRA_GENERATION = "generation"
  /** The action of an alert's alarm, inside the app. */
  const val ALERT_ACTION = "calendar.alert"

  private fun intent(context: Context): Intent =
    Intent(context, CalendarAlertReceiver::class.java).setAction(ALERT_ACTION).setPackage(context.packageName)

  private fun slot(context: Context, k: Int, generation: CalendarStore.Generation?): PendingIntent? {
    val i = intent(context)
    if (generation == null) {
      return PendingIntent.getBroadcast(context, k, i, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
    }
    i.putExtra(EXTRA_PAIRING, generation.pairing).putExtra(EXTRA_GENERATION, generation.id)
    return PendingIntent.getBroadcast(context, k, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** Whether this app may set an exact alarm now. */
  fun exact(manager: AlarmManager): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()

  /** Set `pairing`'s alerts, replacing whatever was set before in every slot ([CalendarRing.slots]). */
  fun arm(context: Context, generation: CalendarStore.Generation, alerts: List<Ahead>, rung: Set<String>): Boolean {
    val manager = context.getSystemService(AlarmManager::class.java) ?: return false
    val now = System.currentTimeMillis()
    for ((k, alert) in CalendarRing.slots(alerts, rung, now, SLOTS).withIndex()) {
      if (alert == null) {
        cancel(context, manager, k)
        continue
      }
      val pending = slot(context, k, generation) ?: return false
      try {
        if (exact(manager)) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alert.atMs, pending)
        else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alert.atMs, pending)
      } catch (e: SecurityException) {
        // The exact alarm was refused between the question and the call: the plain one.
        try { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alert.atMs, pending) }
        catch (refused: Exception) { return false }
      }
    }
    return true
  }

  /** Take back every alert set, of every pairing: every slot. */
  fun cancelAll(context: Context): Boolean = try {
    val manager = context.getSystemService(AlarmManager::class.java)
    if (manager == null) false else {
      for (k in 0 until SLOTS) cancel(context, manager, k)
      (0 until SLOTS).none { slot(context, it, null) != null }
    }
  } catch (e: Exception) {
    false
  }

  private fun cancel(context: Context, manager: AlarmManager, k: Int) {
    val pending = slot(context, k, null) ?: return
    manager.cancel(pending)
    pending.cancel()
  }
}
