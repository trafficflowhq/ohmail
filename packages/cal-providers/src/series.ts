/**
 * A SERIES' DAYS WHEN ITS FIRST DAY MOVES, AND WHEN IT GOES ON FROM ONE OF ITS DAYS AS A SERIES OF ITS
 * OWN: one reckoning for the door that records a person's act and for the drain that writes it, so
 * that both refuse alike and both mean the same series. Pure: the calendar core's expansion of the
 * series' own rule, no clock and no request.
 */
import {
  DEFAULT_LIMITS,
  eventOf,
  expandSeries,
  instant,
  momentOrUtc,
  newEventComponent,
  plainDate,
  readCalendar,
  recurrenceKeyString,
  sameName,
  seriesOf,
  timeProperty,
  wall,
  wallIn,
  zoned,
  type CalEvent,
  type EventTime,
  type Property,
  type RRule,
  type Wall,
  type ZoneSource,
} from "@ohmail/cal-core";

const DAY_MS = 86_400_000;

type Day = { readonly year: number; readonly month: number; readonly day: number };

/** A time's day on its own clock: a whole day's, or a clock time's; none for a time told in UTC. */
function dayOf(t: EventTime): Day | null {
  if (t.kind === "date") return t;
  return t.kind === "zoned" || t.kind === "floating" ? t.wall : null;
}

const sameDay = (a: Day, b: Day): boolean => a.year === b.year && a.month === b.month && a.day === b.day;

const sameWall = (a: Wall, b: Wall): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second;

/** The same time, told the same way. */
export function sameTime(a: EventTime, b: EventTime): boolean {
  switch (a.kind) {
    case "date":
      return b.kind === "date" && sameDay(a, b);
    case "instant":
      return b.kind === "instant" && a.epochMs === b.epochMs;
    case "zoned":
      return b.kind === "zoned" && a.tzid === b.tzid && sameWall(a.wall, b.wall);
    case "floating":
      return b.kind === "floating" && sameWall(a.wall, b.wall);
  }
}

/**
 * A moment as the series whose first day is `first` tells its days: a whole day's (a whole day's key
 * is its UTC midnight), or a clock time in the series' zone; none for a series told otherwise.
 */
export function clockOf(first: EventTime, ms: number, zones: ZoneSource): EventTime | null {
  if (first.kind === "date") {
    const d = new Date(ms);
    return plainDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (first.kind !== "zoned") return null;
  const w = wallIn(ms, first.tzid, zones);
  return w === null ? null : zoned(w, first.tzid);
}

/**
 * The days of the series of `rule` from `first`, as the core expands them between two moments (`firstEnd`: the first day's end,
 * `null` for a series kept with a length: its days start where they start all the same); `null` where it stops at its ceiling.
 */
function daysOf(
  rule: RRule,
  first: EventTime,
  firstEnd: EventTime | null,
  fromMs: number,
  toMs: number,
  zones: ZoneSource,
): readonly EventTime[] | null {
  const master = eventOf(
    newEventComponent({
      uid: "series",
      dtstamp: instant(0),
      start: first,
      ...(firstEnd === null ? {} : { end: firstEnd }),
      rule,
    }),
  );
  const [series] = seriesOf([master], zones);
  if (series === undefined) return null;
  const found = expandSeries(
    series,
    { startMs: fromMs, endMs: toMs, viewerZone: first.kind === "zoned" ? first.tzid : "Etc/UTC" },
    zones,
  );
  return found.capped ? null : found.occurrences.map((o) => o.start);
}

/** Where a series that ends before a day ends: the day before it for whole days, the second before it for a time. */
export function endBefore(day: EventTime, zones: ZoneSource): RRule["until"] {
  const at = momentOrUtc(day, zones);
  if (day.kind !== "date") return instant(at - 1_000);
  const before = new Date(at - DAY_MS);
  return plainDate(before.getUTCFullYear(), before.getUTCMonth() + 1, before.getUTCDate());
}

/**
 * Does the series of `rule` from its first day `first` end before its day at the moment `at`: its end on a day (UNTIL) before that
 * day, or its count of days all made before it? Such a day is past the series' end, not a day its rule does not name: it may stand
 * in a series of its own, made from another copy of the series (the fourth recheck's finding of a removal shown done while its
 * days stand). `firstEnd`: as {@link daysOf} takes it.
 */
export function endsBeforeDay(
  rule: RRule,
  first: EventTime | null,
  firstEnd: EventTime | null,
  at: number,
  zones: ZoneSource,
): boolean {
  const until = rule.until;
  if (until !== null)
    return until.kind === "date"
      ? at >= Date.UTC(until.year, until.month - 1, until.day + 1)
      : until.kind === "instant" && at > until.epochMs;
  if (rule.count === null || first === null) return false;
  const made = daysOf(rule, first, firstEnd, momentOrUtc(first, zones) - DAY_MS, at, zones);
  return made !== null && made.filter((d) => momentOrUtc(d, zones) < at).length >= rule.count;
}

/**
 * The rule of a series whose day `first` is its first, ended before its day at the moment `at`
 * (UNTIL there, in place of any count), as a series' end writes it; `null` for a series whose
 * clock cannot tell that day.
 */
export function endedRule(rule: RRule, first: EventTime, at: number, zones: ZoneSource): RRule | null {
  const day = clockOf(first, at, zones);
  return day === null ? null : { ...rule, count: null, until: endBefore(day, zones) };
}

/**
 * The rule of a series whose day `from` (its first day, or the day it goes on from as a series of
 * its own) moves to `to`. A rule that ends on a day (UNTIL) ends on its last day at the time `to`
 * takes, so that no day falls off its end and none is added. A rule without UNTIL, and one whose
 * day does not move, are as they are. `null` where the end cannot be moved so: `to` is on another
 * day than `from` (where its last day went is then the person's to say, by naming the repeat), or
 * is a time told in UTC or on no zone, or the core finds no last day, or the end lies in the stretch
 * its zone skips on a night the series' clock time is skipped ({@link untilSkipped}: whether that
 * night is the series' last day, the server and the core may disagree).
 */
export function movedRule(
  rule: RRule,
  first: EventTime,
  firstEnd: EventTime,
  from: EventTime,
  to: EventTime,
  zones: ZoneSource,
): RRule | null {
  if (rule.until === null || sameTime(from, to)) return rule;
  if (untilSkipped({ first, firstEnd, rule }, zones)) return null;
  const was = dayOf(from);
  const now = dayOf(to);
  if (was === null || now === null || !sameDay(was, now)) return null;
  const untilMs = momentOrUtc(rule.until, zones);
  const days = daysOf(rule, first, firstEnd, momentOrUtc(first, zones) - DAY_MS, untilMs + 2 * DAY_MS, zones);
  const last = days === null || days.length === 0 ? null : dayOf(days[days.length - 1]!);
  if (last === null) return null;
  if (to.kind === "date") return { ...rule, until: plainDate(last.year, last.month, last.day) };
  if (to.kind !== "zoned") return null;
  const at = momentOrUtc(
    zoned(wall(last.year, last.month, last.day, to.wall.hour, to.wall.minute, to.wall.second), to.tzid),
    zones,
  );
  return Number.isFinite(at) ? { ...rule, until: instant(at) } : null;
}

/** A series as it is stored: its first day's start and end, and its one rule. */
export interface StoredSeries {
  readonly first: EventTime;
  readonly firstEnd: EventTime;
  readonly rule: RRule;
}

/**
 * Is the day the key names (a moment's key) one of the series' days at a clock time that is not
 * the series' own: a series at a clock time in a zone, on a night that clock time does not exist
 * (the clocks go forward over it), where the calendar core places that day later on the clock (an
 * hour later in Zurich: 02:30 is 03:30 there) and a server may place it elsewhere? No write names
 * such a day: what it would be written at is a guess (the second recheck's fourth finding). `false`
 * for a series told otherwise, a key told otherwise than by a moment, and a key that names no day
 * of the series (another check's to refuse).
 */
export function offItsClock(series: StoredSeries, key: string, zones: ZoneSource): boolean {
  const { first } = series;
  if (first.kind !== "zoned" || !/^-?\d{1,16}$/.test(key) || !Number.isSafeInteger(Number(key))) return false;
  const w = wallIn(Number(key), first.tzid, zones);
  if (
    w !== null &&
    w.hour === first.wall.hour &&
    w.minute === first.wall.minute &&
    w.second === first.wall.second
  )
    return false;
  return isDayOf(series, [], key, zones) === true;
}

/**
 * Does the series' end on a day (UNTIL) lie in the stretch its zone skips on a night the series'
 * clock time is skipped, and that night one its rule names: between the moment the offset after the
 * jump gives that clock time and the moment the calendar core gives it (the offset before)? There a
 * server may count that night as the series' last day where the core does not (the bench's own
 * server does from the jump on): a new time, which moves the end to the core's last day, would lose
 * the server's. `false` for a series told otherwise, or ending otherwise.
 */
export function untilSkipped(series: StoredSeries, zones: ZoneSource): boolean {
  const { first, rule } = series;
  if (first.kind !== "zoned" || rule.until === null || rule.until.kind !== "instant") return false;
  const u = rule.until.epochMs;
  const near = wallIn(u, first.tzid, zones);
  if (near === null) return false;
  const named = { ...series, rule: { ...rule, until: null, count: null } };
  for (const shift of [-1, 0, 1]) {
    const d = new Date(Date.UTC(near.year, near.month - 1, near.day + shift));
    const clock = wall(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      first.wall.hour,
      first.wall.minute,
      first.wall.second,
    );
    const core = momentOrUtc(zoned(clock, first.tzid), zones);
    const at = Number.isFinite(core) ? wallIn(core, first.tzid, zones) : null;
    // That night's clock time is on the clock: nothing is skipped there.
    if (at === null || sameWall(at, clock)) continue;
    const after = zones.offsetAt(first.tzid, core);
    if (after === null) continue;
    const local = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
    const [lo, hi] = [Math.min(local - after, core), Math.max(local - after, core)];
    if (u >= lo && u < hi && isDayOf(named, [], String(core), zones) === true) return true;
  }
  return false;
}

/** What a press on a day and the days after it names for those days: a new start and end (both, or neither), a repeat of their own. */
export interface ContinuedChange {
  readonly start?: EventTime;
  readonly end?: EventTime;
  readonly rule?: RRule;
}

/**
 * The series the days of `series` from its day `at` on (the moment that day was first at) become:
 * from that day (at the series' own time, or at the change's), with the series' own repeat, a count
 * going on with what is left of it and an end (UNTIL) moved with the time ({@link movedRule}), or the
 * repeat the change names. `null` where those days cannot go on so: a series neither of whole days
 * nor of a clock time in a zone, a count with nothing left, or an end that cannot be moved.
 */
export function continuedSeries(
  series: StoredSeries,
  at: number,
  change: ContinuedChange,
  zones: ZoneSource,
): { readonly start: EventTime; readonly end: EventTime; readonly rule: RRule } | null {
  const { first, firstEnd, rule } = series;
  if (first.kind !== "zoned" && first.kind !== "date") return null;
  // The day it goes on from, at the time the series keeps.
  const clock = (ms: number): EventTime | null => clockOf(first, ms, zones);
  const cut = clock(at);
  if (cut === null) return null;
  // A count goes on with what is left of it.
  let left = rule.count;
  if (left !== null) {
    const before = daysOf(rule, first, firstEnd, momentOrUtc(first, zones) - DAY_MS, at, zones);
    if (before === null) return null;
    left -= before.filter((d) => momentOrUtc(d, zones) < at).length;
    if (left <= 0) return null;
  }
  let start = change.start;
  let end = change.end;
  if (start === undefined || end === undefined) {
    const made = clock(at + (momentOrUtc(firstEnd, zones) - momentOrUtc(first, zones)));
    if (made === null) return null;
    start = cut;
    end = made;
  }
  if (change.rule !== undefined) return { start, end, rule: change.rule };
  const next = movedRule({ ...rule, count: left }, first, firstEnd, cut, start, zones);
  return next === null ? null : { start, end, rule: next };
}

/**
 * The days a series excludes from its day `cut` on (`cut`: that day on the series' own clock, a
 * clock time in its zone or a whole day; `excluded`: each told as the stored object tells it), as a
 * series of their own that starts at `start` has them: as they are where its days keep their time;
 * at the new time where it starts later or earlier on the very day `cut` names (an excluded day that
 * names none of the series' days excludes nothing, and is not carried). `null` where they cannot be
 * carried: a series of its own on another day than `cut`'s, or a series of whole days going on at a
 * clock time or on another day, where its excluded days would be a guess. One reckoning for the
 * door, which refuses such a press, and for the writer, which makes no such series and sends
 * nothing of the press.
 */
export function carriedExclusions(
  cut: EventTime,
  excluded: readonly EventTime[],
  start: EventTime,
  zones: ZoneSource,
): EventTime[] | null {
  const from = momentOrUtc(cut, zones);
  const kept = excluded.filter((e) => momentOrUtc(e, zones) >= from);
  if (kept.length === 0 || sameTime(cut, start)) return [...kept];
  if (cut.kind !== "zoned" || (start.kind !== "zoned" && start.kind !== "date")) return null;
  if (!sameDay(cut.wall, start.kind === "zoned" ? start.wall : start)) return null;
  const out: EventTime[] = [];
  for (const e of kept) {
    // The excluded day on the series' own clock: one of its days is at the series' time.
    const w = wallIn(momentOrUtc(e, zones), cut.tzid, zones);
    if (w === null) return null;
    if (w.hour !== cut.wall.hour || w.minute !== cut.wall.minute || w.second !== cut.wall.second) continue;
    out.push(
      start.kind === "date"
        ? plainDate(w.year, w.month, w.day)
        : zoned(
            wall(w.year, w.month, w.day, start.wall.hour, start.wall.minute, start.wall.second),
            start.tzid,
          ),
    );
  }
  return out;
}

/**
 * What a write reads off a stored object's own text, where the store keeps no field of it yet (the
 * event's own component: the series' own, or the one event's). Asked by the door and by the drain
 * alike, of the text the store holds; where it holds none (a provider that keeps no calendar text),
 * of the store's own fields.
 */
export interface StoredObjectFacts {
  /**
   * Whom the stored object names as its organizer, read so that an event is the account's own
   * only where its text shows it so (the second recheck's third finding): `null` where none of its
   * events carries an ORGANIZER line in any spelling ({@link spelledAs}) and none carries an invitee
   * the reader takes no mail address from; else the one mail address its ORGANIZER lines name, in
   * lower case; `""` in every other case: a line in a spelling the reader does not take (no content
   * line, a blank or a group before its name), a line that names no mail address (a principal's
   * path, a urn, an address with no scheme, no value), two such lines in one event or two addresses
   * across its events, no ORGANIZER line beside an invitee the reader takes no address from, an
   * object that cannot be read whole. `""` is never one of the account's own addresses, so such an
   * event is someone else's. Without a text, the store's own organizer.
   */
  readonly organizer: string | null;
  /**
   * The event's own component excludes days by a rule of its own (EXRULE) beside its one repeat,
   * which the calendar core does not follow: a series of more than one rule, which no write makes.
   */
  readonly excludesByRule: boolean;
  /**
   * The days the series cancels by a component of their own ({@link cancelledDaysOf}), by the time
   * each was first at: excluded days as surely as its EXDATE lines', which the store keeps.
   */
  readonly cancelled: readonly EventTime[];
  /**
   * A changed day of the series speaks for the days after it too (RANGE=THISANDFUTURE: moved or
   * cancelled from there on): a series of their own made of its days from one on would lose what
   * it says of them, so the series is not split.
   */
  readonly reachesForward: boolean;
}

export function storedObjectFacts(text: string | null, organizer: string | null): StoredObjectFacts {
  const none = { excludesByRule: false, cancelled: [], reachesForward: false };
  if (text === null) return { organizer, ...none };
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) return { organizer: "", ...none };
  const events = read.calendar.events;
  // The series' own component; a lone event where nothing of the object was left out (else it may be a changed day whose series was).
  const own =
    events.find((e) => e.recurrenceId === null) ??
    (events.length === 1 && read.dropped.length === 0 ? events[0]! : null);
  if (own === null) return { organizer: "", ...none };
  return {
    // An object read with something left out does not show whose it is.
    organizer: read.dropped.length > 0 ? "" : organizerShown(events),
    excludesByRule: own.component.properties.some((p) => sameName(p.name, "EXRULE")),
    cancelled: cancelledDaysOf(events, own),
    reachesForward: events.some(
      (e) => e !== own && e.uid === own.uid && e.recurrenceId !== null && e.thisAndFuture,
    ),
  };
}

/** Blanks, control and format characters (a zero-width space among them), at either end of a line's name. */
const NAME_EDGES = /^[\s\p{Cc}\p{Cf}]+|[\s\p{Cc}\p{Cf}]+$/gu;
/** A group before a name (`item1.`), as a contact card's lines are written. */
const NAME_GROUP = /^(?:[^.;:,="\s]+\.)+/;

/**
 * Is this line of an event written under `name` in a spelling some reader may take for it, whether
 * or not this program's reader does? A content line whose name, its blanks, control and format
 * characters cut from its ends and a group before it dropped, begins with `name` in any case and
 * goes on with nothing a name is made of; or no content line at all (no colon outside quotes, a
 * quote never closed, a fold broken) whose text, cut and dropped so, begins with `name` in any case.
 */
export function spelledAs(p: Property, name: string): boolean {
  const cut = (s: string): string =>
    s.replace(NAME_EDGES, "").replace(NAME_GROUP, "").replace(NAME_EDGES, "");
  if (p.name === "") return cut(p.value).toUpperCase().startsWith(name);
  const head = cut(p.name).toUpperCase();
  return head.startsWith(name) && !/^[A-Z0-9-]/.test(head.slice(name.length));
}

/** Is this line one the calendar core's reader takes under `name` (its name that word in any case, and nothing else)? */
const readAs = (p: Property, name: string): boolean => p.name !== "" && p.name.toUpperCase() === name;

/**
 * Whom an object's events name as its organizer, shown positively (the second recheck's third
 * finding, one rule for every spelling): `null` only where no event carries an ORGANIZER line in
 * any spelling and none carries an invitee the reader takes no mail address from (an invitation
 * whose line for the account may be that one); the one address where every ORGANIZER line is one
 * the reader takes, one to an event, each naming that same mail address; `""` otherwise.
 */
function organizerShown(events: readonly CalEvent[]): string | null {
  const addresses = new Set<string>();
  let unaddressed = false;
  for (const e of events) {
    const lines = e.component.properties.filter((p) => spelledAs(p, "ORGANIZER"));
    if (lines.length > 1) return "";
    if (lines.length === 1) {
      const email = readAs(lines[0]!, "ORGANIZER") ? (e.organizer?.email ?? null) : null;
      if (email === null) return "";
      addresses.add(email);
    }
    if (
      e.attendees.some((a) => a.email === null) ||
      e.component.properties.some((p) => spelledAs(p, "ATTENDEE") && !readAs(p, "ATTENDEE"))
    ) {
      unaddressed = true;
    }
  }
  if (addresses.size > 1) return "";
  if (addresses.size === 1) return [...addresses][0]!;
  return unaddressed ? "" : null;
}

/**
 * The days of the series whose own component is `own` that it cancels by a component of their own
 * (its UID, a RECURRENCE-ID of that day alone, STATUS:CANCELLED), by the time each was first at: one
 * way a stored object tells an excluded day, beside its EXDATE lines.
 */
export function cancelledDaysOf(events: readonly CalEvent[], own: CalEvent): EventTime[] {
  return events.flatMap((e) =>
    e !== own && e.uid === own.uid && e.recurrenceId !== null && !e.thisAndFuture && e.status === "CANCELLED"
      ? [e.recurrenceId]
      : [],
  );
}

/**
 * Is the day the key names (a moment's key, as the store keys a day) one of the series' own: a day
 * its rule names from its start, and not one it excludes? `null` for a key told otherwise (a clock
 * time whose moment cannot be said): the series' server is the one to say.
 */
export function isDayOf(
  series: StoredSeries,
  excluded: readonly EventTime[],
  key: string,
  zones: ZoneSource,
): boolean | null {
  if (!/^-?\d{1,16}$/.test(key) || !Number.isSafeInteger(Number(key))) return null;
  const at = Number(key);
  const made = newEventComponent({
    uid: "day",
    dtstamp: instant(0),
    start: series.first,
    end: series.firstEnd,
    rule: series.rule,
  });
  const master = eventOf({
    ...made,
    properties: [...made.properties, ...excluded.map((e) => timeProperty("EXDATE", e))],
  });
  const [found] = seriesOf([master], zones);
  if (found === undefined) return false;
  const near = expandSeries(
    found,
    { startMs: at - 2 * DAY_MS, endMs: at + 2 * DAY_MS, viewerZone: "Etc/UTC" },
    zones,
  );
  return near.occurrences.some((o) => recurrenceKeyString(o.key) === key);
}
