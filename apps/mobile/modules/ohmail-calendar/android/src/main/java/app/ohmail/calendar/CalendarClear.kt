package app.ohmail.calendar

/**
 * WHAT LEAVING A PAIRING CLOSES OF THE CALENDAR'S ALERTS, as a rule over values. Of the notifications the app shows,
 * by channel, tag and id: every calendar alert that is not the pairing kept now's (with none kept, every one). An
 * alert is the calendar's by its channel, or below Android 8, which has no channels, by its tag being a pairing's id
 * and its id lying in the alerts' own range. Nothing else is chosen: mail's notices and the organizing notice stay.
 * It imports nothing of Android.
 */
internal object CalendarClear {
  /** The ids an alert's notification takes: [CalendarAlertPoster.idOf]. */
  val IDS = 10_000 until 1_010_000

  fun closing(shown: List<Triple<String?, String?, Int>>, channel: String, keep: String?): List<Pair<String?, Int>> =
    shown.filter { (on, tag, id) ->
      val ours = on == channel || (on == null && LiveInstanceGate.isInstance(tag) && id in IDS)
      ours && tag != keep
    }.map { (_, tag, id) -> tag to id }
}
