/**
 * THE SENT-MAIL REVIEW ON THE PHONE — the decisions, no rendering. The web's `SeedReviewView`
 * case for case: everyone undecided starts ticked; people already decided are shown, locked and
 * never posted; the filter's bulk pair touches only who is shown; a refused confirm keeps the
 * ticks, and every press carries a new key. The route (`app/seed-review.tsx`) draws it.
 */
import { Copy } from "../copy";
import { confirmSeed, SeedRefused, type SeedCandidate, type SeedExclusion, type SeedReview, type SeedSession } from "../net/consent";

export type ReviewPhase =
  | { state: "loading" }
  /** The list is up. `error` is set when a confirm came back refused — the ticks are kept. */
  | { state: "ready"; review: SeedReview; error?: string }
  | { state: "confirming"; review: SeedReview }
  /** The list itself could not be read: there is no curation to keep. */
  | { state: "unavailable" };

/** Everyone not yet decided about, ticked: writing to them already said yes. */
export function initialTicks(review: SeedReview): Set<string> {
  return new Set(review.candidates.filter((c) => !c.alreadyDecided).map((c) => c.address));
}

/** Nobody written to and everybody already decided are one answer: no decision over zero people. */
export function nothingToDecide(review: SeedReview): boolean {
  return review.candidates.every((c) => c.alreadyDecided);
}

/** The rows the filter shows, matched on the address or the name. */
export function shownOf(review: SeedReview, filter: string): SeedCandidate[] {
  const q = filter.trim().toLowerCase();
  if (q === "") return review.candidates;
  return review.candidates.filter((c) => c.address.includes(q) || (c.name ?? "").toLowerCase().includes(q));
}

/** What a bulk press may touch: the shown rows, minus anyone already decided. */
export function actionableOf(shown: readonly SeedCandidate[]): SeedCandidate[] {
  return shown.filter((c) => !c.alreadyDecided);
}

/** Whether the bulk pair is offered at all — asked of the whole list, so it does not flicker. */
export function bulkOffered(review: SeedReview): boolean {
  return review.candidates.filter((c) => !c.alreadyDecided).length > 1;
}

export function toggled(ticks: ReadonlySet<string>, address: string): Set<string> {
  const next = new Set(ticks);
  if (next.has(address)) next.delete(address);
  else next.add(address);
  return next;
}

/** Tick or untick every actionable shown row — and only those. */
export function setShown(ticks: ReadonlySet<string>, actionable: readonly SeedCandidate[], on: boolean): Set<string> {
  const next = new Set(ticks);
  for (const c of actionable) {
    if (on) next.add(c.address);
    else next.delete(c.address);
  }
  return next;
}

export function excludedSaid(reason: SeedExclusion): string {
  if (reason === "robot-recipient") return Copy.seedExcludedRobot;
  if (reason === "machine-sent") return Copy.seedExcludedMachineSent;
  return Copy.seedExcludedOwn;
}

/** The refusal line above the list; the door's own sentence where it wrote one. */
export function confirmFailureSaid(message: string | undefined): string {
  return `${Copy.seedErrorTitle} ${message ?? Copy.seedErrorGeneric} ${Copy.seedErrorRetry}`;
}

/**
 * THE PRESS — the ticked addresses, never one already decided, under the press's own key (a new
 * one per press). Resolves to `null` when it landed, the kept list with the refusal otherwise.
 */
export async function pressConfirm(
  session: SeedSession, review: SeedReview, ticks: ReadonlySet<string>, key: string,
): Promise<ReviewPhase | null> {
  const locked = new Set(review.candidates.filter((c) => c.alreadyDecided).map((c) => c.address));
  try {
    await confirmSeed(session, [...ticks].filter((a) => !locked.has(a)), key);
    return null;
  } catch (err) {
    return { state: "ready", review, error: err instanceof SeedRefused && err.said !== null ? err.said : undefined };
  }
}
