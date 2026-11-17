/**
 * MICROSOFT'S CANCELLED DAYS. Graph hands a series as its rule and, beside each page, the days of
 * the window it showed, as identities only. A day the rule gives inside the window that no page of
 * a WHOLE reading showed was cancelled at Microsoft, and joins the series' excluded days. A delta
 * reading shows only what changed, so it compares nothing.
 *
 * Careful at the edges: a day is compared only where it lies inside the window shrunk by a day at
 * each end, where its time is exact (a known zone), and where the expansion was not cut short at a
 * ceiling. Anything else excludes nothing: a day kept that was cancelled is a smaller fault than a
 * day hidden that was not.
 */
import {
  expandSeries, isExactMoment, MS_PER_DAY, recurrenceKeyString, seriesOf, type CalEvent, type EventTime, type ZoneSource,
} from "@ohmail/cal-core";

export interface CancelledDays {
  readonly uid: string;
  readonly days: readonly EventTime[];
}

/**
 * The days each series lost, from the masters a whole reading carried and the days its pages
 * showed (`seen`, by key). `window` is the reading's own, epoch milliseconds.
 */
export function cancelledDays(
  masters: ReadonlyMap<string, CalEvent>, seen: ReadonlyMap<string, ReadonlySet<string>>,
  window: { readonly start: number; readonly end: number }, zones: ZoneSource,
): CancelledDays[] {
  const inner = { startMs: window.start + MS_PER_DAY, endMs: window.end - MS_PER_DAY, viewerZone: "Etc/UTC" };
  if (inner.endMs <= inner.startMs) return [];
  const out: CancelledDays[] = [];
  for (const [uid, master] of masters) {
    if (master.rules.length === 0) continue;
    const [series] = seriesOf([master], zones);
    if (series === undefined) continue;
    const expansion = expandSeries(series, inner, zones);
    if (expansion.capped) continue;
    const shown = seen.get(uid) ?? new Set<string>();
    const days: EventTime[] = [];
    for (const o of expansion.occurrences) {
      // A day the rule made, at a moment known exactly, inside the shrunk window; a moved day is the series' own record.
      if (o.source !== "rule" || o.key.kind !== "instant" || !isExactMoment(o.start, zones)) continue;
      if (o.key.epochMs < inner.startMs || o.key.epochMs >= inner.endMs) continue;
      if (shown.has(recurrenceKeyString(o.key))) continue;
      days.push(o.start);
    }
    if (days.length > 0) out.push({ uid, days });
  }
  return out;
}
