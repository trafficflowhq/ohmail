package app.ohmail.calendar

/**
 * THE CHECK AT FIRING, as a rule over values: what rings when an alarm set for `pairing` fires at `nowMs`. Nothing
 * where the pairing is not the one kept as signed in (the gate's rule) or no record of it reads; else what the
 * ringer's book says is due under the kept pairing, and what has then rung. It imports nothing of Android.
 */
internal object CalendarRing {
  data class Rang(val due: List<Ahead>, val rung: Set<String>)

  /**
   * THE SET, REPLACED WHOLE, AS SLOTS: slot k holds the k-th alert of `alerts` that has not rung and may still
   * ring at `nowMs`; every other slot is empty, so whatever an earlier set put there is taken back.
   */
  fun slots(alerts: List<Ahead>, rung: Set<String>, nowMs: Long, count: Int): List<Ahead?> {
    val ringing = alerts.filter { it.id !in rung && it.atMs >= nowMs - CalendarBook.LATE_MS }
    return (0 until count).map { k -> ringing.getOrNull(k) }
  }

  fun decide(kept: String?, pairing: String, record: Snapshot?, rung: Set<String>, nowMs: Long): Rang? {
    if (!LiveInstanceGate.mayDraw(kept, pairing) || record == null) return null
    val book = CalendarBook.restore(pairing, record.alerts, rung)
    val due = book.due(kept, nowMs)
    return Rang(due, book.rung())
  }
}
