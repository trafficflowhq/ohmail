package app.ohmail.calendar

/**
 * A RINGER'S BOOK, AS THE PAGE KEEPS IT: the twin of `AlertBook` and `mayRing` (`packages/client-engine/src/
 * notices/ring.ts`), held to the same table of cases (`packages/client-engine/test/notice-ring-cases.json`) on a JVM.
 * One set, replaced whole; what has rung of it; asked under another account or under nobody it drops everything,
 * so nothing set under the account left waits to fire. An alert rings once, at or after its minute, and never
 * later than [LATE_MS] after it. On the phone a set's account is named by its pairing (the one the notices' module
 * keeps as the signed-in one). It keeps no timer and imports nothing.
 */
internal class CalendarBook {
  private var scope: String? = null
  private var alerts: List<Ahead> = emptyList()
  private val rung = LinkedHashMap<String, Long>()

  /** Take a set whole: the one before is gone; another account's set also forgets what was rung for the one before. */
  fun set(scope: String, alerts: List<Ahead>) {
    if (CalendarSnapshot.scopeOf(scope) == null || !sound(alerts)) {
      clear()
      return
    }
    if (this.scope != null && this.scope != scope) rung.clear()
    this.scope = scope
    this.alerts = alerts.toList()
  }

  /** Nothing is held and nothing rings: a sign-out, a switch. */
  fun clear() {
    scope = null
    alerts = emptyList()
    rung.clear()
  }

  fun scope(): String? = scope

  /** What has rung of the set held, by id: kept beside the record so that a set handed again does not ring twice. */
  fun rung(): Set<String> = rung.keys.toSet()

  /** The minute of the next alert not yet asked for, or null when there is none to wake for. */
  fun nextAtMs(): Long? {
    if (scope == null) return null
    return alerts.firstOrNull { it.id !in rung }?.atMs
  }

  /**
   * The alerts that ring now under the account `live`, in the set's order, each once. Asked under another account
   * or under nobody the book drops its set and answers nothing. An alert whose minute passed too long ago is never
   * rung, now or later.
   */
  fun due(live: String?, nowMs: Long): List<Ahead> {
    val held = scope ?: return emptyList()
    if (live != held) {
      clear()
      return emptyList()
    }
    val standing = alerts.map { it.id }.toSet()
    rung.entries.removeAll { (id, atMs) -> nowMs - atMs > LATE_MS && id !in standing }
    val out = ArrayList<Ahead>()
    for (alert in alerts) {
      if (alert.atMs > nowMs) break
      if (alert.id in rung) continue
      rung[alert.id] = alert.atMs
      if (mayRing(alert, nowMs, live)) out.add(alert)
    }
    return out
  }

  /** The set held was made under `live`, the alert stands in it at the same minute, and its minute has come, not too long ago. */
  private fun mayRing(alert: Ahead, nowMs: Long, live: String?): Boolean {
    val held = scope ?: return false
    if (CalendarSnapshot.scopeOf(live) == null || held != live) return false
    val standing = alerts.firstOrNull { it.id == alert.id } ?: return false
    if (standing.atMs != alert.atMs) return false
    return nowMs >= alert.atMs && nowMs - alert.atMs <= LATE_MS
  }

  /** The set's own rules, as `readAheadSet` reads them: at most the bound, ascending, each id once. */
  private fun sound(alerts: List<Ahead>): Boolean {
    if (alerts.size > CalendarSnapshot.AHEAD_MAX) return false
    val ids = HashSet<String>()
    for (i in alerts.indices) if (!ids.add(alerts[i].id) || (i > 0 && alerts[i - 1].atMs > alerts[i].atMs)) return false
    return true
  }

  companion object {
    /** How late an alert may still ring: the page's `AHEAD_LATE_MS`. */
    const val LATE_MS = 120_000L

    /** A book as it stood: the record's set, and what had rung of it. */
    fun restore(scope: String, alerts: List<Ahead>, rung: Collection<String>): CalendarBook {
      val book = CalendarBook()
      book.set(scope, alerts)
      if (book.scope == null) return book
      for (id in rung) {
        // The persisted id ends in the alert's start and lead. Recover the time without changing the file.
        val lead = id.substringAfterLast('.').toIntOrNull() ?: continue
        val start = id.substringBeforeLast('.').substringAfterLast('.').toLongOrNull() ?: continue
        if (start >= 0 && lead in 0..CalendarSnapshot.LEAD_MAX_MIN) {
          book.rung[id] = start - lead * 60_000L
        }
      }
      return book
    }
  }
}
