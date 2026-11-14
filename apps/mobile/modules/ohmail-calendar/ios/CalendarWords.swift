import Foundation

/**
 * THE CALENDAR'S WORDS ON THE iPHONE, one for one the catalogue's (`packages/app/messages/frame.*.json`,
 * `frame.systemNotice.alert*`; the widget's: agenda, calmail, month, calendar and calsettings, as Android's) and the
 * same as Android's string resources; a test holds the table below equal to the
 * catalogue, in both languages. The phone's language picks the table: German where it comes first, else English.
 * Every sentence is whole; a number goes into its one place. Foundation only. Written, not compiled here.
 */
enum CalendarWords {
  static let table: [String: [String: String]] = [
    "en": [
      "busy": "Busy",
      "event": "Event",
      "now": "Starts now.",
      "minutes.one": "Starts in one minute.",
      "minutes.other": "Starts in %d minutes.",
      "hours.one": "Starts in one hour.",
      "hours.other": "Starts in %d hours.",
      "days.one": "Starts in one day.",
      "days.other": "Starts in %d days.",
      "weeks.one": "Starts in one week.",
      "weeks.other": "Starts in %d weeks.",
      "today": "Today, all day.",
      "tomorrow": "Tomorrow, all day.",
      "allDays": "In %d days, all day.",
      "allWeeks.one": "In one week, all day.",
      "allWeeks.other": "In %d weeks, all day.",
      "widget.now": "now",
      "widget.until": "until %@",
      "widget.more": "+%d",
      "widget.toAnswer": "To answer",
      "widget.nothing": "Nothing",
      "widget.calendar": "Calendar",
      "widget.month": "Month",
      "widget.today": "Today",
      "widget.week": "Week",
    ],
    "de": [
      "busy": "Belegt",
      "event": "Termin",
      "now": "Beginnt jetzt.",
      "minutes.one": "Beginnt in einer Minute.",
      "minutes.other": "Beginnt in %d Minuten.",
      "hours.one": "Beginnt in einer Stunde.",
      "hours.other": "Beginnt in %d Stunden.",
      "days.one": "Beginnt in einem Tag.",
      "days.other": "Beginnt in %d Tagen.",
      "weeks.one": "Beginnt in einer Woche.",
      "weeks.other": "Beginnt in %d Wochen.",
      "today": "Heute, ganztägig.",
      "tomorrow": "Morgen, ganztägig.",
      "allDays": "In %d Tagen, ganztägig.",
      "allWeeks.one": "In einer Woche, ganztägig.",
      "allWeeks.other": "In %d Wochen, ganztägig.",
      "widget.now": "jetzt",
      "widget.until": "bis %@",
      "widget.more": "+%d",
      "widget.toAnswer": "Zu beantworten",
      "widget.nothing": "Nichts",
      "widget.calendar": "Kalender",
      "widget.month": "Monat",
      "widget.today": "Heute",
      "widget.week": "Woche",
    ],
  ]

  static func language() -> String {
    (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("de") ? "de" : "en"
  }

  private static func word(_ key: String) -> String { table[language()]?[key] ?? table["en"]![key]! }

  private static func counted(_ key: String, _ n: Int) -> String {
    String(format: word(n == 1 ? "\(key).one" : "\(key).other"), n)
  }

  /// A label's words: the title as the record holds it, or the app's word.
  static func title(_ label: CalLabel) -> String {
    switch label.word {
    case "title": return label.text ?? word("event")
    case "busy": return word("busy")
    default: return word("event")
    }
  }

  /// The app's word for an event whose title is not shown.
  static func event() -> String { word("event") }

  /// A widget's word: `now`, `until`, `more`, `toAnswer`, `nothing`, and the four widgets' names.
  static func widget(_ key: String) -> String { word("widget.\(key)") }

  /// The lead's sentence, by the same rule as the page's `leadWords`; nil for what is no lead.
  static func lead(_ leadMin: Int, allDay: Bool) -> String? {
    guard leadMin >= 0, leadMin <= CalendarRecord.leadMaxMin else { return nil }
    if allDay {
      let days = (leadMin + 1439) / 1440
      if days == 0 { return word("today") }
      if days == 1 { return word("tomorrow") }
      return days % 7 == 0 ? counted("allWeeks", days / 7) : String(format: word("allDays"), days)
    }
    if leadMin == 0 { return word("now") }
    if leadMin % 10_080 == 0 { return counted("weeks", leadMin / 10_080) }
    if leadMin % 1440 == 0 { return counted("days", leadMin / 1440) }
    if leadMin % 60 == 0 { return counted("hours", leadMin / 60) }
    return counted("minutes", leadMin)
  }
}
