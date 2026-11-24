package app.ohmail.calendar

/**
 * HOW AN ALERT SAYS ITS LEAD: the twin of the page's `leadWords` (`packages/client-engine/src/notices/lead.ts`),
 * held to the same table (`packages/client-engine/test/notice-lead-words.json`) on a JVM. An event with a time of
 * day says the largest unit that divides its lead evenly; a whole day says how many days before the day it rings.
 * `count` is null where the words carry no number. Anything that is not a lead has no words. It imports nothing.
 */
internal data class Lead(val word: String, val count: Int?)

internal object LeadWords {
  fun of(leadMin: Int, allDay: Boolean): Lead? {
    if (leadMin < 0 || leadMin > CalendarSnapshot.LEAD_MAX_MIN) return null
    if (allDay) {
      val days = (leadMin + 1439) / 1440
      if (days == 0) return Lead("today", null)
      if (days == 1) return Lead("tomorrow", null)
      return if (days % 7 == 0) Lead("weeks", days / 7) else Lead("days", days)
    }
    if (leadMin == 0) return Lead("now", null)
    if (leadMin % 10_080 == 0) return Lead("weeks", leadMin / 10_080)
    if (leadMin % 1440 == 0) return Lead("days", leadMin / 1440)
    if (leadMin % 60 == 0) return Lead("hours", leadMin / 60)
    return Lead("minutes", leadMin)
  }
}
