package app.ohmail.calendar

import java.util.Calendar
import java.util.TimeZone

/**
 * WHAT THE CALENDAR APP'S WIDGETS SHOW, as values: the four the studio's widgets screen draws (Small Next, Small
 * Month, Medium Today, Medium Week), from the signed-in pairing's record alone and the clock, in the record's own
 * zone. Which days, which lines, which counts; the words are the drawer's. With no record (nobody signed in, a file
 * of another version, one that does not read) each widget is its EMPTY form: the date and nothing of any account.
 *
 *  · Next: today's weekday and date; what is on now and until when, then the next; nothing left: the word for it.
 *    The open dot while something waits for an answer.
 *  · Month: the month's name and its grid: today, and the days that hold something.
 *  · Today: the weekday and the date; three rows (now, or the time), then how many more.
 *  · Week: the seven dates of today's week, from Monday, each marked where it holds something; the next event (today
 *    or a later day of the record, with its day), then how many wait for an answer, or the one after.
 *
 * Plain `java.util` dates, which every Android the app runs on has. It imports nothing of Android.
 */
internal object WidgetModel {
  /** A day: `dow` counts from Sunday as 0, as the record's days do. */
  data class Day(val year: Int, val month: Int, val dom: Int, val dow: Int)

  /** One row: the event, its label, "now" or its start, until when (now only), and a later day's weekday. */
  data class Row(val eventId: String, val label: Label, val now: Boolean, val startMs: Long, val untilMs: Long?, val dow: Int?)

  data class Next(val day: Day, val open: Boolean, val on: Row?, val next: Row?, val nothing: Boolean)
  /** `firstDow`: the column of the month's first day, Monday 0. */
  data class Month(val year: Int, val month: Int, val today: Int, val marked: List<Int>, val firstDow: Int, val days: Int)
  data class Today(val day: Day, val rows: List<Row>, val more: Int, val nothing: Boolean)
  data class WeekDay(val day: Day, val today: Boolean, val marked: Boolean)
  data class Week(val days: List<WeekDay>, val next: Row?, val toAnswer: Int, val after: Row?, val nothing: Boolean)

  /** The zone the record laid its days out in; the phone's own where there is no record or it names none known. */
  fun zoneOf(record: Snapshot?, fallback: TimeZone): TimeZone {
    val id = record?.zone ?: return fallback
    val zone = TimeZone.getTimeZone(id)
    return if (zone.id == id) zone else fallback
  }

  private fun calendar(ms: Long, zone: TimeZone): Calendar = Calendar.getInstance(zone).apply { timeInMillis = ms }

  fun dayOf(ms: Long, zone: TimeZone): Day {
    val c = calendar(ms, zone)
    return Day(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH), c.get(Calendar.DAY_OF_WEEK) - 1)
  }

  /** The day `days` after `day`'s noon: safe across a change of the clocks. */
  private fun plus(day: Day, days: Int, zone: TimeZone): Day {
    val c = Calendar.getInstance(zone).apply { clear(); set(day.year, day.month - 1, day.dom, 12, 0) }
    c.add(Calendar.DAY_OF_MONTH, days)
    return Day(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH), c.get(Calendar.DAY_OF_WEEK) - 1)
  }

  /** The record's day for `day`, if it holds one. */
  private fun recordDay(record: Snapshot?, day: Day): SnapDay? =
    record?.days?.firstOrNull { it.year == day.year && it.date.month == day.month && it.date.dom == day.dom }

  private fun timed(day: SnapDay?): List<SnapEvent> = day?.events?.filter { !it.allDay } ?: emptyList()

  private fun onNow(events: List<SnapEvent>, nowMs: Long): SnapEvent? =
    events.firstOrNull { it.startMs <= nowMs && (it.endMs ?: it.startMs) > nowMs }

  private fun row(e: SnapEvent, now: Boolean, dow: Int? = null) = Row(e.eventId, e.label, now, e.startMs, if (now) e.endMs else null, dow)

  fun next(record: Snapshot?, nowMs: Long, fallback: TimeZone): Next {
    val zone = zoneOf(record, fallback)
    val today = dayOf(nowMs, zone)
    if (record == null) return Next(today, false, null, null, false)
    val events = timed(recordDay(record, today))
    val on = onNow(events, nowMs)
    val next = events.firstOrNull { it.startMs > nowMs }
    return Next(today, record.toAnswer > 0, on?.let { row(it, true) }, next?.let { row(it, false) }, on == null && next == null)
  }

  fun month(record: Snapshot?, nowMs: Long, fallback: TimeZone): Month {
    val zone = zoneOf(record, fallback)
    val today = dayOf(nowMs, zone)
    val first = Calendar.getInstance(zone).apply { clear(); set(today.year, today.month - 1, 1, 12, 0) }
    val marked = record?.month?.takeIf { it.year == today.year && it.month == today.month }?.marked ?: emptyList()
    return Month(today.year, today.month, today.dom, marked, (first.get(Calendar.DAY_OF_WEEK) + 5) % 7, first.getActualMaximum(Calendar.DAY_OF_MONTH))
  }

  fun today(record: Snapshot?, nowMs: Long, fallback: TimeZone): Today {
    val zone = zoneOf(record, fallback)
    val day = dayOf(nowMs, zone)
    if (record == null) return Today(day, emptyList(), 0, false)
    val held = recordDay(record, day)
    val events = timed(held)
    val on = onNow(events, nowMs)
    val rows = (listOfNotNull(on) + events.filter { it.startMs > nowMs }).map { row(it, it === on) }
    val more = (rows.size - minOf(rows.size, 3) + (held?.more ?: 0)).coerceAtMost(CalendarSnapshot.COUNT_MAX)
    return Today(day, rows.take(3), more, rows.isEmpty())
  }

  fun week(record: Snapshot?, nowMs: Long, fallback: TimeZone): Week {
    val zone = zoneOf(record, fallback)
    val today = dayOf(nowMs, zone)
    val monday = plus(today, -((today.dow + 6) % 7), zone)
    val marked = record?.month?.takeIf { it.year == today.year && it.month == today.month }?.marked ?: emptyList()
    val days = (0 until 7).map { i ->
      val d = plus(monday, i, zone)
      WeekDay(d, d == today, d.year == today.year && d.month == today.month && d.dom in marked)
    }
    if (record == null) return Week(days, null, 0, null, false)
    val ahead = timed(recordDay(record, today)).filter { it.startMs > nowMs }
    val next = ahead.firstOrNull()?.let { row(it, false) } ?: (1..2).asSequence().mapNotNull { i ->
      val d = plus(today, i, zone)
      timed(recordDay(record, d)).firstOrNull()?.let { row(it, false, d.dow) }
    }.firstOrNull()
    val after = if (record.toAnswer > 0) null else ahead.getOrNull(1)?.let { row(it, false) }
    return Week(days, next, record.toAnswer, after, next == null)
  }

  /** The next moment what a widget shows changes: an event's start or end ahead, else the next midnight. */
  fun nextBoundaryMs(record: Snapshot?, nowMs: Long, fallback: TimeZone): Long {
    val zone = zoneOf(record, fallback)
    val today = dayOf(nowMs, zone)
    val midnight = Calendar.getInstance(zone).apply { clear(); set(today.year, today.month - 1, today.dom, 0, 0) }
      .apply { add(Calendar.DAY_OF_MONTH, 1) }.timeInMillis
    val edges = record?.days?.flatMap { d -> d.events.filter { !it.allDay }.flatMap { listOfNotNull(it.startMs, it.endMs) } } ?: emptyList()
    return (edges.filter { it > nowMs } + midnight).minOrNull() ?: midnight
  }

  /** A start's hour and minute in the record's zone. */
  fun hourMinute(ms: Long, record: Snapshot?, fallback: TimeZone): Pair<Int, Int> {
    val c = calendar(ms, zoneOf(record, fallback))
    return c.get(Calendar.HOUR_OF_DAY) to c.get(Calendar.MINUTE)
  }
}
