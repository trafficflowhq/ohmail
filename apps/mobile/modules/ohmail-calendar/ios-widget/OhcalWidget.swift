import SwiftUI
import WidgetKit

struct CalendarEntry: TimelineEntry {
  let date: Date
  let link: URL?
}

struct CalendarTimeline: TimelineProvider {
  func placeholder(in context: Context) -> CalendarEntry { CalendarEntry(date: Date(), link: nil) }

  func getSnapshot(in context: Context, completion: @escaping (CalendarEntry) -> Void) {
    completion(placeholder(in: context))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CalendarEntry>) -> Void) {
    let now = Date()
    let next = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))
    let entry = CalendarEntry(date: now, link: CalendarStore.widgetLink())
    completion(Timeline(entries: [entry], policy: next.map { .after($0) } ?? .atEnd))
  }
}

struct CalendarDateView: View {
  @Environment(\.redactionReasons) private var redaction
  let entry: CalendarEntry

  var body: some View {
    if #available(iOS 17.0, *) {
      date.containerBackground(for: .widget) { Color.clear }
    } else {
      date
    }
  }

  private var date: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(entry.date, format: .dateTime.weekday(.wide))
      Text(entry.date, format: .dateTime.day()).font(.title.bold())
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding()
    .unredacted()
    .widgetURL(redaction.isEmpty ? entry.link : nil)
  }
}

struct CalendarDateWidget: Widget {
  let kind: String
  let title: String
  let family: WidgetFamily

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CalendarTimeline()) { CalendarDateView(entry: $0) }
      .configurationDisplayName(CalendarWords.widget(title)).supportedFamilies([family])
  }
}

@main struct OhcalWidgets: WidgetBundle {
  var body: some Widget {
    CalendarDateWidget(kind: "ohcal.next", title: "calendar", family: .systemSmall)
    CalendarDateWidget(kind: "ohcal.month", title: "month", family: .systemSmall)
    CalendarDateWidget(kind: "ohcal.today", title: "today", family: .systemMedium)
    CalendarDateWidget(kind: "ohcal.week", title: "week", family: .systemMedium)
  }
}
