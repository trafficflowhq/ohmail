"use client";

import { useEffect } from "react";
import { notOrganizingYetOf } from "./mail-state";
import { goFirstRun } from "./routing";

/** Whether this launch has asked the organize decision of an undecided mailbox. One per JS context. */
const asked = { done: false };

/** Test seam: a fresh launch for the next case. */
export function resetDecisionAskedForTests(): void {
  asked.done = false;
}

/** The stage drew a step: this launch has asked. A run with nothing to draw has not, and leaves. */
export function markDecisionAsked(): void {
  asked.done = true;
}

/** What the reopen reads: the roster, the consent read, and whether this door has a stage at all. */
export interface DecisionReopenInput {
  facts: Parameters<typeof notOrganizingYetOf>[0];
  consent: { known: boolean; onboardingCompletedAt?: string | null };
  /** A door that can open the first-run stage (never the demo). */
  stage: boolean;
}

/**
 * THE ORGANIZE DECISION REOPENS ONCE PER LAUNCH while a mailbox is undecided — consent null and no
 * live holder (`notOrganizingYetOf`). Once: a person who closes it is not asked again in this
 * launch, and a stage that drew a step has already asked (`markDecisionAsked`). A completed onboarding reopens
 * it as a re-run, which opens on the consent statement.
 */
export function useDecisionReopensOncePerLaunch(routeFirstRun: boolean, input: DecisionReopenInput | undefined): void {
  const facts = input?.facts ?? null;
  const known = input?.consent.known ?? false;
  const completedAt = input?.consent.onboardingCompletedAt ?? null;
  const stage = input?.stage ?? false;
  useEffect(() => {
    if (asked.done) return;
    if (routeFirstRun) return;
    if (!stage || facts === null || !known) return;
    const undecided = notOrganizingYetOf(facts);
    if (undecided === null) return;
    asked.done = true;
    goFirstRun({ rerun: completedAt !== null, mailboxId: undecided.mailboxes[0]!.id });
  }, [completedAt, facts, known, routeFirstRun, stage]);
}
