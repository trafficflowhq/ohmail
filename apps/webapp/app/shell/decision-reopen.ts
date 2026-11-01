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
  facts: ReadonlyArray<NonNullable<Parameters<typeof notOrganizingYetOf>[0]>[number] & { createdAt: string }> | null;
  consent: { known: boolean; onboardingKnown: boolean; onboardingCompletedAt: string | null };
  /** A door that can open the first-run stage (never the demo). */
  stage: boolean;
}

/**
 * THE ORGANIZE DECISION REOPENS ONCE PER LAUNCH while a mailbox is undecided — consent null and no
 * live holder (`notOrganizingYetOf`). Once: a person who closes it is not asked again in this
 * launch, and a stage that drew a step has already asked (`markDecisionAsked`). A mailbox that
 * existed when setup was last left (Close setup or its last verb stamp `onboardingCompletedAt` on
 * the server) is not asked again on any device; a mailbox added since is, as a re-run, which opens
 * on the consent statement. It waits for the live consent read: the boot cache carries no stamp.
 */
export function useDecisionReopensOncePerLaunch(routeFirstRun: boolean, input: DecisionReopenInput | undefined): void {
  const facts = input?.facts ?? null;
  const known = (input?.consent.known ?? false) && (input?.consent.onboardingKnown ?? false);
  const completedAt = input?.consent.onboardingCompletedAt ?? null;
  const stage = input?.stage ?? false;
  useEffect(() => {
    if (asked.done) return;
    if (routeFirstRun) return;
    if (!stage || facts === null || !known) return;
    const left = completedAt === null ? Number.NaN : Date.parse(completedAt);
    const ask = notOrganizingYetOf(facts)?.mailboxes.find((m) => {
      const created = Date.parse(facts.find((f) => f.id === m.id)?.createdAt ?? "");
      return !(left >= created); // no stamp, or setup left before it arrived: ask
    });
    if (ask === undefined) return;
    asked.done = true;
    goFirstRun({ rerun: completedAt !== null, mailboxId: ask.id });
  }, [completedAt, facts, known, routeFirstRun, stage]);
}
