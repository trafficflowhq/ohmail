/**
 * AGREE, AND THE CLAIM QUESTION BEFORE IT. The consent, the window and the scope ride ONE call
 * (`POST /mailboxes/:id/organize`), so the window step builds that one press; the claim question ("Organize here
 * instead" or "Just read it here") decides only whether it asks for a takeover. The window is pre-filled from what the
 * account stored and 365 days on a first run; what agreeing will screen is read before the press for the window being
 * chosen, and read again while the first import still reads mail.
 */
import { useEffect, useState } from "react";
import type { FirstRunDecisionCount } from "../../doors/first-run-host.js";
import type { OnboardingFacts, OnboardingStep } from "../../doors/onboarding.js";
import { holderStopped, takeoverState, type TakeoverState } from "../../reading/reader-holder.js";
import type { MailboxId } from "../connect/types.js";
import { decisionCountOf } from "./answers.js";
import type { FirstRunVerbs, Screening } from "./ground.js";
import { initialWindow, raiseStamp, type WindowChoice } from "./rules.js";
import type { GatedAct } from "./use-gated.js";

/** How often the window's count is read again while the first import reads mail: at least this, and ten reads' time. */
export const COUNT_REREAD_MS = 5_000;

export interface AgreeInput {
  readonly verbs: FirstRunVerbs;
  readonly facts: OnboardingFacts;
  /** The facts as read, before the stage's own assertions: the takeover's stamps are the row's. */
  readonly read: OnboardingFacts;
  readonly step: OnboardingStep | null;
  readonly mailboxId: MailboxId | null;
  readonly claimAnswered: boolean;
  readonly rerun: boolean;
  readonly screening?: { readonly dormancyDays: number; readonly scope: "window" | "all_time" };
}

export interface Agree {
  readonly win: WindowChoice;
  setWin(next: WindowChoice): void;
  /** The claim question's answer: the person's press, else "here" over a stopped holder or a consented mailbox. */
  readonly choice: "here" | "read" | null;
  choose(next: "here" | "read"): void;
  /** The holder stopped checking in: every sentence of the question takes its stopped twin. */
  readonly stopped: boolean;
  /** A claim was authorized in this run: "on its next pass", never a success. */
  readonly claimed: boolean;
  /** What agreeing will screen, for this mailbox and this window, or `null`. */
  readonly count: FirstRunDecisionCount | null;
  /** The takeover this run asked for, read off the row. */
  readonly takeover: TakeoverState | null;
  /** Agree, as the value the press sends. */
  agreeAct(): GatedAct | null;
  /** "Organize here instead" on a consented mailbox, as the value the press sends. */
  takeoverAct(): GatedAct | null;
  /** What a stored Agree or a taken claim leaves behind. */
  asked(mailboxId: MailboxId): void;
  claimedHere(): void;
}

function screeningOf(win: WindowChoice): Screening {
  return win === "all" ? { scope: "all_time" } : { dormancyDays: Number(win), scope: "window" };
}

/** What agreeing will screen, for the window being chosen; read again while the first import still reads mail. */
function useDecisionCount(
  input: AgreeInput,
  win: WindowChoice,
  takingOver: boolean,
): FirstRunDecisionCount | null {
  const { verbs, step, mailboxId } = input;
  const key = mailboxId === null ? null : `${mailboxId}|${win}`;
  const [read, setRead] = useState<{ key: string; value: FirstRunDecisionCount } | null>(null);
  useEffect(() => {
    const count = verbs.countDecision;
    if (step !== "window" || key === null || mailboxId === null || takingOver || !count) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    const ask = (): void => {
      const started = Date.now();
      count.call(verbs, mailboxId, screeningOf(win)).then(
        (answer) => {
          const value = decisionCountOf(answer);
          if (!live || value === null) return;
          setRead({ key, value });
          if (!value.mirrored)
            again = setTimeout(ask, Math.max(COUNT_REREAD_MS, 10 * (Date.now() - started)));
        },
        () => {
          /* no count, no claim */
        },
      );
    };
    ask();
    return () => {
      live = false;
      if (again !== null) clearTimeout(again);
    };
  }, [key, mailboxId, step, takingOver, verbs, win]);
  return read !== null && read.key === key && !takingOver ? read.value : null;
}

export function useAgree(input: AgreeInput): Agree {
  const { facts, read, mailboxId, claimAnswered, rerun } = input;
  const [win, setWin] = useState<WindowChoice>(() => initialWindow(input.screening));
  const [picked, setPicked] = useState<"here" | "read" | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [ask, setAsk] = useState<{ mailboxId: MailboxId; floor: string | null } | null>(null);
  const stopped = holderStopped(facts.mailbox);
  /* NOTHING IS PRE-SELECTED OVER A LIVE HOLDER: an unread Continue displaced a running organizer. */
  const choice = picked ?? (stopped || facts.mailbox?.organizeConsentedAt ? "here" : null);
  const takingOver = claimAnswered && choice === "here";
  const count = useDecisionCount(input, win, takingOver);

  const seen = read.mailbox?.takeoverAuthorizedAt ?? null;
  useEffect(() => {
    if (seen === null) return;
    setAsk((a) => {
      if (a === null || a.mailboxId !== mailboxId) return a;
      const floor = raiseStamp(a.floor, seen);
      return floor === a.floor ? a : { ...a, floor };
    });
  }, [seen, mailboxId]);
  const takeover = takeoverState(
    facts.mailbox,
    ask !== null && ask.mailboxId === mailboxId
      ? { floor: ask.floor ?? read.mailbox?.organizeConsentedAt ?? null }
      : null,
  );

  return {
    win,
    setWin,
    choice,
    choose: setPicked,
    stopped,
    claimed,
    count,
    takeover,
    agreeAct: () => {
      if (mailboxId === null) return null;
      /* A TAKEOVER ONLY BY NAME: the person chose "Organize here instead" in this run; every other Agree is a join. */
      const intent = takingOver ? "takeover" : "join";
      return {
        verb: "agree",
        mailboxId,
        body: {
          screening: screeningOf(win),
          // The count was on screen: the organizer screens exactly that set after this press.
          ...(intent === "join" && count !== null ? { screenBacklog: true as const } : {}),
          intent,
        },
        sweeps: intent === "join" && !rerun && count !== null && count.senders > 0,
        reader: facts.mailbox?.organizerRole === "reader",
      };
    },
    takeoverAct: () => (mailboxId === null ? null : { verb: "takeover", mailboxId }),
    asked: (id) => setAsk({ mailboxId: id, floor: null }),
    claimedHere: () => setClaimed(true),
  };
}
