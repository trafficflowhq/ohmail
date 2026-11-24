package app.ohmail.calendar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CalendarAlertReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != CalendarAlarms.ALERT_ACTION) return
    val pairing = intent.getStringExtra(CalendarAlarms.EXTRA_PAIRING) ?: return
    val generation = intent.getStringExtra(CalendarAlarms.EXTRA_GENERATION) ?: return
    ring(context.applicationContext, CalendarStore.Generation(pairing, generation), System.currentTimeMillis())
  }

  companion object {
    private fun ring(context: Context, generation: CalendarStore.Generation, nowMs: Long) {
      CalendarStore.locked {
        if (!CalendarLive.allows(generation.pairing)) return@locked
        val current = CalendarStore.active(context) ?: return@locked
        if (current.generation != generation) return@locked
        val pairing = generation.pairing
        val record = current.snapshot
        val rang = CalendarRing.decide(pairing, pairing, record, CalendarStore.rung(context, pairing), nowMs) ?: return@locked
        if (!CalendarStore.keepRung(context, pairing, rang.rung)) return@locked
        for (alert in rang.due) CalendarAlertPoster.post(context, pairing, alert)
        CalendarAlarms.arm(context, generation, record.alerts, rang.rung)
      }
    }
  }
}
