/**
 * WHICH SCREEN IS ON, AND THE CURSOR INSIDE ONE RUN. The step is DERIVED (`firstRunStep` over the facts) and the
 * derivation is the authority; the cursor `at` is what Back and Continue move, for the screens that are not resume
 * targets. Every write clears it (`use-writes.ts`), so the derivation decides what comes next.
 *
 * Two answers are kept per mailbox and never stored: which mailbox's claim question was answered in this run (being
 * asked twice costs a screen, not being asked costs a mailbox), and the read that put a holder on that question, as a
 * floor for every later read (`raiseStamp`): a ref, written only while the question stands with a holder on it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { onboardingPath, type OnboardingFacts, type OnboardingStep } from "../../doors/onboarding.js";
import { holderVerdict } from "../../reading/reader-holder.js";
import type { MailboxId } from "../connect/types.js";
import { nextStep, raiseStamp, railFor } from "./rules.js";
import { firstRunStep } from "./step.js";

export interface CursorInput {
  readonly facts: OnboardingFacts;
  readonly mailboxId: MailboxId | null;
  /** The run's intents, off the route: a re-run (`again`) and an add (`add`). */
  readonly rerun: boolean;
  readonly add: boolean;
  /** The route names a mailbox the account does not hold, or none while it holds several. */
  readonly vanished: boolean;
  readonly choose: boolean;
}

export interface Cursor {
  readonly step: OnboardingStep | null;
  readonly at: OnboardingStep | null;
  setAt(next: OnboardingStep | null): void;
  /** The walk this run takes, and the rail of its phases. */
  readonly path: readonly OnboardingStep[];
  readonly rail: ReadonlyArray<{ id: string; steps: OnboardingStep[] }>;
  /** Where the run is on its rail: never -1, the last phase where its step has just left the walk. */
  readonly railAt: number;
  /** The step Continue goes to, and the one Back goes to. */
  readonly next: OnboardingStep | undefined;
  readonly back: OnboardingStep | undefined;
  /** This run answered the claim question about this mailbox. */
  readonly claimAnswered: boolean;
  answerClaim(): void;
}

export function useCursor(input: CursorInput): Cursor {
  const { facts, mailboxId, rerun, add, vanished, choose } = input;
  const [at, setAt] = useState<OnboardingStep | null>(null);
  const [claimAnsweredFor, setClaimAnsweredFor] = useState<MailboxId | null>(null);
  const heldStamp = useRef<{ mailboxId: MailboxId | null; at: string | null } | null>(null);
  const floor =
    heldStamp.current !== null && heldStamp.current.mailboxId === mailboxId ? heldStamp.current.at : null;
  /* WHETHER THE QUESTION WAS SHOWN AT ALL, which is not the same as the stamp it was shown under: a host that stamps
     nothing leaves the floor null on a run that WAS asked. */
  const asked = heldStamp.current !== null && heldStamp.current.mailboxId === mailboxId;
  const claimAnswered = mailboxId !== null && claimAnsweredFor === mailboxId;
  const step = firstRunStep(facts, at, rerun, claimAnswered, add, floor, asked, vanished, choose);

  useEffect(() => {
    /* ONLY WHILE THE QUESTION IS ON SCREEN WITH A HOLDER ON IT, and RAISED, NEVER ASSIGNED: holder reads arrive out
       of order too, and an assignment let a late one lower the floor it had just set. */
    if (step !== "elsewhere" || holderVerdict(facts.mailbox) !== "somebody") return;
    const prior =
      heldStamp.current !== null && heldStamp.current.mailboxId === mailboxId ? heldStamp.current.at : null;
    heldStamp.current = { mailboxId, at: raiseStamp(prior, facts.mailbox?.organizerEventAt) };
  }, [step, facts.mailbox, mailboxId]);

  const path = useMemo(() => onboardingPath(facts, add), [facts, add]);
  const rail = useMemo(() => railFor(path), [path]);
  const found = step === null ? -1 : rail.findIndex((r) => r.steps.includes(step));
  return {
    step,
    at,
    setAt,
    path,
    rail,
    railAt: found === -1 ? Math.max(0, rail.length - 1) : found,
    next: step === null ? undefined : nextStep(path, step),
    back: step === null ? undefined : path[path.indexOf(step) - 1],
    claimAnswered,
    answerClaim: () => {
      if (mailboxId !== null) setClaimAnsweredFor(mailboxId);
    },
  };
}
