package app.ohmail.calendar

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** The public and private forms always carry the same generic Calendar reminder. */
internal object CalendarAlertPoster {
  /** The channel of the calendar's alerts: the system keeps a person's settings for it under this id. */
  const val CHANNEL_ID = "app.ohmail.calendar.alerts"
  /** The channel, made with the first set that carries an alert: when the person's alerts are on, never at launch. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.ohcal_alert_channel), NotificationManager.IMPORTANCE_HIGH)
    channel.lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
    manager.createNotificationChannel(channel)
  }

  /** A notification's own number for one alert, in the alerts' range: the same alert replaces itself, another stands beside it. */
  fun idOf(alert: Ahead): Int = CalendarClear.IDS.first + (alert.id.hashCode() and 0x7fffffff) % (CalendarClear.IDS.last - CalendarClear.IDS.first + 1)

  /** Draw `alert` for `pairing`. True where the system was handed a notice. */
  fun post(context: Context, pairing: String, alert: Ahead): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    ensureChannel(context)
    val id = idOf(alert)
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val tap = launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE) }
    val calendar = context.getString(R.string.ohcal_alert_channel)
    val hidden = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon)
      .setContentText(calendar)
      .setShowWhen(false)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon)
      .setContentText(calendar)
      .setCategory(NotificationCompat.CATEGORY_EVENT)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(hidden.build())
      .setAutoCancel(true)
      .setShowWhen(false)
    if (tap != null) builder.setContentIntent(tap)
    return try {
      manager.notify(pairing, id, builder.build())
      true
    } catch (e: SecurityException) {
      false
    }
  }
}
