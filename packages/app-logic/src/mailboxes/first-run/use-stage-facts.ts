/**
 * THE FACTS THE STAGE DERIVES FROM, with what its own writes proved applied before the read catches up. "Re-derive
 * after every write" needs the write to be VISIBLE, and a re-read is a request, not a fact: neither the hosted list nor
 * the local mirror is guaranteed to have caught up by the next render, and row 4 is `if (!consented) return "consent"`.
 * Two assertions, each true when made and each keyed by mailbox, so "Start over → forget this mailbox" plus a
 * reconnect never carries one onto a new row:
 *
 * - AGREED: the organize call answered `stored`; the consent stands until the read says so itself.
 * - THE SWEEP'S HOLD: a join Agree whose window showed senders to screen holds the pull (the import reads as not over)
 *   until the queue has any, or until `AGREE_SWEEP_MS` from the press. `done` latches: a release never holds again.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { importOverOf, type OnboardingFacts } from "../../doors/onboarding.js";
import { AGREE_REREAD_MS, AGREE_SWEEP_MS, firstRunImportOver } from "../../doors/first-run-queue-settle.js";
import type { MailboxId } from "../connect/types.js";

export interface StageFactsInput {
  /** The facts as the ground read them. */
  readonly read: OnboardingFacts;
  readonly mailboxId: MailboxId | null;
  /** Ask the store for the Screener's queue again, while the hold waits for the senders its Agree moves. */
  readonly rereadQueue: () => Promise<void>;
}

export interface StageFacts {
  readonly facts: OnboardingFacts;
  /** The import's own end, before the hold narrows it: the pull's line says which wait it is. */
  readonly importReallyOver: boolean;
  readonly sweepHolding: boolean;
  /** Agree stored for this mailbox: say so until the read does. */
  agreed(mailboxId: MailboxId): void;
  /** Agree asked to screen the senders it showed: hold the pull for them. */
  sweep(mailboxId: MailboxId): void;
}

export function useStageFacts({ read, mailboxId, rereadQueue }: StageFactsInput): StageFacts {
  const [consented, setConsented] = useState<{ mailboxId: MailboxId; at: string } | null>(null);
  const [sweepHold, setSweepHold] = useState<{ mailboxId: MailboxId; at: number; done: boolean } | null>(
    null,
  );
  const sweepHolding =
    sweepHold !== null && !sweepHold.done && sweepHold.mailboxId === mailboxId && read.queuedSenders === 0;
  const facts = useMemo(() => {
    const mb = read.mailbox;
    if (!mb) return read;
    const agreed = consented !== null && !mb.organizeConsentedAt && consented.mailboxId === mailboxId;
    if (!agreed && !sweepHolding) return read;
    return {
      ...read,
      mailbox: {
        ...mb,
        ...(agreed ? { organizeConsentedAt: consented.at } : {}),
        ...(sweepHolding ? { importOver: firstRunImportOver(mb.importOver, true) } : {}),
      },
    };
  }, [consented, mailboxId, read, sweepHolding]);

  const queuedNow = read.queuedSenders > 0;
  /* A ref: the ground hands a fresh closure each render, and the hold reads on a timer. */
  const reread = useRef(rereadQueue);
  reread.current = rereadQueue;
  useEffect(() => {
    if (sweepHold === null || sweepHold.done || sweepHold.mailboxId !== mailboxId) return;
    if (queuedNow) {
      setSweepHold({ ...sweepHold, done: true });
      return;
    }
    const bound = setTimeout(
      () => setSweepHold((h) => (h === sweepHold ? { ...h, done: true } : h)),
      Math.max(0, sweepHold.at + AGREE_SWEEP_MS - Date.now()),
    );
    const again = setInterval(() => {
      reread.current().catch(() => {
        /* the next ask, or the bound */
      });
    }, AGREE_REREAD_MS);
    return () => {
      clearTimeout(bound);
      clearInterval(again);
    };
  }, [sweepHold, mailboxId, queuedNow]);

  return {
    facts,
    importReallyOver: read.mailbox !== null && importOverOf(read.mailbox),
    sweepHolding,
    agreed: (id) => setConsented({ mailboxId: id, at: new Date().toISOString() }),
    sweep: (id) => setSweepHold({ mailboxId: id, at: Date.now(), done: false }),
  };
}
