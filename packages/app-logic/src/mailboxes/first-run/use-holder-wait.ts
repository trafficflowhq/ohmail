/**
 * CONSENT AND AGREE WAIT FOR THE LOOK. Until the door has read who holds the mailbox, a live holder may be one read
 * away, and so may the name of one the door refused a press over; the guard in `firstRunStep` moves the run to the
 * claim question when it lands. While it waits the facts are read again every `HOLDER_REREAD_MS`; past
 * `HOLDER_CHECK_MS` the wait says it is slow and offers one more read. It never offers consent or Agree over a look
 * that has not answered.
 */
import { useEffect, useRef, useState } from "react";
import type { OnboardingFacts, OnboardingStep } from "../../doors/onboarding.js";
import { holderAnswered, holderVerdict } from "../../reading/reader-holder.js";
import type { MailboxId } from "../connect/types.js";
import { HOLDER_CHECK_MS, HOLDER_REREAD_MS } from "./rules.js";

export interface HolderWaitInput {
  readonly facts: OnboardingFacts;
  readonly step: OnboardingStep | null;
  readonly mailboxId: MailboxId | null;
  readonly claimAnswered: boolean;
  refresh(): Promise<void>;
}

export interface HolderWait {
  /** Consent and Agree wait: the look has not answered, or a refused press's holder is not named yet. */
  readonly awaiting: boolean;
  /** The wait outlasted its bound: it says so and offers one more read. */
  readonly slow: boolean;
  readonly retrying: boolean;
  retry(): void;
  /** Agree was refused over a live holder these facts do not name yet. */
  heldPress(mailboxId: MailboxId): void;
}

export function useHolderWait({
  facts,
  step,
  mailboxId,
  claimAnswered,
  refresh,
}: HolderWaitInput): HolderWait {
  const [heldPressFor, setHeldPressFor] = useState<MailboxId | null>(null);
  const [slowFor, setSlowFor] = useState<MailboxId | null>(null);
  const [retrying, setRetrying] = useState(false);
  const awaiting =
    mailboxId !== null &&
    (step === "consent" || step === "window") &&
    !claimAnswered &&
    (!holderAnswered(facts.mailbox) ||
      (heldPressFor === mailboxId && holderVerdict(facts.mailbox) !== "somebody"));
  /* A ref: the ground hands a fresh closure each render, and the wait reads on a timer. */
  const read = useRef(refresh);
  read.current = refresh;
  useEffect(() => {
    if (!awaiting || mailboxId === null || slowFor === mailboxId) return;
    let reading = false;
    const again = setInterval(() => {
      if (reading) return;
      reading = true;
      read
        .current()
        .catch(() => {
          /* the next tick */
        })
        .finally(() => {
          reading = false;
        });
    }, HOLDER_REREAD_MS);
    const bound = setTimeout(() => setSlowFor(mailboxId), HOLDER_CHECK_MS);
    return () => {
      clearInterval(again);
      clearTimeout(bound);
    };
  }, [awaiting, mailboxId, slowFor]);
  /* A wait that ended starts from nothing next time, and a named holder spends the refused press. */
  useEffect(() => {
    if (!awaiting && slowFor !== null) setSlowFor(null);
    if (heldPressFor !== null && heldPressFor === mailboxId && holderVerdict(facts.mailbox) === "somebody")
      setHeldPressFor(null);
  }, [awaiting, slowFor, heldPressFor, mailboxId, facts.mailbox]);
  return {
    awaiting,
    slow: awaiting && slowFor === mailboxId,
    retrying,
    retry: () => {
      setRetrying(true);
      read
        .current()
        .catch(() => {
          /* still waiting */
        })
        .finally(() => setRetrying(false));
    },
    heldPress: setHeldPressFor,
  };
}
