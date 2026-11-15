/**
 * WHICH CALENDAR EVENTS A DEVICE KEEPS: those that can touch a span of days around today.
 *
 * A calendar's first read is every event it ever held, so the device cannot keep them all. It
 * keeps an event when the event's own range meets the span, or the occurrence it replaces lies in
 * the span, or it changes this occurrence and every later one and starts before the span's end.
 * The span is what the server serves (`CalendarWindow`: days back and ahead of today and a row
 * ceiling) joined with what this device loaded on purpose; past the ceiling the events farthest
 * from today go first. `CALENDAR_SPAN_CASES` is the one table of cases the server's first load
 * answers by as well, and every range is widened by the slack a clock read as UTC can be off.
 */
import type { CalendarWindow } from "@ohmail/wire";

/** How far a time read as UTC can be from the moment it meant (the services' `CALENDAR_RANGE_SLACK_MS`). */
export const CALENDAR_SPAN_SLACK_MS = 14 * 3_600_000;

const DAY_MS = 86_400_000;

/** What a device keeps until the server states its own window. */
export const CALENDAR_WINDOW_DEFAULT: CalendarWindow = { daysBack: 366, daysAhead: 731, maxRows: 10_000 };

export interface CalendarSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

/** What the predicate reads of an event's record. */
export interface SpanFacts {
  readonly startsAt: number;
  readonly endsAt: number | null;
  readonly occurrenceAt: number | null;
  readonly thisAndFuture: boolean;
}

/** The span a window states around `nowMs`. */
export function spanAround(nowMs: number, w: CalendarWindow): CalendarSpan {
  return { fromMs: nowMs - w.daysBack * DAY_MS, toMs: nowMs + w.daysAhead * DAY_MS };
}

/**
 * THE CASES, each a reason to keep an event in one span. Exported so the server's SQL and this
 * predicate are tested against the same rows.
 */
export const CALENDAR_SPAN_CASES = {
  /** Its own range meets the span: it starts before the span ends and ends (or never ends) after it begins. */
  rangeMeets: (e: SpanFacts, s: CalendarSpan): boolean =>
    e.startsAt <= s.toMs + CALENDAR_SPAN_SLACK_MS && (e.endsAt === null || e.endsAt >= s.fromMs - CALENDAR_SPAN_SLACK_MS),
  /** The occurrence it replaces lies in the span, so the original must stay hidden there. */
  replacesInside: (e: SpanFacts, s: CalendarSpan): boolean =>
    e.occurrenceAt !== null
      && e.occurrenceAt >= s.fromMs - CALENDAR_SPAN_SLACK_MS && e.occurrenceAt <= s.toMs + CALENDAR_SPAN_SLACK_MS,
  /** It changes this occurrence and every later one, from before the span's end. */
  thisAndFutureBefore: (e: SpanFacts, s: CalendarSpan): boolean =>
    e.thisAndFuture && e.occurrenceAt !== null && e.occurrenceAt <= s.toMs + CALENDAR_SPAN_SLACK_MS,
} as const;

export function heldBySpan(e: SpanFacts, spans: readonly CalendarSpan[]): boolean {
  return spans.some((s) => Object.values(CALENDAR_SPAN_CASES).some((held) => held(e, s)));
}

/** How far from now an event lies: zero while it is on, else the nearer end's distance. */
function distanceFrom(nowMs: number, e: SpanFacts): number {
  if (e.startsAt > nowMs) return e.startsAt - nowMs;
  if (e.endsAt === null || e.endsAt >= nowMs) return 0;
  return nowMs - e.endsAt;
}

/** An event record's facts, or `null` for a record that carries none (never evicted on a guess). */
export function spanFactsOf(entity: unknown): SpanFacts | null {
  const e = entity as { startsAt?: unknown; endsAt?: unknown; occurrenceAt?: unknown; thisAndFuture?: unknown } | null;
  const at = (v: unknown): number | null => (typeof v === "string" ? Date.parse(v) : null);
  const startsAt = at(e?.startsAt);
  if (startsAt === null || Number.isNaN(startsAt)) return null;
  const endsAt = at(e?.endsAt);
  const occurrenceAt = at(e?.occurrenceAt);
  return {
    startsAt,
    endsAt: endsAt === null || Number.isNaN(endsAt) ? null : endsAt,
    occurrenceAt: occurrenceAt === null || Number.isNaN(occurrenceAt) ? null : occurrenceAt,
    thisAndFuture: e?.thisAndFuture === true,
  };
}

/**
 * The events to let go: those no span holds, then, past the ceiling, the farthest from now. A row
 * newer than `graceAbove` stays this pass (the prune's one-page grace).
 */
export function calendarSpanVictims(
  events: ReadonlyArray<{ id: string; seq: number; entity: unknown }>,
  nowMs: number, window: CalendarWindow, loaded: readonly CalendarSpan[], graceAbove?: number,
): Array<{ type: "calendar_event"; id: string }> {
  const spans = [spanAround(nowMs, window), ...loaded];
  const kept: Array<{ id: string; distance: number }> = [];
  const out: Array<{ type: "calendar_event"; id: string }> = [];
  for (const row of events) {
    const facts = spanFactsOf(row.entity);
    if (facts === null) continue;
    if (graceAbove !== undefined && row.seq > graceAbove) continue;
    if (heldBySpan(facts, spans)) kept.push({ id: row.id, distance: distanceFrom(nowMs, facts) });
    else out.push({ type: "calendar_event", id: row.id });
  }
  if (kept.length > window.maxRows) {
    kept.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
    for (const k of kept.slice(window.maxRows)) out.push({ type: "calendar_event", id: k.id });
  }
  return out;
}
