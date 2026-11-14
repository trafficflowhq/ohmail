package app.ohmail.calendar

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import java.util.UUID

/** The revoked marker remains on disk until a complete replacement is published. Launch retries cleanup from it. */
internal object CalendarLive {
  private var admitted: String? = null
  private var writable: String? = null

  fun told(context: Context, instance: String?): Boolean = CalendarStore.locked {
    admitted = null
    writable = null
    if (!LiveInstanceGate.isInstance(instance)) return@locked clean(context)
    val current = CalendarStore.active(context)
    if (current != null && current.generation.pairing == instance) {
      val restored = CalendarAlarms.arm(context, current.generation, current.snapshot.alerts, CalendarStore.rung(context, current.generation.pairing)) &&
        CalendarWidgets.redrawAll(context)
      if (!restored) {
        clean(context)
        return@locked false
      }
    } else if (!clean(context)) return@locked false
    admitted = instance
    true
  }

  fun cancelBeforeAdmission(context: Context) = CalendarStore.locked {
    if (admitted == null) CalendarAlarms.cancelAll(context)
  }

  fun allows(pairing: String): Boolean = CalendarStore.locked { admitted == pairing }

  fun redrawAdmitted(context: Context) = CalendarStore.locked {
    if (admitted != null) CalendarWidgets.redrawAll(context)
  }

  fun forget(context: Context, pairing: String): Boolean = CalendarStore.locked {
    if (admitted == pairing) {
      admitted = null
      writable = null
    }
    val current = CalendarStore.generation(context)
    if (current != null && current.pairing != pairing) CalendarStore.forgetPairing(context, pairing)
    else clean(context)
  }

  fun clear(context: Context, pairing: String, publication: String): Boolean = CalendarStore.locked {
    if (admitted != pairing) return@locked false
    writable = null
    if (!clean(context, pairing)) return@locked false
    writable = publication
    true
  }

  private fun clean(context: Context, keepRung: String? = null): Boolean {
    val revoked = CalendarStore.revoke(context)
    val alarms = CalendarAlarms.cancelAll(context)
    val notices = closeShown(context)
    val widgets = CalendarWidgets.redrawAll(context, showTarget = false)
    val erased = if (keepRung == null) CalendarStore.forgetAllBut(context, null)
      else CalendarStore.forgetSnapshot(context, keepRung)
    return revoked && alarms && notices && widgets && erased
  }

  fun keep(context: Context, pairing: String, snapshot: Snapshot, publication: String?): Boolean = CalendarStore.locked {
    if (admitted != pairing || publication == null || writable != publication) return@locked false
    writable = null
    val generation = CalendarStore.Generation(pairing, UUID.randomUUID().toString())
    val published = try {
      CalendarStore.write(context, pairing, snapshot) &&
        CalendarWidgets.redrawAll(context, proposed = generation) &&
        CalendarAlarms.arm(context, generation, snapshot.alerts, CalendarStore.rung(context, pairing)) &&
        CalendarStore.activate(context, generation)
    } catch (e: Exception) {
      false
    }
    if (!published) clean(context, pairing)
    published
  }

  private fun closeShown(context: Context): Boolean = try {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager == null) false else {
      val shown = manager.activeNotifications.map {
        Triple(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) it.notification.channelId else null, it.tag, it.id)
      }
      for ((tag, id) in CalendarClear.closing(shown, CalendarAlertPoster.CHANNEL_ID, null)) manager.cancel(tag, id)
      CalendarClear.closing(manager.activeNotifications.map {
        Triple(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) it.notification.channelId else null, it.tag, it.id)
      }, CalendarAlertPoster.CHANNEL_ID, null).isEmpty()
    }
  } catch (e: Exception) {
    false
  }
}
