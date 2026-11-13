/**
 * THE ONE WAY TO AN OFFER of an event found in a letter: the list, its counts and any found row pass here. Only the
 * letter's own calendar part and its own data are offered. A reading of the letter's sentences (by the rules, or a
 * model's answer checked against them) is not offered while the tracked wrong readings of the finding stand: a
 * record cannot tell a right reading from one of those. A word this list does not name is never offered.
 */
import type { FoundEvidence } from "@ohmail/cal-core";

export const OFFERED_EVIDENCE = ["calendar", "data"] as const satisfies readonly FoundEvidence[];

export function mayOffer(s: { readonly evidence: string }): boolean {
  return (OFFERED_EVIDENCE as readonly string[]).includes(s.evidence);
}
