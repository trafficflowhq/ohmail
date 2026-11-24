/**
 * THE GUIDED DECISION: one sender, the head of this mailbox's own queue, decided through the Screener's own model (the
 * same act as a decision taken in the Screener a minute later). With several mailboxes the lead counts this mailbox's
 * waiting senders. A decision pressed while a takeover this run asked for stands is pressed again, once, if the
 * takeover is refused: it then became a rule on an install that files nothing, and the holder that kept the mailbox
 * is asked instead.
 */
import { useEffect, useRef, useState } from "react";
import { isSharedProviderDomain } from "@trafficflow/core/rule-order";
import type { OnboardingStep } from "../../doors/onboarding.js";
import type { TakeoverState } from "../../reading/reader-holder.js";
import type { MailboxId } from "../connect/types.js";
import { waitingOf } from "./answers.js";
import type { DecideScope, DecideTo, FirstRunSender, FirstRunVerbs } from "./ground.js";

export interface DecideInput {
  readonly verbs: FirstRunVerbs;
  readonly step: OnboardingStep | null;
  readonly mailboxId: MailboxId | null;
  readonly sender: FirstRunSender | null;
  readonly takeover: TakeoverState | null;
}

export interface Decide {
  readonly scope: DecideScope;
  setScope(next: DecideScope): void;
  /** A shared provider's domain is never a scope: a decision about everyone there admits nobody. */
  readonly sharedDomain: boolean;
  /** This mailbox's waiting senders, on an install with several; `null` where unknown or not asked. */
  readonly hereCount: number | null;
  /** The sender decided in this run: the summary says where it stands. */
  readonly decidedName: string | null;
  /** The sender whose decision went to the holder that kept the mailbox. */
  readonly reasked: string | null;
  decide(to: DecideTo, markRead: boolean): void;
}

export function useDecide({ verbs, step, mailboxId, sender, takeover }: DecideInput): Decide {
  const [scope, setScope] = useState<DecideScope>("sender");
  const [decidedName, setDecidedName] = useState<string | null>(null);
  const [reasked, setReasked] = useState<string | null>(null);
  const [waitingHere, setWaitingHere] = useState<{ mailboxId: MailboxId; senders: number | null } | null>(
    null,
  );
  const decidedUnder = useRef<{ mailboxId: MailboxId | null; again: () => void } | null>(null);
  const address = sender?.address ?? "";
  const sharedDomain = isSharedProviderDomain(address.slice(address.lastIndexOf("@") + 1));
  const many = step === "decide" && sender?.many === true;
  const waiting = sender?.waiting ?? 0;
  useEffect(() => {
    const count = verbs.countWaiting;
    if (!many || mailboxId === null || !count) return;
    let live = true;
    count(mailboxId).then(
      (answer) => {
        if (live) setWaitingHere({ mailboxId, senders: waitingOf(answer) });
      },
      () => {
        if (live) setWaitingHere({ mailboxId, senders: null });
      },
    );
    return () => {
      live = false;
    };
  }, [many, waiting, verbs, mailboxId]);
  useEffect(() => {
    if (takeover !== "refused") return;
    const pressed = decidedUnder.current;
    if (pressed === null || pressed.mailboxId !== mailboxId) return;
    decidedUnder.current = null;
    pressed.again();
    setReasked(decidedName);
  }, [takeover, mailboxId, decidedName]);
  return {
    scope,
    setScope,
    sharedDomain,
    hereCount: waitingHere !== null && waitingHere.mailboxId === mailboxId ? waitingHere.senders : null,
    decidedName,
    reasked,
    decide: (to, markRead) => {
      if (sender === null) return;
      const opts = { markRead, scope: sharedDomain ? ("sender" as const) : scope };
      sender.decide(to, opts);
      setDecidedName(sender.name);
      decidedUnder.current =
        takeover === "asked" ? { mailboxId, again: () => sender.decide(to, opts) } : null;
    },
  };
}
