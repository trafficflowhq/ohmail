/**
 * Where a zone's rules come from. Three sources: the platform's own zone database (`intlZones`),
 * the definitions a calendar file carries (`fileZones`), or one after the other (`firstOf`). No
 * table of zone rules is carried here, and a source is always handed in: no function in this
 * package reaches for the platform by itself. The order a calendar is read with (the platform for
 * a name it knows, the file for the rest) is `zonesOf` in `ical/calendar`; what a file defines and
 * what the platform knows can differ, and a caller that means the other order says so with `firstOf`.
 *
 * A file's definition is a stranger's text, and reading it is work the text sets the size of. That
 * work is counted in the steps of the rule walk (a step for every onset laid out; for every rule
 * followed one for the rule, one for each member of its lists and the steps of its walk) and ends
 * by its count. An asker that hands in the steps it has left
 * (`StepsLeft`) pays for it out of them, so one expansion has one allowance for its rules and for
 * its zones; an asker that hands in none is held by this module's own ceilings alone.
 *
 * This is the only module that touches `Intl`.
 */
import { walkRule } from "../recur/expand.js";
import type { RRule } from "../recur/rrule.js";
import { MAX_ZONE_NAME_CHARS, MAX_ZONE_ONSETS, PLATFORM_ZONES_HELD, UNKNOWN_ZONE_NAMES_HELD, ZONE_ONSETS_HELD } from "../limits.js";
import { civilFromDays, MS_PER_SECOND, wallFromSeconds, wallSeconds } from "./arith.js";
import { heldUpTo } from "./held.js";
import type { StepsLeft, Wall, ZoneSource } from "./types.js";
import { WINDOWS_ZONES } from "./windows-zones.js";

/* ── names ──────────────────────────────────────────────────────────────────────────────────────── */

/** libical's and old Lightning's and Evolution's prefix before an IANA name (`/mozilla.org/20050126_1/Europe/Berlin`). */
const VENDOR_PREFIX = /^\/(?:freeassociation\.sourceforge\.net\/(?:Tzfile\/)?|mozilla\.org\/[^/]+\/|softwarestudio\.org\/Olson_[^/]+\/)/;
/** No name the platform has is this long (the longest IANA name has 32 characters); a longer one is never asked of it. */
const PLATFORM_NAME_MAX = 64;
/** The Windows names by themselves: a name is looked up among the table's own rows, and a word every object has (`constructor`) is none of them. */
const WINDOWS_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(WINDOWS_ZONES));
const OUTSIDE_ASCII = /[^\u0000-\u007f]/;

/** Every name a calendar gives a zone begins with a letter. */
const BEGINS_AS_A_NAME = /^[A-Za-z]/;

/**
 * The name the platform is asked for: a vendor's prefix taken off, a Windows name turned into its
 * IANA one. `null` for a name longer than a zone's name may be (`MAX_ZONE_NAME_CHARS`), which is not
 * looked at further; for one that is longer without its prefix than any name the platform has; and
 * for one that does not begin with a letter. The platform takes a bare offset for a zone (`+01:00`,
 * 2,880 of them to the minute), and a source keeps a formatter for every zone it is asked about:
 * the names it can be made to keep are the platform's own list and nothing a text can count up.
 */
export function platformZoneName(tzid: string): string | null {
  if (tzid.length > MAX_ZONE_NAME_CHARS) return null;
  const bare = tzid.replace(VENDOR_PREFIX, "");
  if (bare.length > PLATFORM_NAME_MAX || !BEGINS_AS_A_NAME.test(bare)) return null;
  return WINDOWS_NAMES.get(bare) ?? bare;
}

/* ── the platform ───────────────────────────────────────────────────────────────────────────────── */

/**
 * The platform's zone database, read through `Intl`. The same read the invitation card uses on
 * every surface; what it knows is as old as the device's zone data. A name the platform does not
 * have answers `null`.
 *
 * What a source remembers has a ceiling, and one spelling for each thing remembered:
 *
 *   - a formatter for a zone, under the zone's name in lower case. The platform takes a name in any
 *     letter case (it compares the ASCII letters without regard to case), so every spelling of one
 *     name is one formatter. No more than `PLATFORM_ZONES_HELD`, which is more than the platform
 *     has names: a formatter is made once and kept, because one that is let go is not given back at
 *     once (`limits`). Past the ceiling the one used longest ago goes first.
 *   - a name the platform does not know, as it was asked. A zone only its file defines is asked for
 *     here first, at every question, and the platform's "no" is a thrown error each time it is not
 *     remembered. No more than `UNKNOWN_ZONE_NAMES_HELD`, in the same order, and in a memory of
 *     their own: any number of names that are none takes no zone that is known out of the other.
 *   - the name asked last, with its answer: the questions about one time all name one zone.
 *
 * A name the platform does not know that fell out of its memory is asked of the platform again:
 * one refusal, which is the most a question can cost here beside its answer.
 */
export function intlZones(): ZoneSource {
  const formatters = heldUpTo<Intl.DateTimeFormat>(PLATFORM_ZONES_HELD);
  const unknown = heldUpTo<true>(UNKNOWN_ZONE_NAMES_HELD);
  const formatterOf = (zone: string): Intl.DateTimeFormat | null => {
    // Lower case is the one spelling. A name with a character outside ASCII is no name of the platform's, and is not folded onto one.
    const spelling = OUTSIDE_ASCII.test(zone) ? zone : zone.toLowerCase();
    const held = formatters.get(spelling);
    if (held !== undefined) return held;
    if (unknown.get(zone) !== undefined) return null;
    try {
      const made = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      formatters.set(spelling, made);
      return made;
    } catch {
      // The platform does not know this zone.
      unknown.set(zone, true);
      return null;
    }
  };
  let last: { readonly tzid: string; readonly formatter: Intl.DateTimeFormat | null } | null = null;
  return {
    offsetAt(tzid, epochMs) {
      if (last === null || last.tzid !== tzid) {
        const zone = platformZoneName(tzid);
        // A name past the ceiling is answered and not kept: nothing here holds a string longer than a zone's name may be.
        if (zone === null) return null;
        last = { tzid, formatter: formatterOf(zone) };
      }
      const formatter = last.formatter;
      if (formatter === null || !Number.isFinite(epochMs)) return null;
      const whole = Math.floor(epochMs / MS_PER_SECOND) * MS_PER_SECOND;
      const f: Record<string, number> = {};
      try {
        for (const part of formatter.formatToParts(whole)) if (part.type !== "literal") f[part.type] = Number(part.value);
      } catch {
        return null;
      }
      const shown: Wall = { year: f.year!, month: f.month!, day: f.day!, hour: f.hour!, minute: f.minute!, second: f.second! };
      if (!Object.values(shown).every(Number.isFinite)) return null;
      return wallSeconds(shown) * MS_PER_SECOND - whole;
    },
  };
}

/* ── a file's own definitions ───────────────────────────────────────────────────────────────────── */

/** One STANDARD or DAYLIGHT block of a zone definition (RFC 5545 section 3.6.5). Offsets are seconds east of UTC. */
export interface Observance {
  /** The first onset, on the clock that was in force before it. */
  readonly start: Wall;
  readonly offsetFrom: number;
  readonly offsetTo: number;
  /** Later onsets, by rule and by list. */
  readonly rule: RRule | null;
  readonly extra: readonly Wall[];
  readonly daylight: boolean;
  readonly name: string | null;
}

export interface ZoneDefinition {
  /** The name exactly as the file writes it; times name it letter for letter. */
  readonly tzid: string;
  readonly observances: readonly Observance[];
}

const SECONDS_PER_DAY = 86_400;
/** A rule with no end is looked at over the year before and the year after the moment asked: every onset that can matter lies there. */
const YEARS_AROUND = 1;
/** Steps one such look may cost, over all the rules of a zone: two rules set up and asked day by day over three years, and the onsets they hand back. */
const STEPS_PER_LOOK = 4_500;
/** Steps the rules of one zone that end may cost, all together, when the zone is first asked for: their setting up, and two centuries of a yearly rule asked day by day. */
const STEPS_PER_TABLE = 75_000;
/** Years of looks kept for one zone: a calendar's view stays within a few. */
const YEARS_HELD = 8;

/** One change of a zone's offset: when (UTC seconds), to what (seconds east), and which block of the definition said so. */
interface Onset {
  readonly at: number;
  readonly offset: number;
  readonly block: number;
}
const byTime = (a: Onset, b: Onset): number => a.at - b.at || a.block - b.block;

/** The latest onset at or before `t` in a list in order of time; of two at the same second the later block's. */
function latestIn(onsets: readonly Onset[], t: number): Onset | null {
  let [lo, hi] = [0, onsets.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid]!.at <= t) lo = mid + 1;
    else hi = mid;
  }
  return onsets[lo - 1] ?? null;
}

/** A zone's definition as it is asked: read once from its blocks, then never again. */
interface ZoneTable {
  /** Every block's own start, the dates the blocks list and the onsets of their rules that end, in order of time. */
  readonly fixed: readonly Onset[];
  /** The offset before the first onset of all. */
  readonly before: number;
  /** The rules with no end, looked at a few years at a time. */
  readonly open: readonly { readonly start: Wall; readonly offsetFrom: number; readonly offsetTo: number; readonly rule: RRule; readonly block: number }[];
  readonly years: Map<number, readonly Onset[]>;
  /** The onsets the looks in `years` hold, together. */
  looked: number;
  /** A look cost more than a zone's rules may: the definition is no definition from then on. */
  spent: boolean;
}

/** An observance's UNTIL "MUST be specified in UTC time"; one written otherwise is read on the observance's own clock. */
const ruleEnded = (end: NonNullable<RRule["until"]>, utc: number, w: Wall): boolean =>
  end.kind === "instant" ? utc * MS_PER_SECOND > end.epochMs : wallSeconds(w) > wallSeconds(end.kind === "date" ? { ...end, hour: 23, minute: 59, second: 59 } : end.wall);

/** The asker's steps did not cover the work: nothing was made that could be kept. */
const UNPAID = "unpaid";

/**
 * What one piece of this module's work costs: counted as it is done, and settled once with whoever
 * asked. A rule's walk has two ceilings, this module's own for the piece and what the asker has
 * left; the bill says which of them was met.
 */
interface Bill {
  /** Count onsets about to be laid out, a step each (their own ceiling is `MAX_ZONE_ONSETS`). `false` when the asker cannot pay for them. */
  afford(steps: number): boolean;
  /** Count the setting up of a rule's walk: a step for the rule and one for each member of its lists, which a walk looks at before its first day. */
  setUp(rule: RRule): "own" | "asker" | null;
  /** The steps a rule walk may take: no more than the module's own ceiling leaves, and no more than the asker has. */
  walkable(): number;
  /** Count a walk's steps: `"own"` when it stopped at this module's ceiling or one of the walk's own, `"asker"` when the asker's steps ran out first, `null` when it did not stop short. */
  walked(walk: { readonly steps: number; readonly stoppedBy: string | null }): "own" | "asker" | null;
  /** The work is done, or this module's own ceilings refused it: the asker pays for what was done. */
  settle<T>(result: T): T;
  /** The asker's steps did not cover it: all of them are taken, and the count says so. */
  short(): typeof UNPAID;
}

const membersOf = (r: RRule): number =>
  r.bySecond.length + r.byMinute.length + r.byHour.length + r.byDay.length + r.byMonthDay.length + r.byYearDay.length + r.byWeekNo.length + r.byMonth.length + r.bySetPos.length;

function billFor(left: StepsLeft | undefined, ownCeiling: number): Bill {
  let [spent, own] = [0, ownCeiling];
  const askerHas = (): number => (left === undefined ? Infinity : left.steps - spent);
  return {
    afford(steps) {
      spent += steps;
      return askerHas() >= 0;
    },
    setUp(rule) {
      const steps = 1 + membersOf(rule);
      own -= steps;
      spent += steps;
      return own < 0 ? "own" : askerHas() < 0 ? "asker" : null;
    },
    walkable: () => Math.min(own, askerHas()),
    walked(walk) {
      // Of two ceilings met at once the asker's is named: the next asker may have more, and the definition is not written off.
      const asker = walk.stoppedBy === "out_of_steps" && askerHas() <= own;
      own -= walk.steps;
      spent += walk.steps;
      return walk.stoppedBy === null ? null : asker ? "asker" : "own";
    },
    settle(result) {
      if (left !== undefined) left.steps -= spent;
      return result;
    },
    short() {
      if (left !== undefined) [left.steps, left.unpaid] = [Math.min(left.steps, 0), true];
      return UNPAID;
    },
  };
}

/**
 * A definition as a table; `null` for one that holds nothing, more than a definition may, or rules
 * that cost more to follow than a zone's may; `"unpaid"` when the asker's steps did not cover
 * reading it. Every onset laid out is a step; a rule that ends costs its setting up and the steps
 * of its walk.
 */
function tableOf(zone: ZoneDefinition, left: StepsLeft | undefined): ZoneTable | null | typeof UNPAID {
  if (zone.observances.length === 0 || zone.observances.length > MAX_ZONE_ONSETS) return null;
  const fixed: Onset[] = [];
  const open: { start: Wall; offsetFrom: number; offsetTo: number; rule: RRule; block: number }[] = [];
  let [first, before] = [Infinity, 0];
  const bill = billFor(left, STEPS_PER_TABLE);
  for (let block = 0; block < zone.observances.length; block++) {
    const { start, extra, offsetFrom, offsetTo, rule } = zone.observances[block]!;
    if (fixed.length + 1 + extra.length > MAX_ZONE_ONSETS) return bill.settle(null);
    if (!bill.afford(1 + extra.length)) return bill.short();
    for (const w of [start, ...extra]) {
      const at = wallSeconds(w) - offsetFrom;
      if (at < first) [first, before] = [at, offsetFrom];
      fixed.push({ at, offset: offsetTo, block });
    }
    if (rule === null) continue;
    if (rule.count === null && rule.until === null) {
      open.push({ start, offsetFrom, offsetTo, rule, block });
      continue;
    }
    // A rule that ends: all its onsets, once. One that ends by a moment is walked no further than a day or two past it.
    const until = rule.until;
    const last = until === null ? null : (until.kind === "instant" ? Math.floor(until.epochMs / MS_PER_SECOND) : wallSeconds(until.kind === "date" ? { ...until, hour: 0, minute: 0, second: 0 } : until.wall)) + 2 * SECONDS_PER_DAY;
    const dear = bill.setUp(rule);
    if (dear !== null) return dear === "asker" ? bill.short() : bill.settle(null);
    const walk = walkRule(rule, start, { dateOnly: false, maxSteps: bill.walkable(), maxPerPeriod: MAX_ZONE_ONSETS, ...(last === null ? {} : { to: wallFromSeconds(last) }) });
    // The walk hands the block's own start back first, and that one is held already.
    walk.next();
    let full = false;
    for (let w = walk.next(); w !== null; w = walk.next()) {
      const at = wallSeconds(w) - offsetFrom;
      if (until !== null && ruleEnded(until, at, w)) break;
      full = fixed.length >= MAX_ZONE_ONSETS;
      if (full) break;
      fixed.push({ at, offset: offsetTo, block });
    }
    const stopped = bill.walked(walk);
    if (stopped === "asker") return bill.short();
    if (stopped === "own" || full) return bill.settle(null);
  }
  fixed.sort(byTime);
  return bill.settle({ fixed, before, open, years: new Map(), looked: 0, spent: false });
}

/**
 * The onsets a zone's rules with no end make around `year`, in order of time; `null` when looking
 * costs more than it may; `"unpaid"` when the asker's steps did not cover it. A look that is held
 * costs nothing; one that is made costs, for each rule, its setting up and the steps of its walk.
 */
function onsetsAround(table: ZoneTable, year: number, left: StepsLeft | undefined): readonly Onset[] | null | typeof UNPAID {
  const held = table.years.get(year);
  if (held !== undefined) return held;
  const onsets: Onset[] = [];
  const bill = billFor(left, STEPS_PER_LOOK);
  for (const r of table.open) {
    const dear = bill.setUp(r.rule);
    if (dear !== null) return dear === "asker" ? bill.short() : bill.settle(null);
    const walk = walkRule(r.rule, r.start, {
      dateOnly: false,
      from: { year: year - YEARS_AROUND, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
      to: { year: year + YEARS_AROUND, month: 12, day: 31, hour: 23, minute: 59, second: 59 },
      maxSteps: bill.walkable(),
      maxPerPeriod: MAX_ZONE_ONSETS,
    });
    for (let w = walk.next(); w !== null; w = walk.next()) onsets.push({ at: wallSeconds(w) - r.offsetFrom, offset: r.offsetTo, block: r.block });
    const stopped = bill.walked(walk);
    if (stopped === "asker") return bill.short();
    if (stopped === "own") return bill.settle(null);
  }
  bill.settle(null);
  onsets.sort(byTime);
  if (table.years.size >= YEARS_HELD) {
    table.years.clear();
    table.looked = 0;
  }
  table.years.set(year, onsets);
  table.looked += onsets.length;
  return onsets;
}

/**
 * The zones a file defines, by their own names. A moment takes the offset of the latest onset at or
 * before it; a moment before every onset takes the offset the first onset comes from. A name the
 * file does not define answers `null`, and so does one whose definition holds more than a
 * definition may (`MAX_ZONE_ONSETS`) or costs more to follow than a zone's rules may.
 *
 * A definition is read once, the first time its zone is asked for, into onsets in order of time;
 * after that a question is a search by halving, whatever the number of blocks. Reading it, and
 * following its rules around a year not yet looked at, is paid from the asker's steps when the
 * asker hands them in (`StepsLeft`); what is not paid for is not remembered.
 *
 * What a source remembers has a ceiling. The definitions are found by their names as written (a
 * time names its zone letter for letter), one entry for each definition handed in and none for a
 * name longer than a zone's name may be. What was read of them, the onsets of every definition and
 * of every year looked at, is held up to `ZONE_ONSETS_HELD` together: past that the zone asked
 * longest ago is forgotten, and is read again, on its asker's steps, when it is next asked for.
 */
export function fileZones(definitions: readonly ZoneDefinition[]): ZoneSource {
  const byName = new Map<string, ZoneDefinition>();
  for (const d of definitions) if (d.tzid.length <= MAX_ZONE_NAME_CHARS && !byName.has(d.tzid)) byName.set(d.tzid, d);
  // In the order they were last asked for: the first is the one asked longest ago. A definition that is none is remembered as that, and weighs one.
  const tables = new Map<string, ZoneTable | null>();
  const weightOf = (table: ZoneTable | null): number => (table === null ? 1 : table.fixed.length + table.looked);
  let held = 0;
  let newest: string | null = null;

  /** The zone's offset at second `t`, from what is read of it; a look at a year not yet looked at is made here. */
  const answer = (table: ZoneTable, t: number, left: StepsLeft | undefined): number | null => {
    let latest = latestIn(table.fixed, t);
    if (table.open.length > 0) {
      const around = onsetsAround(table, civilFromDays(Math.floor(t / SECONDS_PER_DAY)).year, left);
      if (around === UNPAID) return null;
      if (around === null) {
        table.spent = true;
        return null;
      }
      const ruled = latestIn(around, t);
      if (ruled !== null && (latest === null || byTime(ruled, latest) >= 0)) latest = ruled;
    }
    return (latest === null ? table.before : latest.offset) * MS_PER_SECOND;
  };

  return {
    offsetAt(tzid, epochMs, left) {
      if (tzid.length > MAX_ZONE_NAME_CHARS) return null;
      const zone = byName.get(tzid);
      if (zone === undefined || !Number.isFinite(epochMs)) return null;
      let table = tables.get(tzid);
      if (table === undefined) {
        const read = tableOf(zone, left);
        if (read === UNPAID) return null;
        table = read;
      } else held -= weightOf(table);
      const offset = table === null || table.spent ? null : answer(table, Math.floor(epochMs / MS_PER_SECOND), left);
      // Asked now: the last to go. It is weighed again, a look may have been added to it.
      if (newest !== tzid) {
        tables.delete(tzid);
        tables.set(tzid, table);
        newest = tzid;
      }
      held += weightOf(table);
      if (held > ZONE_ONSETS_HELD) {
        for (const [name, other] of tables) {
          if (name === tzid) continue;
          tables.delete(name);
          held -= weightOf(other);
          if (held <= ZONE_ONSETS_HELD) break;
        }
      }
      return offset;
    },
  };
}

/**
 * A source as one call asks it: on the call's own steps, so that what an answer costs to work out is
 * the call's to pay, whoever in the call asks. Every door of this package that asks about a zone
 * once for each of a stranger's lines asks through this.
 */
export const onSteps = (zones: ZoneSource, left: StepsLeft): ZoneSource => ({ offsetAt: (tzid, epochMs) => zones.offsetAt(tzid, epochMs, left) });

/** The sources asked in the order given; the first that knows the zone answers. The asker's steps go to whichever of them has to work. */
export function firstOf(...sources: readonly ZoneSource[]): ZoneSource {
  return {
    offsetAt(tzid, epochMs, left) {
      for (const source of sources) {
        const offset = source.offsetAt(tzid, epochMs, left);
        if (offset !== null) return offset;
      }
      return null;
    },
  };
}
