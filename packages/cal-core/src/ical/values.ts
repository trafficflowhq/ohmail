/**
 * The value types a calendar property holds (RFC 5545 section 3.3): text, date, date-time, period,
 * UTC offset, calendar address and duration. Each is read to a plain value or `null`, never by
 * throwing, and written back in the standard's own form.
 */
import { isValidDate, MS_PER_SECOND, wallFromSeconds, wallSeconds } from "../time/arith.js";
import type { Duration } from "../time/duration.js";
import type { EventTime, PlainDate, Wall } from "../time/types.js";
import type { Param, Property } from "./component.js";
import { makeParam, paramOf, sameName } from "./lines.js";

/* ── TEXT (section 3.3.11) ──────────────────────────────────────────────────────────────────────── */

const [BACKSLASH, COMMA, SEMICOLON, SMALL_N, CAPITAL_N] = [0x5c, 0x2c, 0x3b, 0x6e, 0x4e];

/**
 * `\n` and `\N` are a line break; `\\`, `\,` and `\;` the character itself; any other backslash stays
 * as written. The text between two escapes is taken as one slice and the slices are joined once:
 * a value put together one character at a time is held as a chain of its pieces, many times its
 * size, until somebody reads it through.
 */
export function unescapeText(value: string): string {
  let at = value.indexOf("\\");
  if (at < 0) return value;
  const pieces: string[] = [];
  let from = 0;
  while (at >= 0 && at + 1 < value.length) {
    const next = value.charCodeAt(at + 1);
    if (next === SMALL_N || next === CAPITAL_N) {
      pieces.push(value.slice(from, at), "\n");
      from = at + 2;
      at = value.indexOf("\\", from);
    } else if (next === BACKSLASH || next === COMMA || next === SEMICOLON) {
      // The backslash goes; the character it stood before begins the next slice and is not looked at again.
      pieces.push(value.slice(from, at));
      from = at + 1;
      at = value.indexOf("\\", at + 2);
    } else at = value.indexOf("\\", at + 1);
  }
  if (from === 0) return value;
  pieces.push(value.slice(from));
  return pieces.join("");
}

export const escapeText = (text: string): string => text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n?|\n/g, "\\n");

/** A list of texts (CATEGORIES): cut at commas that are not escaped, each member a slice of the value, unescaped. */
export function splitTextList(value: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // An escaped character cuts nothing, a comma among them.
    if (c === BACKSLASH) i++;
    else if (c === COMMA) {
      parts.push(unescapeText(value.slice(from, i)));
      from = i + 1;
    }
  }
  parts.push(unescapeText(value.slice(from)));
  return parts;
}

/* ── DATE and DATE-TIME (sections 3.3.4 and 3.3.5) ──────────────────────────────────────────────── */

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function parseDate(value: string): PlainDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(year, month, day) ? { kind: "date", year, month, day } : null;
}

/** A clock reading and whether it carries the trailing Z. Seconds may be left out; a leap second reads as :59. */
export function parseDateTime(value: string): { wall: Wall; utc: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const second = Math.min(Number(m[6] ?? 0), 59);
  if (!isValidDate(year, month, day) || hour > 23 || minute > 59 || Number(m[6] ?? 0) > 60) return null;
  return { wall: { year, month, day, hour, minute, second }, utc: m[7] === "Z" };
}

/** What a line's parameters say about the times it holds: that they are dates whatever they look like (`VALUE=DATE`), and the zone they are in. */
interface TimeForm {
  readonly date: boolean;
  readonly tzid: string | null;
}
const formOf = (p: Property): TimeForm => ({ date: (paramOf(p, "VALUE") ?? "").toUpperCase() === "DATE", tzid: paramOf(p, "TZID") });

function timeIn(text: string, form: TimeForm): EventTime | null {
  const value = text.trim();
  if (form.date || /^\d{8}$/.test(value)) return parseDate(value.slice(0, 8));
  const parsed = parseDateTime(value);
  if (parsed === null) return null;
  if (parsed.utc) return { kind: "instant", epochMs: wallSeconds(parsed.wall) * MS_PER_SECOND };
  return form.tzid ? { kind: "zoned", wall: parsed.wall, tzid: form.tzid } : { kind: "floating", wall: parsed.wall };
}

/**
 * The time a DATE or DATE-TIME property holds, in its kind: a date for `VALUE=DATE` or a bare date,
 * an instant for the trailing Z, a clock time in a zone where `TZID` names one, else a clock time
 * with no zone.
 */
export const timeOf = (p: Property): EventTime | null => timeIn(p.value, formOf(p));

/**
 * The times a list property holds (EXDATE, RDATE): comma-separated, each in the kind the line's
 * parameters give. The parameters are asked once for the line, not once for each time it lists.
 */
export function timesOf(p: Property): EventTime[] {
  const form = formOf(p);
  const times: EventTime[] = [];
  for (const one of p.value.split(",")) {
    const t = timeIn(one, form);
    if (t !== null) times.push(t);
  }
  return times;
}

export const formatDate = (d: { year: number; month: number; day: number }): string => `${pad(d.year, 4)}${pad(d.month)}${pad(d.day)}`;
export const formatWall = (w: Wall): string => `${formatDate(w)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
/** An instant in the trailing-Z form, to the second. */
export const formatInstant = (epochMs: number): string => `${formatWall(wallFromSeconds(Math.floor(epochMs / MS_PER_SECOND)))}Z`;

/** A property holding this time, in the form its kind is written in. Other parameters come first, as given. */
export function timeProperty(name: string, t: EventTime, others: readonly Param[] = []): Property {
  const kept = others.filter((p) => !sameName(p.name, "VALUE") && !sameName(p.name, "TZID"));
  switch (t.kind) {
    case "date":
      return { name, params: [...kept, makeParam("VALUE", ["DATE"])], value: formatDate(t) };
    case "instant":
      return { name, params: kept, value: formatInstant(t.epochMs) };
    case "zoned":
      return { name, params: [...kept, makeParam("TZID", [t.tzid])], value: formatWall(t.wall) };
    case "floating":
      return { name, params: kept, value: formatWall(t.wall) };
  }
}

/* ── DURATION (section 3.3.6) ───────────────────────────────────────────────────────────────────── */

export function parseDuration(value: string): Duration | null {
  const m = /^([+-])?P(?:(\d{1,9})W)?(?:(\d{1,9})D)?(?:T(?:(\d{1,9})H)?(?:(\d{1,9})M)?(?:(\d{1,9})S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  if (!w && !d && !h && !mi && !s) return null;
  return { negative: sign === "-", weeks: Number(w ?? 0), days: Number(d ?? 0), hours: Number(h ?? 0), minutes: Number(mi ?? 0), seconds: Number(s ?? 0) };
}

export function formatDuration(d: Duration): string {
  const days = `${d.weeks ? `${d.weeks}W` : ""}${d.days ? `${d.days}D` : ""}`;
  // The grammar has no empty duration: a length of nothing is written as its zero seconds.
  const seconds = d.seconds || (days === "" && !d.hours && !d.minutes) ? `${d.seconds}S` : "";
  const clock = `${d.hours ? `${d.hours}H` : ""}${d.minutes ? `${d.minutes}M` : ""}${seconds}`;
  return `${d.negative ? "-" : ""}P${days}${clock ? `T${clock}` : ""}`;
}

/* ── PERIOD (section 3.3.9) ─────────────────────────────────────────────────────────────────────── */

export interface Period {
  readonly start: { readonly wall: Wall; readonly utc: boolean };
  /** One of the two is set: an explicit end, or a length. */
  readonly end: { readonly wall: Wall; readonly utc: boolean } | null;
  readonly duration: Duration | null;
}

export function parsePeriod(value: string): Period | null {
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  const start = parseDateTime(value.slice(0, slash).trim());
  const rest = value.slice(slash + 1).trim();
  if (start === null) return null;
  const end = parseDateTime(rest);
  if (end !== null) return { start, end, duration: null };
  const duration = parseDuration(rest);
  return duration === null || duration.negative ? null : { start, end: null, duration };
}

/* ── UTC-OFFSET (section 3.3.14) ────────────────────────────────────────────────────────────────── */

/** `+0100`, `-0500`, `+003408` as seconds east of UTC. */
export function parseUtcOffset(value: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const [hours, minutes, seconds] = [Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
  if (minutes > 59 || seconds > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 3600 + minutes * 60 + seconds);
}

export function formatUtcOffset(seconds: number): string {
  const abs = Math.abs(seconds);
  const tail = abs % 60 ? pad(abs % 60) : "";
  return `${seconds < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600))}${pad(Math.floor((abs % 3600) / 60))}${tail}`;
}

/* ── CAL-ADDRESS (section 3.3.3) ────────────────────────────────────────────────────────────────── */

/** RFC 5321's limit: a longer `mailto:` is no address. */
const ADDRESS_MAX = 254;

/** The mail address of a calendar address: lower case, any `?query` cut. `null` for every other scheme. */
export function mailAddressOf(value: string): string | null {
  const v = value.trim();
  if (!/^mailto:/i.test(v)) return null;
  const address = v.slice("mailto:".length).split("?")[0]!.trim().toLowerCase();
  return address.includes("@") && address.length <= ADDRESS_MAX ? address : null;
}
