/**
 * THE WAITING QUEUE, PARTITIONED BY ITS SUGGESTION: the filter's groups and counts, and the decision a row's accept
 * files to. `hasRealSuggestion` is the one spelling of "there is a suggestion here": the filter, the apply count, the
 * row's accept and Enter all read it, so they cannot disagree.
 */
import type { ScreenerSenderDTO } from "@ohmail/client-engine";
import type { DecisionDestination } from "./decision.js";
import { APPLY_PILE_ORDER, hasRealSuggestion } from "./screener-state.js";

export type ScreenerFilterId = DecisionDestination | "none";
export const FILTER_ORDER: readonly ScreenerFilterId[] = [...APPLY_PILE_ORDER, "none"];
export type FilterCounts = Readonly<Record<ScreenerFilterId, number>>;

/** A hold, a run that could not answer and a sender nobody asked about are one group: they wait on a person. */
export function filterGroupOf(w: ScreenerSenderDTO): ScreenerFilterId {
  return hasRealSuggestion(w) ? (w.ai!.dest as DecisionDestination) : "none";
}

/** Where a one-press accept files this sender; null where there is nothing to accept. */
export function acceptDestOf(w: ScreenerSenderDTO): DecisionDestination | null {
  return hasRealSuggestion(w) ? (w.ai!.dest as DecisionDestination) : null;
}

/** The six counts, over the rows still on the queue (a row sliding away is not counted). */
export function filterCounts(
  waiting: readonly ScreenerSenderDTO[],
  isExiting: (id: string) => boolean,
): FilterCounts {
  const counts: Record<ScreenerFilterId, number> = {
    ohbox: 0,
    reads: 0,
    receipts: 0,
    screened: 0,
    spam: 0,
    none: 0,
  };
  for (const w of waiting) if (!isExiting(w.id)) counts[filterGroupOf(w)] += 1;
  return counts;
}

/** A pressed filter whose group has emptied lets itself go: the whole queue again, never an empty pane. */
export function activeFilterOf(
  filter: ScreenerFilterId | null,
  counts: FilterCounts,
): ScreenerFilterId | null {
  return filter !== null && counts[filter] > 0 ? filter : null;
}

/** The groups worth offering: a group with nothing in it is no choice, and one group alone is no partition. */
export function filterChoices(counts: FilterCounts): readonly ScreenerFilterId[] {
  const full = FILTER_ORDER.filter((id) => counts[id] > 0);
  return full.length > 1 ? full : [];
}
