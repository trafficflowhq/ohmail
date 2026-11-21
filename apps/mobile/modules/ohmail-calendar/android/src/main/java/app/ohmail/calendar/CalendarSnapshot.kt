package app.ohmail.calendar

/**
 * THE PAGE'S RECORD FOR THE PHONE, READ CLOSED: the native twin of `readCalendarSnapshot`
 * (`packages/client-engine/src/notices/closed.ts`), held to one table of cases with it
 * (`apps/mobile/test/calendar-snapshot-cases.json`). A record holds exactly its members, each a whole number in its
 * range, a word of its list, an id, a zone's name or a label: a member too many or too few, a word not listed, a
 * number out of range or not whole, and the whole record is refused. What is answered is a copy, a title cleaned
 * once more; the file is written from the copy alone, so it never holds a member that is not listed here. It holds
 * no address, no place, no note, no person, no calendar's or account's name: the record has no member for one.
 * It imports nothing but this module's JSON and title cleaner.
 */
internal data class Label(val word: String, val text: String?)

internal data class Ahead(
  val id: String, val eventId: String, val atMs: Long, val startMs: Long, val allDay: Boolean, val label: Label,
  val leadMin: Int, val acts: List<String>,
)

internal data class NoticeDate(val month: Int, val dom: Int, val dow: Int)

/** A time as numbers; `day` is "today" or "tomorrow" where `date` is null. */
internal data class Clock(val hour: Int, val minute: Int, val day: String?, val date: NoticeDate?)

internal data class SnapEvent(
  val eventId: String, val label: Label, val startMs: Long, val endMs: Long?, val allDay: Boolean, val toAnswer: Boolean,
)

internal data class SnapDay(val year: Int, val date: NoticeDate, val events: List<SnapEvent>, val more: Int)

internal data class SnapMonth(val year: Int, val month: Int, val marked: List<Int>)

internal data class SnapSummary(val atMs: Long, val events: Int, val first: Clock?, val toAnswer: Int)

internal data class Snapshot(
  val scope: String, val writtenAt: Long, val zone: String, val alerts: List<Ahead>, val days: List<SnapDay>,
  val month: SnapMonth, val toAnswer: Int, val summary: SnapSummary?,
) {
  fun hasTitles(): Boolean = alerts.any { it.label.word == "title" } ||
    days.any { day -> day.events.any { it.label.word == "title" } }
}

internal object CalendarSnapshot {
  /** The record's version: `CALENDAR_SNAPSHOT_VERSION`. */
  const val VERSION = 1L
  /** The file's name in the pairing's own folder: the contract's `CALENDAR_SNAPSHOT_FILE`. */
  const val SNAPSHOT_FILE = "ohcal-snapshot.json"
  /** The bounds of the contract (`emitter.ts`, `snapshot.ts`, `kinds.ts`, `shapes.ts`). */
  const val AHEAD_MAX = 64
  const val AHEAD_ID_MAX = 160
  const val DAYS = 3
  const val DAY_EVENTS_MAX = 12
  const val COUNT_MAX = 9999
  const val LEAD_MAX_MIN = 40_320
  const val INSTANT_MAX_MS = 8_640_000_000_000_000L
  private const val TITLE_IN_MAX = 1024
  /** The acts an alert can carry, in their one order: `NOTICE_ACTS`. */
  val ACTS = listOf("join", "again")

  private val ID = Regex("[A-Za-z0-9._:-]{1,128}")
  private val SCOPE = Regex("[A-Za-z0-9._~-]{1,128}")
  private val ZONE = Regex("[A-Za-z0-9_+\\-/]{1,64}")

  /** The record `text` holds, read closed, or null. */
  fun read(text: String): Snapshot? = of(ClosedJson.read(text))

  /** The members of `raw` when it is an object holding exactly `names`; else null. */
  private fun exactly(raw: Any?, vararg names: String): Map<*, *>? {
    if (raw !is Map<*, *> || raw.size != names.size) return null
    for (name in names) if (!raw.containsKey(name)) return null
    return raw
  }

  private fun <T> listOf(raw: Any?, max: Int, one: (Any?) -> T?): List<T>? {
    if (raw !is List<*> || raw.size > max) return null
    val out = ArrayList<T>(raw.size)
    for (item in raw) out.add(one(item) ?: return null)
    return out
  }

  /** A whole number from `min` to `max`, as a page's JSON number reads. */
  private fun whole(raw: Any?, min: Long, max: Long): Long? {
    if (raw !is Double || raw.isNaN() || raw.isInfinite() || raw != Math.floor(raw)) return null
    if (raw < min.toDouble() || raw > max.toDouble()) return null
    return raw.toLong()
  }

  private fun instant(raw: Any?): Long? = whole(raw, 0, INSTANT_MAX_MS)

  private fun flag(raw: Any?): Boolean? = raw as? Boolean

  private fun idOf(raw: Any?): String? = (raw as? String)?.takeIf { ID.matches(it) }

  /** The shortcut is chosen once at publication, rather than recomputed when the widget is tapped. */
  fun widgetOccurrence(snapshot: Snapshot) = snapshot.days.asSequence().flatMap { it.events.asSequence() }
    .filter { it.label.word != "busy" && it.startMs >= snapshot.writtenAt }.minByOrNull { it.startMs }

  fun scopeOf(raw: Any?): String? = (raw as? String)?.takeIf { SCOPE.matches(it) }

  /** An event's label: one of the two closed words alone, or a title with its text, cleaned. */
  fun label(raw: Any?): Label? {
    exactly(raw, "as")?.let { m ->
      val word = m["as"]
      return if (word == "busy" || word == "event") Label(word as String, null) else null
    }
    val m = exactly(raw, "as", "text") ?: return null
    val text = m["text"]
    if (m["as"] != "title" || text !is String || text.length > TITLE_IN_MAX) return null
    return NoticeText.clean(text)?.let { Label("title", it) }
  }

  private fun acts(raw: Any?): List<String>? {
    if (raw !is List<*> || raw.size > ACTS.size) return null
    val acts = ACTS.filter { raw.contains(it) }
    return if (acts.size == raw.size && acts.indices.all { raw[it] == acts[it] }) acts else null
  }

  /** The id of one start and one lead of an event: the page's `aheadIdOf`. */
  fun aheadIdOf(eventId: String, startMs: Long, leadMin: Int): String = "$eventId.$startMs.$leadMin"

  fun ahead(raw: Any?): Ahead? {
    val m = exactly(raw, "id", "eventId", "atMs", "startMs", "allDay", "label", "leadMin", "acts") ?: return null
    val eventId = idOf(m["eventId"]) ?: return null
    val label = label(m["label"]) ?: return null
    val acts = acts(m["acts"]) ?: return null
    val atMs = instant(m["atMs"]) ?: return null
    val startMs = instant(m["startMs"]) ?: return null
    val leadMin = whole(m["leadMin"], 0, LEAD_MAX_MIN.toLong())?.toInt() ?: return null
    val allDay = flag(m["allDay"]) ?: return null
    if (atMs != startMs - leadMin * 60_000L) return null
    val id = aheadIdOf(eventId, startMs, leadMin)
    if (m["id"] != id || id.length > AHEAD_ID_MAX) return null
    return Ahead(id, eventId, atMs, startMs, allDay, label, leadMin, acts)
  }

  /** A set's alerts: at most the bound, ascending by their minute, each id once. One that is none refuses all. */
  fun alerts(raw: Any?): List<Ahead>? {
    val alerts = listOf(raw, AHEAD_MAX, ::ahead) ?: return null
    val ids = HashSet<String>()
    for (i in alerts.indices) {
      if (!ids.add(alerts[i].id) || (i > 0 && alerts[i - 1].atMs > alerts[i].atMs)) return null
    }
    return alerts
  }

  private fun date(raw: Any?): NoticeDate? {
    val m = exactly(raw, "month", "dom", "dow") ?: return null
    val month = whole(m["month"], 1, 12) ?: return null
    val dom = whole(m["dom"], 1, 31) ?: return null
    val dow = whole(m["dow"], 0, 6) ?: return null
    return NoticeDate(month.toInt(), dom.toInt(), dow.toInt())
  }

  private fun clock(raw: Any?): Clock? {
    val m = exactly(raw, "hour", "minute", "day") ?: return null
    val hour = whole(m["hour"], 0, 23)?.toInt() ?: return null
    val minute = whole(m["minute"], 0, 59)?.toInt() ?: return null
    val day = m["day"]
    if (day == "today" || day == "tomorrow") return Clock(hour, minute, day as String, null)
    return date(day)?.let { Clock(hour, minute, null, it) }
  }

  private fun event(raw: Any?): SnapEvent? {
    val m = exactly(raw, "eventId", "label", "startMs", "endMs", "allDay", "toAnswer") ?: return null
    val eventId = idOf(m["eventId"]) ?: return null
    val label = label(m["label"]) ?: return null
    val startMs = instant(m["startMs"]) ?: return null
    val endMs = if (m["endMs"] == ClosedJson.Null) null else (instant(m["endMs"]) ?: return null)
    if (endMs != null && endMs < startMs) return null
    val allDay = flag(m["allDay"]) ?: return null
    val toAnswer = flag(m["toAnswer"]) ?: return null
    return SnapEvent(eventId, label, startMs, endMs, allDay, toAnswer)
  }

  private fun day(raw: Any?): SnapDay? {
    val m = exactly(raw, "year", "date", "events", "more") ?: return null
    val year = whole(m["year"], 1, 9999)?.toInt() ?: return null
    val more = whole(m["more"], 0, COUNT_MAX.toLong())?.toInt() ?: return null
    val date = date(m["date"]) ?: return null
    val events = listOf(m["events"], DAY_EVENTS_MAX, ::event) ?: return null
    return SnapDay(year, date, events, more)
  }

  private fun month(raw: Any?): SnapMonth? {
    val m = exactly(raw, "year", "month", "marked") ?: return null
    val year = whole(m["year"], 1, 9999)?.toInt() ?: return null
    val month = whole(m["month"], 1, 12)?.toInt() ?: return null
    val marked = listOf(m["marked"], 31) { whole(it, 1, 31)?.toInt() } ?: return null
    for (i in 1 until marked.size) if (marked[i - 1] >= marked[i]) return null
    return SnapMonth(year, month, marked)
  }

  private fun summary(raw: Any?): SnapSummary? {
    val m = exactly(raw, "atMs", "events", "first", "toAnswer") ?: return null
    val atMs = instant(m["atMs"]) ?: return null
    val events = whole(m["events"], 0, COUNT_MAX.toLong())?.toInt() ?: return null
    val toAnswer = whole(m["toAnswer"], 0, COUNT_MAX.toLong())?.toInt() ?: return null
    val first = if (m["first"] == ClosedJson.Null) null else (clock(m["first"]) ?: return null)
    return SnapSummary(atMs, events, first, toAnswer)
  }

  /** The record from a parsed value, or null. */
  fun of(raw: Any?): Snapshot? {
    val m = exactly(raw, "v", "scope", "writtenAt", "zone", "alerts", "days", "month", "toAnswer", "summary") ?: return null
    if (m["v"] != VERSION.toDouble()) return null
    val scope = scopeOf(m["scope"]) ?: return null
    val writtenAt = instant(m["writtenAt"]) ?: return null
    val zone = (m["zone"] as? String)?.takeIf { ZONE.matches(it) } ?: return null
    val alerts = alerts(m["alerts"]) ?: return null
    val days = listOf(m["days"], DAYS, ::day) ?: return null
    val month = month(m["month"]) ?: return null
    val toAnswer = whole(m["toAnswer"], 0, COUNT_MAX.toLong())?.toInt() ?: return null
    val summary = if (m["summary"] == ClosedJson.Null) null else (summary(m["summary"]) ?: return null)
    return Snapshot(scope, writtenAt, zone, alerts, days, month, toAnswer, summary)
  }

  // ── The one form the file is written in: the copy's members, in the record's own order ──────────────────────────

  private fun labelOut(l: Label): Map<String, Any> =
    if (l.text == null) linkedMapOf("as" to l.word) else linkedMapOf("as" to "title", "text" to l.text)

  private fun dateOut(d: NoticeDate): Map<String, Any> = linkedMapOf("month" to d.month, "dom" to d.dom, "dow" to d.dow)

  private fun clockOut(c: Clock): Map<String, Any> =
    linkedMapOf("hour" to c.hour, "minute" to c.minute, "day" to (c.day ?: dateOut(c.date!!)))

  fun aheadOut(a: Ahead): Map<String, Any> = linkedMapOf(
    "id" to a.id, "eventId" to a.eventId, "atMs" to a.atMs, "startMs" to a.startMs, "allDay" to a.allDay,
    "label" to labelOut(a.label), "leadMin" to a.leadMin, "acts" to a.acts,
  )

  /** The copy as the text the file holds. */
  fun write(s: Snapshot): String = ClosedJson.write(linkedMapOf(
    "v" to VERSION, "scope" to s.scope, "writtenAt" to s.writtenAt, "zone" to s.zone,
    "alerts" to s.alerts.map(::aheadOut),
    "days" to s.days.map { d ->
      linkedMapOf(
        "year" to d.year, "date" to dateOut(d.date),
        "events" to d.events.map { e ->
          linkedMapOf(
            "eventId" to e.eventId, "label" to labelOut(e.label), "startMs" to e.startMs,
            "endMs" to (e.endMs ?: ClosedJson.Null), "allDay" to e.allDay, "toAnswer" to e.toAnswer,
          )
        },
        "more" to d.more,
      )
    },
    "month" to linkedMapOf("year" to s.month.year, "month" to s.month.month, "marked" to s.month.marked),
    "toAnswer" to s.toAnswer,
    "summary" to (s.summary?.let { linkedMapOf(
      "atMs" to it.atMs, "events" to it.events, "first" to (it.first?.let(::clockOut) ?: ClosedJson.Null),
      "toAnswer" to it.toAnswer,
    ) } ?: ClosedJson.Null),
  ))
}
