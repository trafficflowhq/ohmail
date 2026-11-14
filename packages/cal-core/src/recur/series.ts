/**
 * A repeating event as the occurrences a person sees: the rule's instances, minus the excluded and
 * the cancelled ones, with each changed occurrence in its new place (RFC 5545 sections 3.8.4.4 and
 * 3.8.5).
 *
 * Two provider shapes meet here in one key. A calendar that hands over the series (a rule, and one
 * record per changed occurrence naming the time it replaces) is expanded by `expandSeries`. A
 * calendar that hands over days already expanded, each naming its original start, goes through
 * `occurrencesFromExpanded`. Both give `Occurrence[]` with the same `RecurrenceKey`, so a day read
 * expanded lands on the key its series would give it later. An occurrence never holds its series.
 *
 * An expansion has one allowance, whatever it is handed: every rule line, listed date and changed
 * occurrence of every series draws on the same counts (`limits.maxSteps` for what is looked at,
 * `limits.maxOccurrencesPerCall` for what is worked out with the zone's rules, and of that no more
 * than `limits.maxOccurrences` for one series), and nothing that lies outside the window is worked
 * out at all. The zone source is asked on the same steps: what reading a file's zone definition
 * costs comes out of them (`StepsLeft`). An expansion that met a ceiling names it.
 */
import type { CalEvent } from "../ical/event.js";
import { compareVersions } from "../itip/order.js";
import { DEFAULT_LIMITS, type Limits } from "../limits.js";
import { MS_PER_DAY, MS_PER_SECOND } from "../time/arith.js";
import type { EventTime, ZoneSource } from "../time/types.js";
import { onSteps } from "../time/zones.js";
import type { WalkStop } from "./expand.js";
import { recurrenceKeyOf, recurrenceKeyString, type RecurrenceKey } from "./key.js";
import { expandInto, inOrder, type Allowance, type Found } from "./pass.js";
import { clockSeconds, momentOf } from "./span.js";

/* ── a series ───────────────────────────────────────────────────────────────────────────────────── */

export interface Series {
  readonly uid: string;
  /** The component without a recurrence id; `null` when only changed occurrences are known. */
  readonly master: CalEvent | null;
  /** Changed occurrences by the key string of the occurrence each replaces. */
  readonly overrides: ReadonlyMap<string, CalEvent>;
  /** Key strings of occurrences a provider reports as cancelled without a component of their own. */
  readonly cancelled: ReadonlySet<string>;
}

/**
 * Events grouped into series by UID, in the order each UID first appears. An event with no UID is a
 * series of its own. Of two components for the same occurrence the newer stays (`compareVersions`:
 * the higher SEQUENCE, then the later DTSTAMP), and of two that cannot be told apart the later in
 * the list. The zone source resolves the keys, so it must be the one the series is expanded with.
 *
 * A changed day in a zone only its file defines is keyed by reading that definition, and the
 * definitions are a stranger's: they are read on one allowance of steps (`limits.maxSteps`), as an
 * expansion's are. A changed day whose definition the steps no longer cover is keyed by its clock
 * time, as one in a zone nobody knows is, and its definition is left unread.
 */
export function seriesOf(events: readonly CalEvent[], zones: ZoneSource, limits: Limits = DEFAULT_LIMITS): Series[] {
  const asked = onSteps(zones, { steps: limits.maxSteps });
  const byUid = new Map<string, { uid: string; master: CalEvent | null; overrides: Map<string, CalEvent> }>();
  const out: { uid: string; master: CalEvent | null; overrides: Map<string, CalEvent> }[] = [];
  for (const event of events) {
    let series = event.uid === null ? undefined : byUid.get(event.uid);
    if (series === undefined) {
      series = { uid: event.uid ?? "", master: null, overrides: new Map() };
      if (event.uid !== null) byUid.set(event.uid, series);
      out.push(series);
    }
    const newer = (held: CalEvent | null | undefined): boolean => held === null || held === undefined || compareVersions(event, held) >= 0;
    if (event.recurrenceId === null) {
      if (newer(series.master)) series.master = event;
    } else {
      const key = recurrenceKeyString(recurrenceKeyOf(event.recurrenceId, asked));
      if (newer(series.overrides.get(key))) series.overrides.set(key, event);
    }
  }
  return out.map((s) => ({ ...s, cancelled: new Set<string>() }));
}

/* ── occurrences ────────────────────────────────────────────────────────────────────────────────── */

export interface Occurrence {
  readonly uid: string;
  /** The occurrence's identity in its series: where it was first, whatever it was moved to. */
  readonly key: RecurrenceKey;
  readonly start: EventTime;
  /** Exclusive, in the kind the event's own end has. Equal to `start` for an event with no length. */
  readonly end: EventTime;
  /** `single`: an event that does not repeat. `rule`: made by the rule or an added date. `override`: described by a changed occurrence. `expanded`: handed over already expanded. */
  readonly source: "single" | "rule" | "override" | "expanded";
  /** The component that describes this occurrence: the series, or the changed occurrence. */
  readonly event: CalEvent;
}

export interface ExpansionWindow {
  /** From this instant (inclusive) to that one (exclusive). */
  readonly startMs: number;
  readonly endMs: number;
  /** The zone whole days and zoneless times are read in: the viewer's. */
  readonly viewerZone: string;
}

/**
 * The ceiling an expansion stopped at: the steps of the call were spent (`out_of_steps`), the times
 * a series or the call may work out were (`too_many_occurrences`), an event has more rule lines than
 * are walked (`too_many_rules`), or a rule line was more than a line may be (`WalkStop`).
 */
export type ExpansionStop = WalkStop | "too_many_occurrences" | "too_many_rules";

export interface Expansion {
  /** In order of start. */
  readonly occurrences: readonly Occurrence[];
  /** The expansion stopped at a ceiling (`limits`): there may be more than it returned. */
  readonly capped: boolean;
  /** The ceilings it stopped at, each once and in the order it met them; empty when it met none. */
  readonly stoppedBy: readonly ExpansionStop[];
  /**
   * The steps it took, of `limits.maxSteps`: days asked of a rule, readings handed back, places
   * BYSETPOS names looked for, series, listed dates and changed occurrences looked at, and what
   * reading a file's zone definitions cost.
   */
  readonly spent: number;
  /** The times it worked out with the zone's rules, of `limits.maxOccurrencesPerCall`: more than the occurrences it returned, by those just outside the window. */
  readonly resolved: number;
}

/* ── the doors ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * The occurrences of a series that touch a window. An occurrence is in when it starts inside the
 * window or began before it and has not ended. A changed occurrence is placed by its own new time
 * and takes its original out of the rule's instances wherever that was: moved from one day to the
 * next, it is on the next day only. Times whose zone nobody knows cannot be compared exactly and are
 * kept when they could fall inside under any zone there is.
 */
export function expandSeries(series: Series, window: ExpansionWindow, zones: ZoneSource, limits: Limits = DEFAULT_LIMITS): Expansion {
  return expandAll([series], window, zones, limits);
}

/**
 * Every series handed in, over one window and on one allowance: what a calendar's view asks. The
 * occurrences come back in one order of start. When the allowance is spent the series not yet
 * looked at give nothing, and the expansion says it stopped and at which ceiling.
 */
export function expandAll(all: readonly Series[], window: ExpansionWindow, zones: ZoneSource, limits: Limits = DEFAULT_LIMITS): Expansion {
  const left: Allowance = { steps: limits.maxSteps, resolved: limits.maxOccurrencesPerCall };
  const asked = onSteps(zones, left);
  const found: Found[] = [];
  const stops = new Set<ExpansionStop>();
  for (const series of all) {
    if (left.steps <= 0) {
      stops.add("out_of_steps");
      break;
    }
    if (left.resolved <= 0) {
      stops.add("too_many_occurrences");
      break;
    }
    expandInto(series, window, asked, limits, left, found, null, stops);
  }
  return { occurrences: inOrder(found), capped: stops.size > 0, stoppedBy: [...stops], spent: limits.maxSteps - left.steps, resolved: limits.maxOccurrencesPerCall - left.resolved };
}

/**
 * The one occurrence of a series that was first at `was`, where it stands now (moved, if a changed
 * occurrence moved it), or `null` when the series has none there: no instance of the rule, an
 * excluded date, a cancelled day.
 */
export function occurrenceOf(series: Series, was: EventTime, zones: ZoneSource, limits: Limits = DEFAULT_LIMITS): Occurrence | null {
  const left: Allowance = { steps: limits.maxSteps, resolved: limits.maxOccurrences };
  const asked = onSteps(zones, left);
  const at = momentOf(was, asked) ?? clockSeconds(was) * MS_PER_SECOND;
  const around: ExpansionWindow = { startMs: at - MS_PER_DAY, endMs: at + MS_PER_DAY, viewerZone: "Etc/UTC" };
  const found: Found[] = [];
  expandInto(series, around, asked, limits, left, found, recurrenceKeyString(recurrenceKeyOf(was, asked)), new Set());
  // An answer about a zone that the steps did not cover is no answer: nothing is said about the occurrence.
  return left.unpaid ? null : (found[0]?.occurrence ?? null);
}

/** One day as a provider hands it over already expanded: its own times, and the start it has in its series. */
export interface ExpandedItem {
  readonly uid: string;
  /** The occurrence's start before any change: what a series' rule would have made. */
  readonly originalStart: EventTime;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly event: CalEvent;
}

/**
 * Occurrences from days a provider expanded itself. No series is needed and none is made; the key is
 * the one `expandSeries` would give the same occurrence once the series is known.
 */
export function occurrencesFromExpanded(items: readonly ExpandedItem[], zones: ZoneSource): Occurrence[] {
  return items.map((item) => ({ uid: item.uid, key: recurrenceKeyOf(item.originalStart, zones), start: item.start, end: item.end, source: "expanded", event: item.event }));
}
