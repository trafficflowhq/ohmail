import Foundation

/**
 * THE PAGE'S RECORD FOR THE PHONE, READ CLOSED (iOS): the twin of `readCalendarSnapshot`
 * (`packages/client-engine/src/notices/closed.ts`) and of Android's `CalendarSnapshot.kt`, held to the same rules
 * and the same table of cases (`apps/mobile/test/calendar-snapshot-cases.json`). A record holds exactly its
 * members, each a whole number in its range, a word of its list, an id, a zone's name or a label: anything else and
 * the whole record is refused. What is answered is a copy, a title cleaned once more; the file is written from the
 * copy alone. Foundation only, so the widget's extension compiles the same file. Written, not compiled here.
 */
struct CalLabel: Equatable { let word: String; let text: String? }

struct CalAhead: Equatable {
  let id: String; let eventId: String; let atMs: Int64; let startMs: Int64; let allDay: Bool; let label: CalLabel
  let leadMin: Int; let acts: [String]
}

struct CalDate: Equatable { let month: Int; let dom: Int; let dow: Int }

/// A time as numbers; `day` is "today" or "tomorrow" where `date` is nil.
struct CalClock: Equatable { let hour: Int; let minute: Int; let day: String?; let date: CalDate? }

struct CalEvent: Equatable {
  let eventId: String; let label: CalLabel; let startMs: Int64; let endMs: Int64?; let allDay: Bool; let toAnswer: Bool
}

struct CalDay: Equatable { let year: Int; let date: CalDate; let events: [CalEvent]; let more: Int }

struct CalMonth: Equatable { let year: Int; let month: Int; let marked: [Int] }

struct CalSummary: Equatable { let atMs: Int64; let events: Int; let first: CalClock?; let toAnswer: Int }

struct CalSnapshot: Equatable {
  let scope: String; let writtenAt: Int64; let zone: String; let alerts: [CalAhead]; let days: [CalDay]
  let month: CalMonth; let toAnswer: Int; let summary: CalSummary?

  var hasTitles: Bool {
    alerts.contains { $0.label.word == "title" } || days.contains { day in day.events.contains { $0.label.word == "title" } }
  }
}

enum CalendarRecord {
  static let version = 1
  /// The contract's `CALENDAR_SNAPSHOT_FILE`.
  static let fileName = "ohcal-snapshot.json"
  static let aheadMax = 64, aheadIdMax = 160, days = 3, dayEventsMax = 12, countMax = 9999, leadMaxMin = 40_320
  static let instantMaxMs: Int64 = 8_640_000_000_000_000
  /// The longest text read: far past the largest record a page writes.
  static let most = 262_144
  static let acts = ["join", "again"]
  private static let titleInMax = 1024

  /// The record `data` holds, read closed, or nil.
  static func read(_ data: Data) -> CalSnapshot? {
    guard data.count <= most, let raw = try? JSONSerialization.jsonObject(with: data, options: []) else { return nil }
    return of(raw)
  }

  // ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────

  private static func isFlag(_ raw: Any?) -> Bool {
    guard let n = raw as? NSNumber else { return false }
    return CFGetTypeID(n as CFTypeRef) == CFBooleanGetTypeID()
  }

  private static func flag(_ raw: Any?) -> Bool? { isFlag(raw) ? (raw as! NSNumber).boolValue : nil }

  /// A whole number from `min` to `max`, as the page's JSON reads numbers: one double.
  private static func whole(_ raw: Any?, _ min: Int64, _ max: Int64) -> Int64? {
    guard let n = raw as? NSNumber, !isFlag(raw) else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(.down), d >= Double(min), d <= Double(max) else { return nil }
    return Int64(d)
  }

  private static func instant(_ raw: Any?) -> Int64? { whole(raw, 0, instantMaxMs) }

  private static func isNull(_ raw: Any?) -> Bool { raw is NSNull }

  private static func ascii(_ raw: Any?, _ most: Int, _ allowed: String) -> String? {
    guard let s = raw as? String, !s.isEmpty, s.utf16.count <= most else { return nil }
    for u in s.unicodeScalars {
      let v = u.value
      let alnum = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122)
      if !alnum && !allowed.unicodeScalars.contains(u) { return nil }
    }
    return s
  }

  private static func idOf(_ raw: Any?) -> String? { ascii(raw, 128, "._:-") }

  static func scopeOf(_ raw: Any?) -> String? { ascii(raw, 128, "._~-") }

  private static func zoneOf(_ raw: Any?) -> String? { ascii(raw, 64, "_+-/") }

  private static func exactly(_ raw: Any?, _ names: [String]) -> [String: Any]? {
    guard let m = raw as? [String: Any], m.count == names.count else { return nil }
    for name in names where m[name] == nil { return nil }
    return m
  }

  private static func list<T>(_ raw: Any?, _ max: Int, _ one: (Any?) -> T?) -> [T]? {
    guard let items = raw as? [Any], items.count <= max else { return nil }
    var out: [T] = []
    for item in items {
      guard let read = one(item) else { return nil }
      out.append(read)
    }
    return out
  }

  // ── The record ────────────────────────────────────────────────────────────────────────────────────────────────

  /// An event's label: one of the two closed words alone, or a title with its text, cleaned.
  static func label(_ raw: Any?) -> CalLabel? {
    if let m = exactly(raw, ["as"]) {
      guard let word = m["as"] as? String, word == "busy" || word == "event" else { return nil }
      return CalLabel(word: word, text: nil)
    }
    guard let m = exactly(raw, ["as", "text"]), (m["as"] as? String) == "title", let text = m["text"] as? NSString,
          text.length <= titleInMax, let clean = NoticeText.clean(text) else { return nil }
    return CalLabel(word: "title", text: clean)
  }

  private static func actsOf(_ raw: Any?) -> [String]? {
    guard let items = raw as? [Any], items.count <= acts.count else { return nil }
    let words = items.compactMap { $0 as? String }
    guard words.count == items.count else { return nil }
    let ordered = acts.filter { words.contains($0) }
    return ordered == words ? ordered : nil
  }

  /// The page's `aheadIdOf`.
  static func aheadId(_ eventId: String, _ startMs: Int64, _ leadMin: Int) -> String { "\(eventId).\(startMs).\(leadMin)" }

  static func ahead(_ raw: Any?) -> CalAhead? {
    guard let m = exactly(raw, ["id", "eventId", "atMs", "startMs", "allDay", "label", "leadMin", "acts"]),
          let eventId = idOf(m["eventId"]), let label = label(m["label"]), let acts = actsOf(m["acts"]),
          let atMs = instant(m["atMs"]), let startMs = instant(m["startMs"]),
          let lead = whole(m["leadMin"], 0, Int64(leadMaxMin)), let allDay = flag(m["allDay"]) else { return nil }
    let leadMin = Int(lead)
    guard atMs == startMs - Int64(leadMin) * 60_000 else { return nil }
    let id = aheadId(eventId, startMs, leadMin)
    guard (m["id"] as? String) == id, id.utf16.count <= aheadIdMax else { return nil }
    return CalAhead(id: id, eventId: eventId, atMs: atMs, startMs: startMs, allDay: allDay, label: label, leadMin: leadMin, acts: acts)
  }

  static func alerts(_ raw: Any?) -> [CalAhead]? {
    guard let alerts = list(raw, aheadMax, ahead) else { return nil }
    var ids = Set<String>()
    for (i, a) in alerts.enumerated() {
      guard ids.insert(a.id).inserted, i == 0 || alerts[i - 1].atMs <= a.atMs else { return nil }
    }
    return alerts
  }

  private static func date(_ raw: Any?) -> CalDate? {
    guard let m = exactly(raw, ["month", "dom", "dow"]), let month = whole(m["month"], 1, 12),
          let dom = whole(m["dom"], 1, 31), let dow = whole(m["dow"], 0, 6) else { return nil }
    return CalDate(month: Int(month), dom: Int(dom), dow: Int(dow))
  }

  private static func clock(_ raw: Any?) -> CalClock? {
    guard let m = exactly(raw, ["hour", "minute", "day"]), let hour = whole(m["hour"], 0, 23),
          let minute = whole(m["minute"], 0, 59) else { return nil }
    if let day = m["day"] as? String {
      return day == "today" || day == "tomorrow" ? CalClock(hour: Int(hour), minute: Int(minute), day: day, date: nil) : nil
    }
    guard let d = date(m["day"]) else { return nil }
    return CalClock(hour: Int(hour), minute: Int(minute), day: nil, date: d)
  }

  private static func event(_ raw: Any?) -> CalEvent? {
    guard let m = exactly(raw, ["eventId", "label", "startMs", "endMs", "allDay", "toAnswer"]),
          let eventId = idOf(m["eventId"]), let label = label(m["label"]), let startMs = instant(m["startMs"]),
          let allDay = flag(m["allDay"]), let toAnswer = flag(m["toAnswer"]) else { return nil }
    var endMs: Int64? = nil
    if !isNull(m["endMs"]) {
      guard let end = instant(m["endMs"]), end >= startMs else { return nil }
      endMs = end
    }
    return CalEvent(eventId: eventId, label: label, startMs: startMs, endMs: endMs, allDay: allDay, toAnswer: toAnswer)
  }

  private static func day(_ raw: Any?) -> CalDay? {
    guard let m = exactly(raw, ["year", "date", "events", "more"]), let year = whole(m["year"], 1, 9999),
          let more = whole(m["more"], 0, Int64(countMax)), let date = date(m["date"]),
          let events = list(m["events"], dayEventsMax, event) else { return nil }
    return CalDay(year: Int(year), date: date, events: events, more: Int(more))
  }

  private static func monthOf(_ raw: Any?) -> CalMonth? {
    guard let m = exactly(raw, ["year", "month", "marked"]), let year = whole(m["year"], 1, 9999),
          let month = whole(m["month"], 1, 12),
          let marked = list(m["marked"], 31, { whole($0, 1, 31).map { Int($0) } }) else { return nil }
    for i in marked.indices.dropFirst() where marked[i - 1] >= marked[i] { return nil }
    return CalMonth(year: Int(year), month: Int(month), marked: marked)
  }

  private static func summaryOf(_ raw: Any?) -> CalSummary? {
    guard let m = exactly(raw, ["atMs", "events", "first", "toAnswer"]), let atMs = instant(m["atMs"]),
          let events = whole(m["events"], 0, Int64(countMax)), let toAnswer = whole(m["toAnswer"], 0, Int64(countMax)) else { return nil }
    var first: CalClock? = nil
    if !isNull(m["first"]) {
      guard let c = clock(m["first"]) else { return nil }
      first = c
    }
    return CalSummary(atMs: atMs, events: Int(events), first: first, toAnswer: Int(toAnswer))
  }

  /// The record from a parsed value, or nil.
  static func of(_ raw: Any?) -> CalSnapshot? {
    guard let m = exactly(raw, ["v", "scope", "writtenAt", "zone", "alerts", "days", "month", "toAnswer", "summary"]),
          whole(m["v"], 1, 1) != nil, let scope = scopeOf(m["scope"]), let writtenAt = instant(m["writtenAt"]),
          let zone = zoneOf(m["zone"]), let alerts = alerts(m["alerts"]), let days = list(m["days"], days, day),
          let month = monthOf(m["month"]), let toAnswer = whole(m["toAnswer"], 0, Int64(countMax)) else { return nil }
    var summary: CalSummary? = nil
    if !isNull(m["summary"]) {
      guard let s = summaryOf(m["summary"]) else { return nil }
      summary = s
    }
    return CalSnapshot(scope: scope, writtenAt: writtenAt, zone: zone, alerts: alerts, days: days, month: month,
                       toAnswer: Int(toAnswer), summary: summary)
  }

  // ── The one form the file is written in ─────────────────────────────────────────────────────────────────────

  private static func labelOut(_ l: CalLabel) -> [String: Any] { l.text == nil ? ["as": l.word] : ["as": "title", "text": l.text!] }

  private static func dateOut(_ d: CalDate) -> [String: Any] { ["month": d.month, "dom": d.dom, "dow": d.dow] }

  static func aheadOut(_ a: CalAhead) -> [String: Any] {
    ["id": a.id, "eventId": a.eventId, "atMs": NSNumber(value: a.atMs), "startMs": NSNumber(value: a.startMs),
     "allDay": a.allDay, "label": labelOut(a.label), "leadMin": a.leadMin, "acts": a.acts]
  }

  /// The copy as the data the file holds; members in no fixed order (the reader reads them by name).
  static func write(_ s: CalSnapshot) -> Data? {
    let summary: Any = s.summary.map { su -> [String: Any] in
      let first: Any = su.first.map { c -> [String: Any] in
        ["hour": c.hour, "minute": c.minute, "day": c.day.map { $0 as Any } ?? dateOut(c.date!)]
      } ?? NSNull()
      return ["atMs": NSNumber(value: su.atMs), "events": su.events, "first": first, "toAnswer": su.toAnswer]
    } ?? NSNull()
    let record: [String: Any] = [
      "v": version, "scope": s.scope, "writtenAt": NSNumber(value: s.writtenAt), "zone": s.zone,
      "alerts": s.alerts.map(aheadOut),
      "days": s.days.map { d -> [String: Any] in
        ["year": d.year, "date": dateOut(d.date), "more": d.more,
         "events": d.events.map { e -> [String: Any] in
           ["eventId": e.eventId, "label": labelOut(e.label), "startMs": NSNumber(value: e.startMs),
            "endMs": e.endMs.map { NSNumber(value: $0) as Any } ?? NSNull(), "allDay": e.allDay, "toAnswer": e.toAnswer]
         }]
      },
      "month": ["year": s.month.year, "month": s.month.month, "marked": s.month.marked],
      "toAnswer": s.toAnswer, "summary": summary,
    ]
    return try? JSONSerialization.data(withJSONObject: record, options: [])
  }
}

/// An event's words as one clean line: the twin of the page's `cleanNoticeText`, over UTF-16 as the page reads it.
enum NoticeText {
  static let most = 80

  private static func isSpace(_ cp: UInt32) -> Bool {
    cp == 0x20 || (0x09...0x0d).contains(cp) || cp == 0x85 || cp == 0xa0 || cp == 0x1680 || (0x2000...0x200a).contains(cp)
      || cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000
  }

  private static func isDropped(_ cp: UInt32) -> Bool {
    cp <= 0x1f || (0x7f...0x9f).contains(cp)
      || cp == 0x61c || cp == 0x200e || cp == 0x200f || (0x202a...0x202e).contains(cp) || (0x2066...0x2069).contains(cp)
      || cp == 0xad || cp == 0x180e || (0x200b...0x200d).contains(cp) || (0x2060...0x2064).contains(cp) || cp == 0xfeff
      || cp == 0x34f || cp == 0x115f || cp == 0x1160 || cp == 0x3164 || cp == 0xffa0 || cp == 0x2800
      || (0xfe00...0xfe0f).contains(cp) || (0xe0000...0xe007f).contains(cp) || (0xe0100...0xe01ef).contains(cp)
      || (0xd800...0xdfff).contains(cp)
  }

  static func clean(_ raw: NSString) -> String? {
    var out = ""
    var kept = 0
    var gap = false
    var i = 0
    while i < raw.length {
      let unit = raw.character(at: i)
      var cp = UInt32(unit)
      var width = 1
      if (0xd800...0xdbff).contains(unit), i + 1 < raw.length {
        let low = raw.character(at: i + 1)
        if (0xdc00...0xdfff).contains(low) {
          cp = 0x10000 + ((UInt32(unit) - 0xd800) << 10) + (UInt32(low) - 0xdc00)
          width = 2
        }
      }
      i += width
      if isSpace(cp) { gap = kept > 0; continue }
      if isDropped(cp) { continue }
      let room = most - kept - (gap ? 1 : 0)
      if room < 1 { break }
      if gap { out.append(" "); kept += 1; gap = false }
      guard let scalar = Unicode.Scalar(cp) else { continue }
      out.unicodeScalars.append(scalar)
      kept += 1
    }
    return kept == 0 ? nil : out
  }
}
