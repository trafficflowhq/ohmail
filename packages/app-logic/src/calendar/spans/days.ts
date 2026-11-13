/**
 * Days by name ("2026-11-16") and where a time falls among them in the reader's zone. Every day is a
 * civil day of cal-core's arithmetic: no `Date` getter, no browser zone, no `toISOString().slice`.
 */
import {
  intlZones,
  civilFromDays,
  daysFromCivil,
  instantOf,
  isValidDate,
  wallIn,
  weekdayOf,
  type EventTime,
  type Wall,
  type ZoneSource,
} from "@ohmail/cal-core";

/** A day by name: `YYYY-MM-DD`. */
export type DayId = string;
/** A month by name: `YYYY-MM`. */
export type MonthId = string;

/** Anything placed in time: an occurrence, a record's times. `end` is exclusive. */
export interface Placed {
  readonly start: EventTime;
  readonly end: EventTime;
}

let platform: ZoneSource | null = null;
/** The platform's zone rules, made once: what a view reads days with unless a test hands its own. */
export const readerZones = (): ZoneSource => (platform ??= intlZones());

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export const dayIdOf = (n: number): DayId => {
  const c = civilFromDays(n);
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`;
};

/** The day number of a day by name, or null for no real date. */
export function dayNumberOf(id: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(id ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(y, mo, d) ? daysFromCivil(y, mo, d) : null;
}

export const addDays = (id: DayId, n: number): DayId => dayIdOf(dayNumberOf(id)! + n);
export const monthOfDay = (id: DayId): MonthId => id.slice(0, 7);
export const firstOfMonth = (m: MonthId): DayId => `${m}-01`;
export function shiftMonth(m: MonthId, n: number): MonthId {
  const total = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
}
/** Monday 0 to Sunday 6. */
export const weekdayOfDay = (id: DayId): number => weekdayOf(dayNumberOf(id)!);
/** The first day of the week a day is in, the week starting on `weekStart` (Monday 0). */
export function weekStartOf(id: DayId, weekStart: number): DayId {
  const n = dayNumberOf(id)!;
  return dayIdOf(n - ((weekdayOf(n) - weekStart + 7) % 7));
}

/** Where a placed thing falls among days for one reader. */
export interface DaySpan {
  /** Its first and last day, both shown. */
  readonly first: DayId;
  readonly last: DayId;
  /** A date, not a moment: it stands over whole days. */
  readonly allDay: boolean;
  /** Minutes after midnight on its first day, on the reader's clock; null for a whole day. */
  readonly startMinute: number | null;
  /** The end's minutes after midnight on the reader's clock; null for a whole day. */
  readonly endMinute: number | null;
}

const minutesOf = (w: Wall): number => w.hour * 60 + w.minute;
const dayOfWall = (w: Wall): number => daysFromCivil(w.year, w.month, w.day);

/** The reader's clock at a time: a moment through the zone, a zoneless time as written. */
function clockOf(
  t: Exclude<EventTime, { kind: "date" }>,
  zone: string,
  zones: ZoneSource,
  back = 0,
): Wall | null {
  if (t.kind === "floating") {
    if (!back) return t.wall;
    const n = dayOfWall(t.wall) * 86_400 + t.wall.hour * 3600 + t.wall.minute * 60 + t.wall.second - 1;
    const c = civilFromDays(Math.floor(n / 86_400));
    const s = n - Math.floor(n / 86_400) * 86_400;
    return { ...c, hour: Math.floor(s / 3600), minute: Math.floor((s % 3600) / 60), second: s % 60 };
  }
  const at = instantOf(t, zones);
  return at === null ? null : wallIn(at.epochMs - back, zone, zones);
}

/**
 * The days a thing stands on for a reader in `zone`. A date's end is exclusive, so a one-day event
 * ends on its own day; a timed end at midnight belongs to the day before. Null where a zone is not
 * known here: such a time is not guessed onto a day.
 */
export function daySpanOf(p: Placed, zone: string, zones: ZoneSource = readerZones()): DaySpan | null {
  const { start, end } = p;
  if (start.kind === "date") {
    const a = daysFromCivil(start.year, start.month, start.day);
    const z = end.kind === "date" ? daysFromCivil(end.year, end.month, end.day) - 1 : a;
    return {
      first: dayIdOf(a),
      last: dayIdOf(Math.max(a, z)),
      allDay: true,
      startMinute: null,
      endMinute: null,
    };
  }
  const s = clockOf(start, zone, zones);
  if (s === null) return null;
  const a = dayOfWall(s);
  let z = a;
  let endMinute: number | null = minutesOf(s);
  if (end.kind !== "date") {
    /* The last instant it holds is a moment before its end; one with no length holds its start alone. */
    const e = clockOf(end, zone, zones, 1);
    const shown = clockOf(end, zone, zones);
    if (e === null || shown === null) return null;
    z = Math.max(a, dayOfWall(e));
    endMinute = minutesOf(shown);
  }
  return { first: dayIdOf(a), last: dayIdOf(z), allDay: false, startMinute: minutesOf(s), endMinute };
}
