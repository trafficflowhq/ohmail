/**
 * THE ORGANIZE DECISION REOPENS ONCE PER LAUNCH, moved out of the web shell (`apps/webapp/app/shell/decision-reopen.ts`)
 * as it stood, with the way to the run an argument: a shell's address is not this package's to write. The launch's
 * mark is `decision-asked.ts`'s, which the stage itself writes when it draws a step.
 */
import { useEffect } from "react";
import { notOrganizingYetOf } from "../../mail-state/mail-state.js";
import { useStableCallback } from "../../press/stable-callback.js";
import { decisionAsked, markDecisionAsked } from "./decision-asked.js";

/** What the reopen reads: the roster, the consent read, and whether this door has a stage at all. */
export interface DecisionReopenInput {
  facts: ReadonlyArray<
    NonNullable<Parameters<typeof notOrganizingYetOf>[0]>[number] & { createdAt: string }
  > | null;
  consent: { known: boolean; onboardingKnown: boolean; onboardingCompletedAt: string | null };
  /** A door that can open the first-run stage (never the demo). */
  stage: boolean;
  /** Whose launch it is: the mark is the account's. With no account there is no launch to mark, and nothing is asked. */
  scope: string | null;
}

/** The run the reopen asks for: a re-run where setup was left before, about this mailbox. */
export interface DecisionRun {
  readonly rerun: boolean;
  readonly mailboxId: string;
}

/**
 * THE ORGANIZE DECISION REOPENS ONCE PER LAUNCH while a mailbox is undecided — consent null and no
 * live holder (`notOrganizingYetOf`). Once: a person who closes it is not asked again in this
 * launch, and a stage that drew a step has already asked (`markDecisionAsked`). A mailbox that
 * existed when setup was last left (Close setup or its last verb stamp `onboardingCompletedAt` on
 * the server) is not asked again on any device; a mailbox added since is, as a re-run, which opens
 * on the consent statement. It waits for the live consent read: the boot cache carries no stamp.
 */
export function useDecisionReopensOncePerLaunch(
  routeFirstRun: boolean,
  input: DecisionReopenInput,
  go: (run: DecisionRun) => void,
): void {
  const { facts, stage, scope } = input;
  const known = input.consent.known && input.consent.onboardingKnown;
  const completedAt = input.consent.onboardingCompletedAt;
  const open = useStableCallback(go);
  useEffect(() => {
    if (scope === null || decisionAsked(scope)) return;
    if (routeFirstRun) return;
    if (!stage || facts === null || !known) return;
    const left = completedAt === null ? Number.NaN : Date.parse(completedAt);
    const ask = notOrganizingYetOf(facts)?.mailboxes.find((m) => {
      const created = Date.parse(facts.find((f) => f.id === m.id)?.createdAt ?? "");
      return !(left >= created); // no stamp, or setup left before it arrived: ask
    });
    if (ask === undefined) return;
    markDecisionAsked(scope);
    open({ rerun: completedAt !== null, mailboxId: ask.id });
  }, [completedAt, facts, known, routeFirstRun, stage, scope, open]);
}
