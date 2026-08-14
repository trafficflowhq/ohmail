/**
 * ═══ A MINIMAL RFC 5545 VEVENT READER, FOR SHOWING AN INVITATION AS AN EVENT ═════════════════
 *
 * Exactly the fields an inline event preview needs — what, when, where, who, and the METHOD
 * semantics (invitation / reply / proposed new time / cancellation) — and nothing else. Not a
 * calendar engine: no full RRULE expansion, no EXDATE, no VALARM, no free/busy.
 *
 * ── WHY HAND-WRITTEN AND WHY HERE ────────────────────────────────────────────────────────────
 *
 * No ICS parser exists in this workspace's dependency tree (checked against the lockfile), and
 * the well-known ones (`ical.js`, `node-ical`) are whole calendar engines — an unvetted parser
 * over attacker-controlled bytes is exactly the surface to keep small. This file has ZERO
 * imports, node or otherwise, because its consumers straddle the one boundary the rest of this
 * package does not cross: the webapp and the desktop shell run it in a BROWSER, where
 * `node:crypto` and mailparser (this package's barrel) cannot go. Hence the dedicated
 * `@trafficflow/core/ics` entry point in package.json, which maps to this SOURCE file for
 * bundler consumers; node consumers get the same module re-exported through the built barrel
 * and `./mail`. Keep it dependency-free or the browser consumers break.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────
 *
 * `parseIcsEvent(text)` returns a usable {@link IcsEventPreview} or `null`. Never throws. The
 * input is entirely sender-controlled; a `null` is the renderer's signal to fall back to the
 * plain attachment row, so every malformed, truncated, oversized or alien input must land there
 * rather than in a half-filled card. Every string in the result is TEXT for the consumer to
 * escape at render — nothing here is sanitized FOR html, because nothing here may ever be
 * interpreted AS html.
 *
 * ── TIME, STATED PRECISELY ───────────────────────────────────────────────────────────────────
 *
 * Every time carries its literal wall-clock fields plus `epochMs`, the resolved UTC instant —
 * or `null` where no honest instant exists:
 *
 *   · trailing `Z` — exact, by arithmetic.
 *   · `VALUE=DATE` — an all-day CALENDAR DAY; `epochMs` is that day's UTC midnight and a
 *     consumer must format it in UTC or the day shifts west of Greenwich. Per RFC 5545 the
 *     DTEND of an all-day event is EXCLUSIVE (a one-day event ends "tomorrow").
 *   · `TZID=` — resolved through `Intl` (the platform's IANA database, no bundled tzdata).
 *     Exchange writes WINDOWS zone names, so those go through {@link WINDOWS_TZ} (the CLDR
 *     windowsZones primary mapping) first. A zone neither table knows keeps `epochMs: null`
 *     and its label — the consumer shows the wall time AS LABELED rather than claiming an
 *     instant nobody established.
 *   · floating (no TZID, no Z) — `epochMs: null`, `tzid: null`: RFC 5545 says "local time of
 *     the observer", so the CONSUMER may format the wall fields in the viewer's own zone.
 */

/* ── the closed vocabulary ─────────────────────────────────────────────────────────────────── */

export type IcsMethod = "REQUEST" | "REPLY" | "COUNTER" | "CANCEL" | "PUBLISH";
export type IcsReplyStatus = "ACCEPTED" | "DECLINED" | "TENTATIVE";
export type IcsWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface IcsWallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
}

export interface IcsTime {
  /** The resolved UTC instant, or null where none can honestly be claimed (see header). */
  epochMs: number | null;
  /** The literal fields as written — always present, whatever `epochMs` says. */
  wall: IcsWallTime;
  /** `VALUE=DATE` — a calendar day with no clock. `epochMs` is its UTC midnight. */
  allDay: boolean;
  /** The TZID as written (unquoted), or null for UTC/floating/all-day forms. */
  tzid: string | null;
  /** The trailing-Z form. */
  utc: boolean;
}

export interface IcsPerson {
  /** The CN parameter, decoded to text. Attacker text — the renderer escapes it. */
  name: string | null;
  /**
   * The mailto: address, lowercased, query stripped. `null` for any other URI scheme — an
   * ORGANIZER of `javascript:…` is not an address and must never become one on screen.
   */
  email: string | null;
}

/** A rule simple enough to say in words ("weekly on Tuesday"). Anything richer is `null`. */
export interface IcsRecurrence {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: IcsWeekday[];
}

export interface IcsEventPreview {
  method: IcsMethod | null;
  summary: string | null;
  location: string | null;
  /** Required — an event card without a start is not an event card, so the parse refuses. */
  start: IcsTime;
  /** DTEND, or DTSTART + DURATION where only a duration was given. Exclusive for all-day. */
  end: IcsTime | null;
  organizer: IcsPerson | null;
  /** At most {@link MAX_ATTENDEES}; `attendeeCount` is the true total. */
  attendees: IcsPerson[];
  attendeeCount: number;
  /** On METHOD:REPLY — the replying attendee's PARTSTAT ("Mit Vorbehalt" is TENTATIVE). */
  replyStatus: IcsReplyStatus | null;
  /** METHOD:CANCEL or STATUS:CANCELLED — the framing, precomputed so no consumer re-derives it. */
  cancelled: boolean;
  /**
   * The ORIGINAL time on an Outlook counter-proposal, from X-MS-OLDSTART/X-MS-OLDEND
   * (MS-OXCICAL): on a COUNTER, DTSTART/DTEND carry the PROPOSED time and these carry what it
   * would replace — the "old → new" a proposal card can honestly draw. Absent everywhere else.
   */
  oldStart: IcsTime | null;
  oldEnd: IcsTime | null;
  recurrence: IcsRecurrence | null;
}

/* ── the shared naming + type facts, so writers cannot drift ───────────────────────────────── */

/**
 * Is this MIME type a calendar part? `text/calendar` is the RFC 5546 wire type (Outlook,
 * Google, Apple all use it, disposition or not); `application/ics` appears on files people
 * attach by hand. Parameters (`; method=REQUEST; charset=…`) and case are ignored.
 */
export function isCalendarMime(contentType: string): boolean {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return base === "text/calendar" || base === "application/ics";
}

/**
 * The display/download name for a calendar part that arrived NAMELESS — which is the COMMON
 * case, not the edge: Google nests the invite as an unnamed `text/calendar` part under
 * `multipart/alternative` (305 of the live corpus's 646 calendar parts carry no filename).
 * `attachment-<uuid>.bin` — the generic nameless fallback — hides exactly the thing the part is.
 */
export const CALENDAR_FALLBACK_FILENAME = "invite.ics";

/**
 * The parse ceiling, in UTF-16 code units. Real invites are 1–4 KB (the live corpus's largest
 * is 4 035 bytes); 512 KiB is two orders of magnitude of headroom. Above it the input is just
 * a file: the caller shows the plain row and the reader can still download it.
 */
export const ICS_PARSE_MAX_CHARS = 512 * 1024;

/* ── Windows → IANA zone names ─────────────────────────────────────────────────────────────── */

/**
 * The CLDR `windowsZones` PRIMARY mappings (Unicode CLDR, `territory="001"` rows) for the zones
 * Exchange actually writes. `Intl` speaks only IANA, Exchange speaks only these. A name missing
 * here is not an error — {@link parseIcsDate} degrades to a labeled wall time — so this table
 * trades completeness for verifiability: every row is the CLDR primary, none is invented.
 */
const WINDOWS_TZ: Record<string, string> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Aleutian Standard Time": "America/Adak",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time": "America/New_York",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Venezuela Standard Time": "America/Caracas",
  "Paraguay Standard Time": "America/Asuncion",
  "Atlantic Standard Time": "America/Halifax",
  "Cuba Standard Time": "America/Havana",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Turks And Caicos Standard Time": "America/Grand_Turk",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina",
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Montevideo Standard Time": "America/Montevideo",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Bahia Standard Time": "America/Bahia",
  "Greenland Standard Time": "America/Godthab",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  UTC: "Etc/UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Morocco Standard Time": "Africa/Casablanca",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "Jordan Standard Time": "Asia/Amman",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus",
  "West Bank Standard Time": "Asia/Hebron",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Sudan Standard Time": "Africa/Juba",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Sudan Standard Time": "Africa/Khartoum",
  "Libya Standard Time": "Africa/Tripoli",
  "Namibia Standard Time": "Africa/Windhoek",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Volgograd Standard Time": "Europe/Volgograd",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Russia Time Zone 3": "Europe/Samara",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Saratov Standard Time": "Europe/Saratov",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk",
  "Myanmar Standard Time": "Asia/Yangon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Altai Standard Time": "Asia/Barnaul",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Transbaikal Standard Time": "Asia/Chita",
  "Tokyo Standard Time": "Asia/Tokyo",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Magadan Standard Time": "Asia/Magadan",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
  "Easter Island Standard Time": "Pacific/Easter",
};

/* ── time resolution ───────────────────────────────────────────────────────────────────────── */

/** Per-zone formatter cache — constructing `Intl.DateTimeFormat` is the expensive part. */
const ZONE_FMT = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const held = ZONE_FMT.get(zone);
  if (held !== undefined) return held;
  let made: Intl.DateTimeFormat | null;
  try {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    made = null; // the runtime does not know this zone
  }
  ZONE_FMT.set(zone, made);
  return made;
}

/** The zone's UTC offset in ms at a given instant, read off the platform's own tz database. */
function zoneOffsetMs(atMs: number, fmt: Intl.DateTimeFormat): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(new Date(atMs));
  } catch {
    return null;
  }
  const f: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") f[p.type] = Number(p.value);
  }
  if (![f.year, f.month, f.day, f.hour, f.minute, f.second].every(Number.isFinite)) return null;
  const asUtc = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour!, f.minute!, f.second!);
  return asUtc - atMs;
}

/**
 * The UTC instant at which `wall` is on the clock in `zone` — the classic two-pass read:
 * guess the offset at the wall time taken as UTC, correct, and re-read once so a wall time
 * on the far side of a DST transition lands on the offset actually in force.
 */
function epochFromWall(w: IcsWallTime, zone: string): number | null {
  const fmt = zoneFormatter(zone);
  if (!fmt) return null;
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const first = zoneOffsetMs(guess, fmt);
  if (first === null) return null;
  const second = zoneOffsetMs(guess - first, fmt);
  return guess - (second ?? first);
}

/** Calendar-field validation — `Date.UTC` would happily normalize month 13 into next January. */
function validWall(w: IcsWallTime): boolean {
  if (w.month < 1 || w.month > 12 || w.hour > 23 || w.minute > 59) return false;
  const daysInMonth = new Date(Date.UTC(w.year, w.month, 0)).getUTCDate();
  return w.day >= 1 && w.day <= daysInMonth;
}

/**
 * One DATE or DATE-TIME property value → {@link IcsTime}, or null.
 * `tzidParam` arrives already unquoted (the param scanner strips DQUOTEs).
 */
function parseIcsDate(value: string, tzidParam: string | null, valueParam: string | null): IcsTime | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || valueParam === "DATE") {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const wall: IcsWallTime = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0 };
    if (!validWall(wall)) return null;
    return {
      epochMs: Date.UTC(wall.year, wall.month - 1, wall.day),
      wall,
      allDay: true,
      tzid: null,
      utc: false,
    };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const wall: IcsWallTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  if (!validWall(wall)) return null;
  if (m[7] === "Z") {
    return { epochMs: Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute), wall, allDay: false, tzid: null, utc: true };
  }
  if (tzidParam) {
    const zone = WINDOWS_TZ[tzidParam] ?? tzidParam;
    return { epochMs: epochFromWall(wall, zone), wall, allDay: false, tzid: tzidParam, utc: false };
  }
  // Floating: no zone claimed, so no instant claimed. The consumer may read it as viewer-local.
  return { epochMs: null, wall, allDay: false, tzid: null, utc: false };
}

/** `PT1H30M` / `P1D` / `P1DT2H` → milliseconds. Weeks included; months/years are not durations here. */
function parseIcsDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  if (!w && !d && !h && !mi && !s) return null;
  const ms =
    (Number(w ?? 0) * 7 * 24 * 3600 + Number(d ?? 0) * 24 * 3600 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

/* ── content-line machinery ────────────────────────────────────────────────────────────────── */

interface ContentLine {
  name: string; // upper-cased
  params: Map<string, string>; // upper-cased keys, unquoted values (first occurrence wins)
  value: string; // raw — text unescaping is the caller's per-property decision
}

/**
 * NAME;PARAM=VAL;PARAM="quoted,val":value — scanned, not split: a `:` inside a quoted param
 * (`CN="Doe: the first"`) or a `;` inside one must not end the parameter section.
 */
function parseContentLine(line: string): ContentLine | null {
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) break;
  }
  if (i >= line.length) return null; // no unquoted colon — not a content line
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segments: string[] = [];
  let seg = "";
  inQuotes = false;
  for (const c of head) {
    if (c === '"') {
      inQuotes = !inQuotes;
      continue; // quotes delimit, they are not content (RFC 5545 §3.2)
    }
    if (c === ";" && !inQuotes) {
      segments.push(seg);
      seg = "";
      continue;
    }
    seg += c;
  }
  segments.push(seg);
  const name = (segments.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params = new Map<string, string>();
  for (const s of segments) {
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim().toUpperCase();
    if (!params.has(key)) params.set(key, s.slice(eq + 1).trim());
  }
  return { name, params, value };
}

/** RFC 5545 §3.3.11 TEXT unescaping. `\n`/`\N` → newline; `\\`, `\,`, `\;` → the literal. */
function unescapeText(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c !== "\\" || i + 1 >= v.length) {
      out += c;
      continue;
    }
    const next = v[i + 1]!;
    if (next === "n" || next === "N") out += "\n";
    else if (next === "\\" || next === "," || next === ";") out += next;
    else {
      out += c;
      continue; // unknown escape: keep the backslash, do not consume
    }
    i++;
  }
  return out;
}

/** CAL-ADDRESS value + CN param → a person. Only `mailto:` yields an address; query stripped. */
function parsePerson(line: ContentLine): IcsPerson {
  const cn = line.params.get("CN") ?? null;
  const v = line.value.trim();
  let email: string | null = null;
  if (/^mailto:/i.test(v)) {
    const addr = v.slice("mailto:".length).split("?")[0]!.trim().toLowerCase();
    if (addr.includes("@")) email = addr;
  }
  return { name: cn ? unescapeText(cn).trim() || null : null, email };
}

const FREQ_WORDS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAY_CODES = new Set<string>(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
/** RRULE parts whose presence makes the rule too rich to say in words. */
const RRULE_DISQUALIFIERS = ["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND"];

/** A trivially speakable RRULE, or null. Ordinal BYDAY (`2TU`, `-1SU`) disqualifies. */
function parseRecurrence(value: string): IcsRecurrence | null {
  const parts = new Map<string, string>();
  for (const seg of value.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim());
  }
  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  if (!FREQ_WORDS.has(freq)) return null;
  for (const key of RRULE_DISQUALIFIERS) if (parts.has(key)) return null;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return null;
  const byDay: IcsWeekday[] = [];
  const byDayRaw = parts.get("BYDAY");
  if (byDayRaw) {
    for (const token of byDayRaw.split(",")) {
      const t = token.trim().toUpperCase();
      if (!WEEKDAY_CODES.has(t)) return null; // an ordinal like 2TU is not "weekly on Tuesday"
      if (!byDay.includes(t as IcsWeekday)) byDay.push(t as IcsWeekday);
    }
  }
  return { freq: freq as IcsRecurrence["freq"], interval, byDay };
}

/* ── the parse ─────────────────────────────────────────────────────────────────────────────── */

const MAX_ATTENDEES = 8;

/**
 * See the module header for the contract. The walk tracks BEGIN/END nesting so a VTIMEZONE's
 * own DTSTART/RRULE lines (every Exchange invite carries them) can never be read as the
 * event's, and only the FIRST VEVENT is read — a recurrence exception in the same VCALENDAR
 * describes an override, not the invitation.
 */
export function parseIcsEvent(text: string): IcsEventPreview | null {
  if (typeof text !== "string" || text.length === 0 || text.length > ICS_PARSE_MAX_CHARS) return null;
  if (!/BEGIN:VCALENDAR/i.test(text)) return null;

  // Unfold (CRLF + WSP, tolerating bare LF), then split into lines.
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

  let method: IcsMethod | null = null;
  let inEvent = false;
  let eventDone = false;
  let depthInsideOther = 0; // components nested inside the VEVENT (VALARM) — skipped whole

  let summary: string | null = null;
  let location: string | null = null;
  let start: IcsTime | null = null;
  let end: IcsTime | null = null;
  let durationMs: number | null = null;
  let organizer: IcsPerson | null = null;
  const attendees: IcsPerson[] = [];
  let attendeeCount = 0;
  let replyStatus: IcsReplyStatus | null = null;
  let statusCancelled = false;
  let oldStart: IcsTime | null = null;
  let oldEnd: IcsTime | null = null;
  let recurrence: IcsRecurrence | null = null;

  for (const raw of lines) {
    if (raw === "") continue;
    const line = parseContentLine(raw);
    if (!line) continue;

    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      if (inEvent) depthInsideOther++;
      else if (component === "VEVENT" && !eventDone) inEvent = true;
      continue;
    }
    if (line.name === "END") {
      if (inEvent && depthInsideOther > 0) depthInsideOther--;
      else if (inEvent && line.value.trim().toUpperCase() === "VEVENT") {
        inEvent = false;
        eventDone = true;
      }
      continue;
    }

    if (!inEvent) {
      // VCALENDAR level. METHOD lives here (RFC 5546); the walk above keeps VTIMEZONE lines out
      // by never being `inEvent` for them.
      if (line.name === "METHOD" && method === null) {
        const m = line.value.trim().toUpperCase();
        if (m === "REQUEST" || m === "REPLY" || m === "COUNTER" || m === "CANCEL" || m === "PUBLISH") method = m;
      }
      continue;
    }
    if (depthInsideOther > 0) continue; // inside a VALARM etc.

    switch (line.name) {
      case "SUMMARY":
        if (summary === null) summary = unescapeText(line.value).trim() || null;
        break;
      case "LOCATION":
        if (location === null) location = unescapeText(line.value).trim() || null;
        break;
      case "DTSTART":
        if (start === null) start = parseIcsDate(line.value, line.params.get("TZID") ?? null, line.params.get("VALUE") ?? null);
        break;
      case "DTEND":
        if (end === null) end = parseIcsDate(line.value, line.params.get("TZID") ?? null, line.params.get("VALUE") ?? null);
        break;
      case "DURATION":
        if (durationMs === null) durationMs = parseIcsDuration(line.value);
        break;
      case "ORGANIZER":
        if (organizer === null) organizer = parsePerson(line);
        break;
      case "ATTENDEE": {
        attendeeCount++;
        if (attendees.length < MAX_ATTENDEES) attendees.push(parsePerson(line));
        if (replyStatus === null) {
          const p = (line.params.get("PARTSTAT") ?? "").toUpperCase();
          if (p === "ACCEPTED" || p === "DECLINED" || p === "TENTATIVE") replyStatus = p;
        }
        break;
      }
      case "STATUS":
        if (line.value.trim().toUpperCase() === "CANCELLED") statusCancelled = true;
        break;
      case "RRULE":
        if (recurrence === null) recurrence = parseRecurrence(line.value);
        break;
      case "X-MS-OLDSTART":
        if (oldStart === null) oldStart = parseIcsDate(line.value, line.params.get("TZID") ?? null, null);
        break;
      case "X-MS-OLDEND":
        if (oldEnd === null) oldEnd = parseIcsDate(line.value, line.params.get("TZID") ?? null, null);
        break;
    }
  }

  if (!start) return null;

  // DTEND absent + DURATION present: derive the end where an instant exists to add to. The
  // wall fields get plain calendar addition, which Date.UTC normalizes across day/month ends.
  if (!end && durationMs !== null && durationMs > 0 && !start.allDay) {
    const endEpoch = start.epochMs === null ? null : start.epochMs + durationMs;
    const wallMs = Date.UTC(start.wall.year, start.wall.month - 1, start.wall.day, start.wall.hour, start.wall.minute) + durationMs;
    const w = new Date(wallMs);
    end = {
      epochMs: endEpoch,
      wall: { year: w.getUTCFullYear(), month: w.getUTCMonth() + 1, day: w.getUTCDate(), hour: w.getUTCHours(), minute: w.getUTCMinutes() },
      allDay: false,
      tzid: start.tzid,
      utc: start.utc,
    };
  }

  return {
    method,
    summary,
    location,
    start,
    end,
    organizer,
    attendees,
    attendeeCount,
    // A reply's PARTSTAT names the replier's answer; on any other method the attendees' states
    // describe the roster, not an answer, so the field stays null there.
    replyStatus: method === "REPLY" ? replyStatus : null,
    cancelled: method === "CANCEL" || statusCancelled,
    oldStart: method === "COUNTER" ? oldStart : null,
    oldEnd: method === "COUNTER" ? oldEnd : null,
    recurrence,
  };
}
