package app.ohmail.calendar

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OhmailCalendarModule : Module() {
  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("OhmailCalendar")

    AsyncFunction("keep") { pairing: String, record: String, publication: String? ->
      val ctx = context ?: return@AsyncFunction false
      val snapshot = CalendarSnapshot.read(record) ?: return@AsyncFunction false
      CalendarLive.keep(ctx, pairing, snapshot, publication)
    }

    Function("recordPath") { pairing: String ->
      context?.let { CalendarStore.recordPath(it, pairing) } ?: ""
    }

    AsyncFunction("setLive") { instance: String? ->
      context?.let { CalendarLive.told(it, instance) } ?: false
    }

    AsyncFunction("clear") { instance: String, publication: String ->
      context?.let { CalendarLive.clear(it, instance, publication) } ?: false
    }

    AsyncFunction("forget") { instance: String ->
      context?.let { CalendarLive.forget(it, instance) } ?: false
    }

    Function("target") { pairing: String, generation: String ->
      val active = context?.let { CalendarStore.active(it) } ?: return@Function null
      if (active.generation.pairing != pairing || active.generation.id != generation) return@Function null
      val event = CalendarSnapshot.widgetOccurrence(active.snapshot) ?: return@Function null
      if (event.startMs < System.currentTimeMillis()) return@Function null
      mapOf("event" to event.eventId, "startMs" to event.startMs.toDouble())
    }
  }
}
