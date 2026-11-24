/**
 * THE REPEAT PROOF'S CASES AND ITS TWO READINGS (MAP 3.8): every shape a series may be written in,
 * each as a whole day and as a clock time in Europe/Zurich, with UNTIL, with COUNT and with no end,
 * in each spelling the shape takes, and the days the shapes must also hold (29 February, the 31st,
 * 02:30 across both clock changes of the zone). A case's text is the CalDAV writer's own
 * (`newObjectText`): the proof is of what the product writes, not of a text written for it.
 *
 * One reading is the calendar core's (`expandSeries` over the case's window); the other is the
 * server's own expansion, read from the start lines it answered. A shape is proven at a server only
 * where every case of it was answered and both readings name the same days. No case carries an
 * invitee or an organizer: a provider's real account would mail them.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_LIMITS,
  expandSeries,
  intlZones,
  momentOrUtc,
  parseRRule,
  plainDate,
  readCalendar,
  seriesOf,
  wall,
  zoned,
  zonesOf,
  type CalEvent,
  type EventTime,
  type ZoneSource,
} from "@ohmail/cal-core";
import { newObjectText } from "../../src/caldav/edit.js";
import type { EventDraft } from "../../src/port.js";
import { repeatShapeAt, type RepeatShape } from "../../src/repeat-shapes.js";

export const PROOF_ZONE = "Europe/Zurich";
/** The stamp every case's text is written with, so that the same case is the same text. */
export const PROOF_NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY_MS = 86_400_000;
/** Midnight: a whole day starts there. */
const MIDNIGHT = "00:00:00";

export interface ProofCase {
  readonly name: string;
  /**
   * The shape the write path gives it (`repeatShapeAt`); `null` for a series the write path refuses
   * (a clock time its zone skips): recorded all the same, so the reason for the refusal stands beside it.
   */
  readonly shape: RepeatShape | null;
  readonly kind: "zoned" | "date";
  readonly rule: string;
  readonly draft: EventDraft;
  /** The window both readings are asked over, UTC milliseconds, from inclusive to exclusive. */
  readonly window: { readonly startMs: number; readonly endMs: number };
}

const blank = (start: EventTime, end: EventTime, rule: string, summary: string): EventDraft => ({
  start,
  end,
  summary,
  description: null,
  location: null,
  url: null,
  busy: true,
  private: false,
  rule: parseRRule(rule),
  organizer: null,
  attendees: [],
  alarms: [],
});

type Ymd = readonly [number, number, number];
const addDays = ([y, m, d]: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};
const ymd = ([y, m, d]: Ymd): string => `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;

/**
 * One spelling of a shape: its rule's parts, the day it starts on, how many days a run of six of
 * its days takes at most (for UNTIL and the window), and the hour of a clock-time case.
 */
interface Spelling {
  readonly base: string;
  readonly parts: string;
  readonly from: Ymd;
  readonly span: number;
  readonly hour?: number;
}

const SPELLINGS: readonly Spelling[] = [
  { base: "daily", parts: "FREQ=DAILY", from: [2026, 11, 23], span: 8 },
  { base: "every 3 days", parts: "FREQ=DAILY;INTERVAL=3", from: [2026, 11, 23], span: 20 },
  { base: "weekdays, weekly", parts: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", from: [2026, 11, 23], span: 12 },
  { base: "weekdays, daily", parts: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", from: [2026, 11, 23], span: 12 },
  { base: "weekly", parts: "FREQ=WEEKLY", from: [2026, 11, 23], span: 45 },
  { base: "weekly on its day", parts: "FREQ=WEEKLY;BYDAY=MO", from: [2026, 11, 23], span: 45 },
  {
    base: "two weeks, two days",
    parts: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
    from: [2026, 11, 23],
    span: 45,
  },
  { base: "weekly, two days", parts: "FREQ=WEEKLY;BYDAY=MO,WE", from: [2026, 11, 23], span: 24 },
  { base: "two weeks", parts: "FREQ=WEEKLY;INTERVAL=2", from: [2026, 11, 23], span: 80 },
  { base: "monthly by its day", parts: "FREQ=MONTHLY", from: [2026, 11, 23], span: 190 },
  { base: "monthly on the 23rd", parts: "FREQ=MONTHLY;BYMONTHDAY=23", from: [2026, 11, 23], span: 190 },
  { base: "monthly on the 31st", parts: "FREQ=MONTHLY;BYMONTHDAY=31", from: [2027, 1, 31], span: 370 },
  { base: "monthly from the 31st", parts: "FREQ=MONTHLY", from: [2027, 1, 31], span: 370 },
  { base: "monthly on the 29th", parts: "FREQ=MONTHLY;BYMONTHDAY=29", from: [2027, 1, 29], span: 220 },
  { base: "second Tuesday", parts: "FREQ=MONTHLY;BYDAY=2TU", from: [2026, 12, 8], span: 190 },
  { base: "last Friday", parts: "FREQ=MONTHLY;BYDAY=-1FR", from: [2026, 11, 27], span: 190 },
  { base: "yearly by its day", parts: "FREQ=YEARLY", from: [2026, 11, 23], span: 6 * 366 },
  {
    base: "yearly on 23 November",
    parts: "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=23",
    from: [2026, 11, 23],
    span: 6 * 366,
  },
  { base: "yearly from 29 February", parts: "FREQ=YEARLY", from: [2028, 2, 29], span: 21 * 366 },
  {
    base: "yearly on 29 February",
    parts: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
    from: [2028, 2, 29],
    span: 21 * 366,
  },
  {
    base: "fourth Thursday of November",
    parts: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
    from: [2026, 11, 26],
    span: 6 * 366,
  },
  {
    base: "last Monday of May",
    parts: "FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO",
    from: [2027, 5, 31],
    span: 6 * 366,
  },
  // A clock time the zone shows twice (31 October 2027) and one it skips (28 March 2027), by the day and by the week. A
  // series that meets a skipped time within its days (or within ten years, for one without an end or with a count) is
  // refused by the write path; such cases are recorded all the same, for why.
  {
    base: "daily at 02:30 out of summer time",
    parts: "FREQ=DAILY",
    from: [2027, 10, 28],
    span: 8,
    hour: 2.5,
  },
  {
    base: "weekly at 02:30 out of summer time",
    parts: "FREQ=WEEKLY;BYDAY=SU",
    from: [2027, 10, 17],
    span: 45,
    hour: 2.5,
  },
  { base: "daily at 02:30 into summer time", parts: "FREQ=DAILY", from: [2027, 3, 25], span: 8, hour: 2.5 },
  {
    base: "weekly at 02:30 into summer time",
    parts: "FREQ=WEEKLY;BYDAY=SU",
    from: [2027, 3, 14],
    span: 45,
    hour: 2.5,
  },
];

const ZONES: ZoneSource = intlZones();

/** Every case: each spelling, ended by UNTIL, by COUNT and not at all, as a clock time and (but at 02:30) as a whole day. */
function casesOf(): ProofCase[] {
  const out: ProofCase[] = [];
  for (const s of SPELLINGS) {
    for (const kind of s.hour === undefined ? (["zoned", "date"] as const) : (["zoned"] as const)) {
      for (const end of ["until", "count", "never"] as const) {
        const last = addDays(s.from, s.span);
        const hour = Math.floor(s.hour ?? 9);
        const minute = s.hour === undefined ? 0 : Math.round((s.hour % 1) * 60);
        const start: EventTime =
          kind === "date" ? plainDate(...s.from) : zoned(wall(...s.from, hour, minute), PROOF_ZONE);
        const finish: EventTime =
          kind === "date"
            ? plainDate(...addDays(s.from, 1))
            : zoned(wall(...s.from, hour + 1, minute), PROOF_ZONE);
        const until = kind === "date" ? ymd(last) : `${ymd(last)}T235959Z`;
        const rule =
          end === "until" ? `${s.parts};UNTIL=${until}` : end === "count" ? `${s.parts};COUNT=6` : s.parts;
        const draft = blank(start, finish, rule, `repeat proof: ${s.base}`);
        const shape = draft.rule === null ? null : repeatShapeAt(draft.rule, start, ZONES, PROOF_NOW);
        const first = Date.UTC(s.from[0], s.from[1] - 1, s.from[2]);
        // A series without an end is read over its span; one with an end over all of it and as long again.
        const window = {
          startMs: first - DAY_MS,
          endMs: first + (end === "never" ? s.span : 2 * s.span + 31) * DAY_MS,
        };
        out.push({
          name: `${s.base}, ${end === "never" ? "no end" : end === "count" ? "COUNT=6" : "UNTIL"}, ${kind === "date" ? "whole days" : "clock time"}`,
          shape,
          kind,
          rule,
          draft,
          window,
        });
      }
    }
  }
  return out;
}

export const PROOF_CASES: readonly ProofCase[] = casesOf();

/** The case's text as the CalDAV writer writes a new series, under `uid`. */
export function caseText(c: ProofCase, uid: string): string {
  const made = newObjectText(c.draft, uid, PROOF_NOW, ZONES);
  if (!made.ok) throw new Error(`the writer refuses the proof's case ${c.name}: ${made.reason}`);
  return made.text;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A UTC time as the format writes it, for a window's edge. */
export const utcText = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * One day of a reading: a whole day as its date, a clock time as its moment. Of a whole-day case, a
 * server that answers a day as its midnight (in UTC or on no clock) names that day.
 */
function dayOf(t: EventTime, zones: ZoneSource, wholeDays = false): string {
  if (t.kind === "date")
    return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  const at = new Date(
    t.kind === "floating"
      ? Date.UTC(t.wall.year, t.wall.month - 1, t.wall.day, t.wall.hour, t.wall.minute, t.wall.second)
      : momentOrUtc(t, zones),
  ).toISOString();
  return wholeDays && at.endsWith(`T${MIDNIGHT}.000Z`) ? at.slice(0, 10) : at;
}

/** The days inside the window, each once, in order. */
const within = (days: readonly { day: string; ms: number }[], c: ProofCase): string[] =>
  [
    ...new Set(days.filter((d) => d.ms >= c.window.startMs && d.ms < c.window.endMs).map((d) => d.day)),
  ].sort();

/** The calendar core's reading of a case's text: the starts `expandSeries` gives over the case's window. */
export function coreDays(c: ProofCase, text: string): string[] {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) throw new Error(`the core does not read the case ${c.name}`);
  const zones = zonesOf(read.calendar, ZONES);
  const [series] = seriesOf(read.calendar.events, zones);
  const found = expandSeries(series!, { ...c.window, viewerZone: PROOF_ZONE }, zones);
  if (found.capped) throw new Error(`the core's reading of ${c.name} stopped at a ceiling`);
  return within(
    found.occurrences.map((o) => ({ day: dayOf(o.start, zones), ms: momentOrUtc(o.start, zones) })),
    c,
  );
}

/**
 * The server's reading: its answer's start lines, one for each day it worked out (`DTSTART` lines of
 * the components its expansion answered, as they were written). A component that still carries its
 * rule was not expanded: that answer reads `null`, "not answered", and proves nothing.
 */
export function serverStartLines(data: string): string[] | null {
  const read = readCalendar(data, DEFAULT_LIMITS);
  if (!read.ok) return null;
  if (read.calendar.events.some((e) => e.rules.length > 0)) return null;
  const unfolded = data.replace(/\r?\n[ \t]/g, "");
  return [...unfolded.matchAll(/^DTSTART[;:].*$/gm)].map((m) => m[0].trimEnd());
}

/** The days the server's start lines name, read by the calendar core's own reader of a line. */
export function serverDays(c: ProofCase, lines: readonly string[]): string[] {
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ohmail//repeat proof//EN",
    ...lines.flatMap((line, i) => [
      "BEGIN:VEVENT",
      `UID:server-day-${i}`,
      "DTSTAMP:20261115T120000Z",
      line,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) throw new Error(`the server's lines for ${c.name} do not read`);
  const zones = zonesOf(read.calendar, ZONES);
  return within(
    read.calendar.events.map((e) => ({
      day: dayOf(e.start!, zones, c.kind === "date"),
      ms: momentOrUtc(e.start!, zones),
    })),
    c,
  );
}

/** One case as a server answered it: what was written (by its digest), how it was answered, and its start lines. */
export interface RecordedCase {
  readonly name: string;
  readonly shape: RepeatShape | null;
  readonly written: string;
  readonly put: number;
  readonly answered: "expand" | "not answered";
  readonly status: number;
  readonly server: readonly string[];
  /** The stored object's own RRULE and DTSTART lines, read back: the rule is kept as written. */
  readonly kept: readonly string[];
}

export interface ProofRecord {
  readonly server: string;
  /** Where the run was made, as a connection to that server names its place (`proofPlaceOf`): the row it proves is that place's alone. */
  readonly place: string;
  readonly how: string;
  readonly cases: readonly RecordedCase[];
}

/** Did the server keep the rule and the start as written? Both read by the core, both lines whole. */
export function keptAsWritten(text: string, kept: readonly string[]): boolean {
  const lines = (t: string): string[] =>
    [...t.replace(/\r?\n[ \t]/g, "").matchAll(/^(RRULE|DTSTART)[;:].*$/gm)].map((m) => m[0].trimEnd()).sort();
  return JSON.stringify(lines(text)) === JSON.stringify([...kept].sort());
}

/** A recorded case agrees: answered, kept, and both readings name the same days. */
export function agrees(c: ProofCase, r: RecordedCase): boolean {
  if (r.put !== 201 || r.answered !== "expand" || r.status !== 207) return false;
  const text = caseText(c, uidOf(c));
  return (
    keptAsWritten(text, r.kept) &&
    JSON.stringify(serverDays(c, r.server)) === JSON.stringify(coreDays(c, text))
  );
}

/** The UID a case is written under: from its place in the list, so a record names it again. */
export function uidOf(c: ProofCase): string {
  return `repeat-proof-${PROOF_CASES.indexOf(c) + 1}@bench.example`;
}

/** The shapes a record proves: every case of the shape recorded, and every one agreeing. */
export function provenBy(record: ProofRecord): RepeatShape[] {
  const byName = new Map(record.cases.map((r) => [r.name, r] as const));
  const shapes = [...new Set(PROOF_CASES.flatMap((c) => (c.shape === null ? [] : [c.shape])))];
  return shapes
    .filter((shape) =>
      PROOF_CASES.filter((c) => c.shape === shape).every((c) => {
        const r = byName.get(c.name);
        return r !== undefined && r.written === sha256(caseText(c, uidOf(c))) && agrees(c, r);
      }),
    )
    .sort();
}

// ── Google ───────────────────────────────────────────────────────────────────────

/** One case as Google answered it: the series as Google keeps it (its times and its repeat), and the start of each day `instances` named. */
export interface GoogleRecordedCase {
  readonly name: string;
  readonly shape: RepeatShape | null;
  /** The body sent, by its digest (the Google writer's own `bodyOf`). */
  readonly written: string;
  readonly insert: number;
  readonly status: number;
  /** The series' own record as read back: `start`, `end` and `recurrence` only (no person's address is kept). */
  readonly master: { readonly start: unknown; readonly end: unknown; readonly recurrence: unknown };
  /** Each day's `start`, as `instances` answered it. */
  readonly days: readonly unknown[];
}

export interface GoogleProofRecord {
  readonly server: "google";
  readonly how: string;
  readonly cases: readonly GoogleRecordedCase[];
}

/**
 * The calendar core's reading of the series as Google keeps it: the record read by the reader's own
 * converter, expanded over the case's window. A series Google keeps otherwise than it was written
 * is read as kept, and its days then part from the case's own.
 */
export function googleCoreDays(
  c: ProofCase,
  master: GoogleRecordedCase["master"],
  convert: (raw: unknown) => CalEvent | null,
): string[] {
  const event = convert({
    id: "proof",
    status: "confirmed",
    iCalUID: "proof@bench.example",
    summary: "proof",
    ...master,
  });
  if (event === null) return [];
  const [series] = seriesOf([event], ZONES);
  const found = expandSeries(series!, { ...c.window, viewerZone: PROOF_ZONE }, ZONES);
  return within(
    found.occurrences.map((o) => ({ day: dayOf(o.start, ZONES), ms: momentOrUtc(o.start, ZONES) })),
    c,
  );
}

/** Google's own days: each `start` of `instances`, a whole day as its date, a time as its moment. */
export function googleServerDays(c: ProofCase, days: readonly unknown[]): string[] {
  const read = days.flatMap((d) => {
    const s = d as { date?: unknown; dateTime?: unknown };
    if (typeof s.date === "string") return [{ day: s.date, ms: Date.parse(`${s.date}T${MIDNIGHT}Z`) }];
    if (typeof s.dateTime === "string" && Number.isFinite(Date.parse(s.dateTime))) {
      const ms = Date.parse(s.dateTime);
      return [{ day: new Date(ms).toISOString(), ms }];
    }
    return [];
  });
  return within(read, c);
}

/** The shapes a Google record proves: every case of the shape recorded on the body the writer builds today, inserted, listed, and agreeing. */
export function provenByGoogle(
  record: GoogleProofRecord,
  body: (c: ProofCase) => unknown,
  convert: (raw: unknown) => CalEvent | null,
): RepeatShape[] {
  const byName = new Map(record.cases.map((r) => [r.name, r] as const));
  const shapes = [...new Set(PROOF_CASES.flatMap((c) => (c.shape === null ? [] : [c.shape])))];
  return shapes
    .filter((shape) =>
      PROOF_CASES.filter((c) => c.shape === shape).every((c) => {
        const r = byName.get(c.name);
        return (
          r !== undefined &&
          r.written === sha256(JSON.stringify(body(c))) &&
          r.insert === 200 &&
          r.status === 200 &&
          JSON.stringify(googleServerDays(c, r.days)) === JSON.stringify(googleCoreDays(c, r.master, convert))
        );
      }),
    )
    .sort();
}
