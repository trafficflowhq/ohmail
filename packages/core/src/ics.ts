/**
 * A minimal RFC 5545 VEVENT reader for showing an invitation as an event — not a calendar engine.
 * Hand-written: no ICS parser exists in this tree and the well-known ones are whole calendar
 * engines — an unvetted parser over attacker-controlled bytes is the surface to keep small. ZERO
 * imports, because the webapp and desktop shell run it in a BROWSER (`@trafficflow/core/ics` maps
 * to this source file). `parseIcsEvent(text)` returns a preview or `null`, never throws; every
 * string is TEXT for the consumer to escape, and bounded to what a card draws (see
 * {@link SUMMARY_MAX}). Time: trailing `Z` exact; `VALUE=DATE` is UTC
 * midnight of an all-day day (DTEND exclusive); `TZID=` resolves through `Intl`, Windows names
 * via {@link WINDOWS_TZ}; unknown zones and floating times keep `epochMs: null`.
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
  /**
   * The TZID as written (unquoted), or null for UTC/floating/all-day forms. Drawn as the label of
   * a zone that does not resolve, so cut past {@link ZONE_LABEL_MAX}: no zone name is that long.
   */
  tzid: string | null;
  /** The trailing-Z form. */
  utc: boolean;
}

export interface IcsPerson {
  /** The CN parameter, decoded to text, cut past {@link NAME_MAX}. Attacker text — the renderer escapes it. */
  name: string | null;
  /**
   * The mailto: address, lowercased, query stripped. `null` for any other URI scheme — an
   * ORGANIZER of `javascript:…` is not an address and must never become one on screen — and for
   * one longer than {@link ADDRESS_MAX}, which no transport delivers to.
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
  /** Cut past {@link SUMMARY_MAX} code units, the ellipsis included. */
  summary: string | null;
  /** Cut past {@link LOCATION_MAX} code units, the ellipsis included. */
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
  /**
   * The event's identity, compared and never drawn: UID, RECURRENCE-ID (canonical, see
   * {@link distinctCalendarEvents}) and SEQUENCE, from the first VEVENT only. Sender text.
   */
  uid: string | null;
  recurrenceId: string | null;
  /** 0 to 2^31-1, else null. */
  sequence: number | null;
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

/** What {@link isCalendarBodyPart} reads off a stored part: the four facts ingest keeps. */
export interface CalendarBodyFacts {
  filename: string | null | undefined;
  contentType: string;
  inline: boolean;
  contentId: string | null | undefined;
}

/**
 * IS THIS PART THE INVITATION'S OWN CALENDAR BODY, rather than a file? A calendar part with no
 * name, no Content-ID and not embedded: the `text/calendar` alternative Google, Thunderbird,
 * Exchange and Outlook put beside the text and html bodies (or the whole message, for a bare iTIP
 * one). The event card reads it. A strip leaves it out only while a listed calendar file carries
 * its event (client-engine `withoutCalendarBodies`), so a Google invitation lists its `invite.ics`
 * once and an Outlook one, whose alternative is its only copy, keeps it. A calendar file somebody
 * attached carries a name (Content-Disposition `filename` or Content-Type `name`), an embedded one
 * a Content-ID: neither is a body.
 */
export function isCalendarBodyPart(part: CalendarBodyFacts): boolean {
  if (!isCalendarMime(part.contentType) || part.inline) return false;
  if ((part.contentId ?? "").trim() !== "") return false;
  return (part.filename ?? "").trim() === "";
}

/**
 * The parse ceiling, in UTF-16 code units. Real invites are 1–4 KB (the live corpus's largest
 * is 4 035 bytes); 512 KiB is two orders of magnitude of headroom. Above it the input is just
 * a file: the caller shows the plain row and the reader can still download it.
 */
export const ICS_PARSE_MAX_CHARS = 512 * 1024;

/**
 * THE MOST OF ONE SENDER-WRITTEN VALUE A CARD DRAWS, in UTF-16 code units, the ellipsis included.
 * The parse ceiling and the engine's 256 KiB calendar budget leave room for a 250,000-character
 * SUMMARY, and the phone lays a Text out whole above the body (a 65,536-character one took ~450 ms
 * of its JS thread). Cut here, where the web, the desktop and the phone all read the preview
 * ({@link drawnText}). Real invites are 1–4 KB whole, so no real title, place or name is cut, and no
 * zone name is longer than a label (the longest IANA name is 32 characters).
 */
const SUMMARY_MAX = 1000;
const LOCATION_MAX = 1000;
/** Each person's CN. */
const NAME_MAX = 200;
/** The label of a TZID that does not resolve. */
const ZONE_LABEL_MAX = 64;
/** RFC 5321's 254, the store's `MAX_STORED_ADDRESS_CHARS`: a longer mailto: is no address, never cut. */
const ADDRESS_MAX = 254;

/**
 * Microsoft's message-level "this is a meeting message" marker (`Content-Class:`). It is the one
 * POSITIVE signal an Outlook Web Access invitation carries when its mail system sent the event as
 * a LINK instead of a part, which is the shape that leaves a reader looking at OWA boilerplate
 * with no event anywhere. Compared lowercased and trimmed; the header name itself is matched
 * case-insensitively by the caller, since Exchange writes `Content-class`.
 */
export const CALENDAR_MESSAGE_CONTENT_CLASS = "urn:content-classes:calendarmessage";

/* ── the Outlook Web App invitation stub ───────────────────────────────────────────────────── */

/**
 * An Exchange or Microsoft 365 meeting invitation the reader's own server served over IMAP as an
 * Outlook Web App LINK instead of the event. `optionsHref` is Microsoft 365's "POP and IMAP" options
 * page, built from constants (host and the bare `/owa/`), never from the message's path; `null` on
 * any other server.
 */
export interface OwaInvitationStub {
  readonly optionsHref: string | null;
}

/** How much of the body text is read: the stub's two links open it. */
const OWA_STUB_HEAD_CHARS = 2048;
const OWA_STUB_LABEL_MAX = 80;
const OWA_URL_TOKEN = /https?:\/\/[^\s<>"'[\]]+/gi;
const OWA_URL_TRAILING = /[.,;:!?)\]}>]+$/;
const M365_HOSTS: ReadonlySet<string> = new Set(["outlook.office365.com", "outlook.office.com"]);
const M365_OWA_PATH = /^\/owa(\/[A-Za-z0-9.-]{1,253})?\/?$/;

interface OwaUrl {
  readonly scheme: string;
  readonly host: string;
  readonly path: string;
  readonly params: ReadonlyMap<string, string>;
  readonly at: number;
}

/** A decoded query, keys lowercased; `null` on bad percent-encoding. By hand: RN's URL is unreliable. */
function owaQuery(query: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    try {
      const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));
      if (!out.has(key)) out.set(key, value);
    } catch {
      return null;
    }
  }
  return out;
}

/** Scheme, host, path and query of one URL token; `null` for userinfo, a port or bad encoding. */
function owaUrl(raw: string, at: number): OwaUrl | null {
  const sep = raw.indexOf("://");
  const scheme = raw.slice(0, sep).toLowerCase();
  const rest = raw.slice(sep + 3);
  const hostEnd = rest.search(/[/?#]/);
  const host = (hostEnd < 0 ? rest : rest.slice(0, hostEnd)).toLowerCase();
  if (host === "" || host.includes("@") || host.includes(":")) return null;
  const tail = hostEnd < 0 ? "" : rest.slice(hostEnd);
  const hash = tail.indexOf("#");
  const beforeHash = hash < 0 ? tail : tail.slice(0, hash);
  const q = beforeHash.indexOf("?");
  const path = q < 0 ? beforeHash : beforeHash.slice(0, q);
  const params = owaQuery(q < 0 ? "" : beforeHash.slice(q + 1));
  return params === null ? null : { scheme, host, path, params, at };
}

const isOwaPath = (u: OwaUrl): boolean => {
  const p = u.path.toLowerCase();
  return p === "/owa" || p.startsWith("/owa/");
};
const owaPathParam = (u: OwaUrl): string => (u.params.get("path") ?? "").toLowerCase();

/**
 * Is this body text an Outlook Web App invitation stub? Read from the first
 * {@link OWA_STUB_HEAD_CHARS} of the TEXT part only. The text's first URL is the calendar item link
 * (`/owa…?itemid=…&path=/calendar/item`), on its first line or under a short label line, and a later
 * URL on the same origin is the `path=/options/popandimap` page. URLs, not sentences: the sentences
 * follow the mailbox language. Pure; never throws.
 */
export function owaInvitationStub(text: string): OwaInvitationStub | null {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, OWA_STUB_HEAD_CHARS);
  const urls: Array<OwaUrl | null> = [];
  for (const m of head.matchAll(OWA_URL_TOKEN)) {
    urls.push(owaUrl(m[0].replace(OWA_URL_TRAILING, ""), m.index ?? 0));
  }
  const item = urls[0];
  if (item == null) return null;

  // The item link opens the text: on line one, or on the next non-blank line under a short label.
  const firstBreak = head.indexOf("\n");
  const firstLine = (firstBreak < 0 ? head : head.slice(0, firstBreak)).trim();
  if (firstBreak >= 0 && item.at > firstBreak) {
    if (!firstLine.endsWith(":") || firstLine.length > OWA_STUB_LABEL_MAX) return null;
    const itemLineStart = head.lastIndexOf("\n", item.at) + 1;
    if (head.slice(firstBreak + 1, itemLineStart).trim() !== "") return null;
  }

  if (!isOwaPath(item) || owaPathParam(item) !== "/calendar/item" || (item.params.get("itemid") ?? "") === "") return null;
  const options = urls.slice(1).find((u): u is OwaUrl =>
    u !== null && u.scheme === item.scheme && u.host === item.host && isOwaPath(u)
    && owaPathParam(u) === "/options/popandimap");
  if (options === undefined) return null;

  // Constants only: the /owa/<segment>/ names a sign-in realm, and the sender chose it.
  const linkable = options.scheme === "https" && M365_HOSTS.has(options.host) && M365_OWA_PATH.test(options.path);
  return { optionsHref: linkable ? `https://${options.host}/owa/?path=/options/popandimap` : null };
}

/**
 * The `method=` parameter of a Content-Type, uppercased — RFC 6047's iTIP marker
 * (`text/calendar; method=REPLY`). Returns `null` when the parameter is absent.
 *
 * It is read from a Content-Type and never from {@link IcsEventPreview}, because the parameter is
 * the only form of the method that survives storage: a calendar part's stored type keeps it
 * (`mime.ts` `withCalendarMethod`), and the .ics bytes that carry `METHOD:` are never persisted.
 */
export function icsMethodOfContentType(contentType: string): string | null {
  for (const raw of contentType.split(";").slice(1)) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    if (raw.slice(0, eq).trim().toLowerCase() !== "method") continue;
    const v = raw.slice(eq + 1).trim().replace(/^"|"$/g, "").trim();
    return v === "" ? null : v.toUpperCase();
  }
  return null;
}

/**
 * The subject prefixes a calendar client writes on an ACKNOWLEDGEMENT it sends back. A THIRD
 * table, display-only, and neither of `threading.ts`'s two: the naming table decides what a thread
 * is CALLED, the continuation table decides irreversible MERGES, and an acknowledgement is
 * evidence for neither — nothing here reaches `baseSubject`, `conversationJoinVerdict` or ingest.
 * Longest token first, so the alternation never stops at a prefix of a longer one. The worst error
 * is bounded: own mail that genuinely opens "Accepted:" loses its conversation's FACE and stays a
 * member of it — never hidden, never unthreaded, never merged.
 */
const ACKNOWLEDGEMENT_PREFIX_TOKENS = [
  "tentatively accepted",   // en, Outlook's three-word form
  "mit vorbehalt angenommen", // de, the long form
  "vorläufig angenommen",   // de, Apple's form
  "provisionally accepted", // en, Apple's form
  "geaccepteerd",           // nl accepted
  "mit vorbehalt",          // de tentative
  "tentativement",          // fr tentative
  "provvisorio",            // it tentative
  "provisional",            // es tentative
  "angenommen",             // de accepted
  "abgelehnt",              // de declined
  "accettato",              // it accepted
  "rifiutato",              // it declined
  "geweigerd",              // nl declined
  "voorlopig",              // nl tentative
  "rechazada",              // es declined
  "recusada",               // pt declined
  "tentative",              // en tentative
  "aceptada",               // es accepted
  "acceptée", "acceptee",   // fr accepted (accented and the ASCII form clients also emit)
  "refusée", "refusee",     // fr declined
  "accepted",               // en accepted
  "declined",               // en declined
  "aceite",                 // pt accepted
] as const;

/**
 * One acknowledgement prefix: the token, an optional abbreviating dot, optional space before the
 * colon (fr Outlook writes "Acceptée :"), and either the ASCII or the fullwidth colon. The same
 * anatomy the naming table uses, so the two read alike; the token must be the ENTIRE word before
 * the colon, which is what keeps "Accepted payment terms" — no colon — and "Tentative agenda:"
 * apart from a calendar client's output.
 */
export const ACKNOWLEDGEMENT_PREFIX_PATTERN =
  `^(?:${ACKNOWLEDGEMENT_PREFIX_TOKENS.join("|")})\\.?\\s*[:：]`;

const ACKNOWLEDGEMENT_PREFIX_RE = new RegExp(ACKNOWLEDGEMENT_PREFIX_PATTERN, "i");

/** Does this subject open with an acknowledgement prefix? See {@link ACKNOWLEDGEMENT_PREFIX_TOKENS}. */
export function isAcknowledgementSubject(subject: string): boolean {
  return ACKNOWLEDGEMENT_PREFIX_RE.test(subject.trim());
}

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
    // A TZID longer than a label names no zone: it is never looked up, and its label is cut.
    const nameable = tzidParam.length <= ZONE_LABEL_MAX;
    const epochMs = nameable ? epochFromWall(wall, WINDOWS_TZ[tzidParam] ?? tzidParam) : null;
    return { epochMs, wall, allDay: false, tzid: drawnText(tzidParam, ZONE_LABEL_MAX), utc: false };
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

/**
 * At most `max` code units of a value a card draws: the value itself, or its head and an
 * ellipsis, the head never ending in half a surrogate pair (the store's `storedSubject` rule) or
 * in white space.
 */
function drawnText(value: string, max: number): string {
  if (value.length <= max) return value;
  let head = value.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

/** A TEXT value as a card draws it: unescaped and trimmed, null when empty, cut past `max`. */
function drawnTextValue(raw: string, max: number): string | null {
  const v = unescapeText(raw).trim();
  return v === "" ? null : drawnText(v, max);
}

/** CAL-ADDRESS value + CN param → a person. Only `mailto:` yields an address; query stripped. */
function parsePerson(line: ContentLine): IcsPerson {
  const cn = line.params.get("CN") ?? null;
  const v = line.value.trim();
  let email: string | null = null;
  if (/^mailto:/i.test(v)) {
    const addr = v.slice("mailto:".length).split("?")[0]!.trim().toLowerCase();
    if (addr.includes("@") && addr.length <= ADDRESS_MAX) email = addr;
  }
  return { name: cn ? drawnTextValue(cn, NAME_MAX) : null, email };
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
const SEQUENCE_MAX = 2 ** 31 - 1;

/** `YYYYMMDDTHHMM` of a wall time, zero-padded. */
function wallKey(w: IcsWallTime): string {
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${p(w.year, 4)}${p(w.month)}${p(w.day)}T${p(w.hour)}${p(w.minute)}`;
}

/**
 * RECURRENCE-ID as a comparable key: the instant where it resolves, else zone, wall time and day
 * form. The zone is the TZID as written, never its drawn label: an identity is compared whole.
 */
function canonicalRecurrenceId(line: ContentLine): string | null {
  const tzid = line.params.get("TZID") ?? null;
  const t = parseIcsDate(line.value, tzid, line.params.get("VALUE") ?? null);
  if (!t) return null;
  return t.epochMs !== null ? String(t.epochMs) : `${tzid ?? ""}|${wallKey(t.wall)}|${t.allDay}`;
}

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
  let uid: string | null = null;
  let uidSeen = false;
  let recurrenceId: string | null = null;
  let recurrenceIdSeen = false;
  let sequence: number | null = null;
  let sequenceSeen = false;

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
        if (summary === null) summary = drawnTextValue(line.value, SUMMARY_MAX);
        break;
      case "LOCATION":
        if (location === null) location = drawnTextValue(line.value, LOCATION_MAX);
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
      case "UID":
        if (!uidSeen) {
          uidSeen = true;
          uid = unescapeText(line.value).trim() || null;
        }
        break;
      case "RECURRENCE-ID":
        if (!recurrenceIdSeen) {
          recurrenceIdSeen = true;
          recurrenceId = canonicalRecurrenceId(line);
        }
        break;
      case "SEQUENCE":
        if (!sequenceSeen) {
          sequenceSeen = true;
          const v = line.value.trim();
          const n = /^\d{1,10}$/.test(v) ? Number(v) : NaN;
          sequence = Number.isInteger(n) && n <= SEQUENCE_MAX ? n : null;
        }
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
    // A DURATION past the range of a Date (P999999999D) keeps no end: the start-only line.
    const inRange = Number.isFinite(w.getTime()) && (endEpoch === null || Number.isFinite(new Date(endEpoch).getTime()));
    if (inRange) {
      end = {
        epochMs: endEpoch,
        wall: { year: w.getUTCFullYear(), month: w.getUTCMonth() + 1, day: w.getUTCDate(), hour: w.getUTCHours(), minute: w.getUTCMinutes() },
        allDay: false,
        tzid: start.tzid,
        utc: start.utc,
      };
    }
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
    uid,
    recurrenceId,
    sequence,
  };
}

/* ── one card per event ────────────────────────────────────────────────────────────────────── */

/**
 * Which of a message's calendar parts speaks for its event first: 0 the iTIP part
 * (`text/calendar; method=…`), 1 any other `text/calendar`, 2 `application/ics` (a file attached
 * by hand, or Google's copy of the alternative). Anything else ranks last.
 */
export function calendarPartRank(contentType: string): number {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "text/calendar") return icsMethodOfContentType(contentType) !== null ? 0 : 1;
  return base === "application/ics" ? 2 : 3;
}

/** One calendar part of one message: its id, its stored type and its decoded text. No filename. */
export interface CalendarPartText {
  id: string;
  contentType: string;
  text: string;
}

export interface DistinctCalendarEvent {
  partId: string;
  event: IcsEventPreview;
}

/** Every field the card draws, so two UID-less parts are one event only when they would draw alike. */
function drawnFingerprint(e: IcsEventPreview): string {
  const drawn: Partial<IcsEventPreview> = { ...e };
  delete drawn.uid;
  delete drawn.recurrenceId;
  delete drawn.sequence;
  return JSON.stringify(drawn);
}

/**
 * ONE EVENT'S IDENTITY within a message, the key {@link distinctCalendarEvents} folds on:
 * `(UID, RECURRENCE-ID)` where a UID exists, otherwise every drawn field.
 */
export function calendarEventKey(event: IcsEventPreview): string {
  return event.uid !== null
    ? `u\u0000${event.uid}\u0000${event.recurrenceId ?? ""}`
    : `f\u0000${drawnFingerprint(event)}`;
}

/**
 * THE EVENTS A MESSAGE CARRIES, ONCE EACH. Google and Thunderbird send one invitation as two parts
 * (the nameless alternative and `invite.ics`), so a card per part drew the meeting twice. Parts
 * that do not parse are dropped. Identity is `(UID, RECURRENCE-ID)` where a UID exists, otherwise
 * every drawn field; never the filename (the input has none) and never the bytes. Per key the
 * winner is the higher SEQUENCE (none counts below 0), then the lower {@link calendarPartRank},
 * then input order; the output keeps each key's first appearance. Within one message only.
 */
export function distinctCalendarEvents(parts: readonly CalendarPartText[]): DistinctCalendarEvent[] {
  const order: string[] = [];
  const best = new Map<string, { partId: string; event: IcsEventPreview; rank: number }>();
  for (const part of parts) {
    const event = parseIcsEvent(part.text);
    if (!event) continue;
    const key = calendarEventKey(event);
    const rank = calendarPartRank(part.contentType);
    const held = best.get(key);
    if (!held) {
      order.push(key);
      best.set(key, { partId: part.id, event, rank });
      continue;
    }
    const seq = event.sequence ?? -1;
    const heldSeq = held.event.sequence ?? -1;
    if (seq > heldSeq || (seq === heldSeq && rank < held.rank)) best.set(key, { partId: part.id, event, rank });
  }
  return order.map((key) => {
    const { partId, event } = best.get(key)!;
    return { partId, event };
  });
}

/* ── what the card says, shared by the web and the phone ───────────────────────────────────── */

/** The reader's locale and display zone. */
export interface IcsFormatOptions {
  locale: string;
  zone: string;
}

/** The Date whose UTC fields are the wall-clock fields: a floating or unresolvable time formats through it. */
function wallDate(t: IcsTime): Date {
  return new Date(Date.UTC(t.wall.year, t.wall.month - 1, t.wall.day, t.wall.hour, t.wall.minute));
}

/** The instant to format and the zone to format it in: the two honest-degradation branches. */
function displayBasis(t: IcsTime, zone: string): { date: Date; zone: string; zoneLabel: string | null } {
  if (t.allDay) return { date: new Date(t.epochMs!), zone: "UTC", zoneLabel: null };
  if (t.epochMs !== null) return { date: new Date(t.epochMs), zone, zoneLabel: null };
  return { date: wallDate(t), zone: "UTC", zoneLabel: t.tzid };
}

/** A date `Intl` can format; anything else would throw "Invalid time value" during render. */
function formattable(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function icsFmt(date: Date, locale: string, zone: string, opts: Intl.DateTimeFormatOptions): string {
  if (!formattable(date)) return "";
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }).format(date);
}

const ICS_DATE_OPTS: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const ICS_TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DAY_MS = 24 * 3600 * 1000;

/**
 * The when-line, in the reader's locale and zone (`allDay` is the reader's word for it):
 *   timed, same day    "Fri, Sep 11, 2026 · 4:00 – 4:30 PM"
 *   timed, multi-day   "Fri, Sep 11, 2026, 4:00 PM – Sat, Sep 12, 2026, 10:00 AM"
 *   all-day, one day   "Tue, Sep 15, 2026 · All day"
 *   all-day, multi-day "Tue, Sep 15, 2026 – Wed, Sep 16, 2026" (DTEND is exclusive)
 *   unresolvable zone  "Wed, Aug 19, 2026 · 2:00 PM (Middle Earth Standard Time)"
 */
export function formatIcsWhen(start: IcsTime, end: IcsTime | null, opts: IcsFormatOptions & { allDay: string }): string {
  const { locale } = opts;
  const s = displayBasis(start, opts.zone);
  if (start.allDay) {
    const first = icsFmt(s.date, locale, "UTC", ICS_DATE_OPTS);
    if (end?.allDay && end.epochMs !== null && end.epochMs - start.epochMs! > DAY_MS && formattable(new Date(end.epochMs - DAY_MS))) {
      return `${first} – ${icsFmt(new Date(end.epochMs - DAY_MS), locale, "UTC", ICS_DATE_OPTS)}`;
    }
    return `${first} · ${opts.allDay}`;
  }
  const dayOf = (d: Date, zone: string) => icsFmt(d, locale, zone, { year: "numeric", month: "numeric", day: "numeric" });
  const label = s.zoneLabel ? ` (${s.zoneLabel})` : "";
  const startDate = icsFmt(s.date, locale, s.zone, ICS_DATE_OPTS);
  const startTime = icsFmt(s.date, locale, s.zone, ICS_TIME_OPTS);
  // An end is comparable only on the same basis (both resolved, or both wall).
  const basis = end && !end.allDay && (end.epochMs !== null) === (start.epochMs !== null) ? displayBasis(end, opts.zone) : null;
  const e = basis && formattable(basis.date) ? basis : null;
  if (!e) return `${startDate} · ${startTime}${label}`;
  if (dayOf(s.date, s.zone) === dayOf(e.date, e.zone)) {
    return `${startDate} · ${startTime} – ${icsFmt(e.date, locale, e.zone, ICS_TIME_OPTS)}${label}`;
  }
  return `${startDate}, ${startTime} – ${icsFmt(e.date, locale, e.zone, ICS_DATE_OPTS)}, ${icsFmt(e.date, locale, e.zone, ICS_TIME_OPTS)}${label}`;
}

/** The calendar-page glyph's two lines, on the when-line's basis. */
export function icsDateGlyph(t: IcsTime, opts: IcsFormatOptions): { month: string; day: string } {
  const b = displayBasis(t, opts.zone);
  return {
    month: icsFmt(b.date, opts.locale, b.zone, { month: "short" }).replace(/\.$/, ""),
    day: icsFmt(b.date, opts.locale, b.zone, { day: "numeric" }),
  };
}

export type IcsKickerKey = "request" | "counter" | "cancelled" | "accepted" | "declined" | "tentative" | "reply" | "event";

/** What kind of calendar message is on screen, as a copy key: the METHOD said plainly. */
export function icsKicker(ev: IcsEventPreview): { key: IcsKickerKey; tone: "cancel" | null } {
  if (ev.cancelled) return { key: "cancelled", tone: "cancel" };
  switch (ev.method) {
    case "COUNTER":
      return { key: "counter", tone: null };
    case "REPLY":
      return {
        key: ev.replyStatus === "ACCEPTED" ? "accepted"
          : ev.replyStatus === "DECLINED" ? "declined"
            : ev.replyStatus === "TENTATIVE" ? "tentative"
              : "reply",
        tone: null,
      };
    case "REQUEST":
      return { key: "request", tone: null };
    default:
      return { key: "event", tone: null };
  }
}

/** A recurrence the card can say in one true line, as a copy key and its values. */
export type IcsRecurrenceSaying =
  | { key: "daily" | "weekly" | "monthly" | "yearly" }
  | { key: "everyNDays" | "everyNWeeks" | "everyNMonths" | "everyNYears"; n: number }
  | { key: "weeklyOn"; days: IcsWeekday[] }
  | { key: "everyNWeeksOn"; n: number; days: IcsWeekday[] };

export function icsRecurrence(rec: IcsRecurrence | null): IcsRecurrenceSaying | null {
  if (!rec) return null;
  const n = rec.interval;
  const days = rec.byDay;
  switch (rec.freq) {
    case "DAILY":
      return n === 1 ? { key: "daily" } : { key: "everyNDays", n };
    case "WEEKLY":
      if (n === 1) return days.length > 0 ? { key: "weeklyOn", days } : { key: "weekly" };
      return days.length > 0 ? { key: "everyNWeeksOn", n, days } : { key: "everyNWeeks", n };
    case "MONTHLY":
      // An ordinal BYDAY never reaches here (the parser refuses it): a plain monthly rule.
      return n === 1 ? { key: "monthly" } : { key: "everyNMonths", n };
    case "YEARLY":
      return n === 1 ? { key: "yearly" } : { key: "everyNYears", n };
  }
}

/** ICS weekday code → day of June 2026 on that weekday (June 1 is a Monday), for Intl naming. */
const WEEKDAY_ANCHOR: Record<IcsWeekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

export function icsWeekdayName(code: IcsWeekday, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 5, WEEKDAY_ANCHOR[code])));
}

/**
 * The people line's facts: on a REPLY the replier, otherwise the organizer and how many are
 * invited (`invited` null where none are). Names fall back to plain addresses, text only.
 */
export function icsPeople(ev: IcsEventPreview): { who: string | null; invited: number | null } {
  const nameOf = (p: IcsPerson | null): string | null => (p ? p.name || p.email : null);
  if (ev.method === "REPLY") return { who: nameOf(ev.attendees[0] ?? null) ?? nameOf(ev.organizer), invited: null };
  return { who: nameOf(ev.organizer), invited: ev.attendeeCount > 0 ? ev.attendeeCount : null };
}
