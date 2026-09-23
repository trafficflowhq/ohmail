/**
 * WHAT THE DRAFTS CARD SAYS AND OFFERS — the decisions `DraftReader` renders, pure so every hold
 * state is measured without a device. The webapp `DraftsView` is the reference: a held row says
 * what is known and offers Send again / It was sent — dismiss; Discard asks where it was pressed
 * (one sentence, Keep, Discard; back keeps); a refused discard is said in the row, never a toast.
 */
import { Copy } from "../copy";
import type { DraftHeldSays, DraftSendAgainOutcome, WorldDraft } from "../state/world";

/** Why a Discard did not happen, said in the row. One reason today: a send still running. */
export type DraftDiscardRefusal = "stillSending";

/** Why a Send again did not send, said in the row — never a toast. */
export type DraftSendAgainRefusal = Exclude<DraftSendAgainOutcome, "sent">;

/** The held row's sentence — the state line and the two acts' group label alike. */
export function heldSentence(says: DraftHeldSays): string {
  if (says === "checking") return Copy.draftsHeldChecking;
  if (says === "notInSent") return Copy.draftsHeldNotInSent;
  return Copy.draftsHeldInterrupted;
}

/**
 * WHETHER A DISCARD GOES TO THE WIRE — the webapp `discardDecision`'s phone half. A row still
 * calling itself `sending` is refused HERE: the server holds its draft under the send's key and
 * would answer a 409 naming a schedule, which is the wrong sentence. Everything else asks the
 * server, which admits an `unverified` discard and refuses a `pending` send by name.
 */
export function discardDecision(row: Pick<WorldDraft, "state">): "wire" | DraftDiscardRefusal {
  return row.state === "interrupted" ? "stillSending" : "wire";
}

export function refusalSentence(why: DraftDiscardRefusal): string {
  switch (why) {
    case "stillSending":
      return Copy.draftsDiscardStillSending;
  }
}

export function sendAgainSentence(why: DraftSendAgainRefusal): string {
  switch (why) {
    case "stillRunning": return Copy.draftsResolveStillRunning;
    case "notReached": return Copy.draftsResolveFailed;
    case "bodyUnknown": return Copy.draftsBodyUnavailable;
    case "queued": return Copy.replyQueued;
    case "unverified": return Copy.replyUnverified;
    case "failed": return Copy.replyFailed;
  }
}

/** The card's controls, as a plan: what stands where, in the catalogue's words. */
export interface DraftCardPlan {
  /** The held sentence, or `null` for an ordinary draft. */
  held: string | null;
  /**
   * The two acts, offered exactly where there is a held sentence — or, once Send again is
   * pressed, its question standing in their place (the second press the web editor's Send is).
   */
  acts:
    | { kind: "buttons"; sendAgain: string; itWasSent: string }
    | { kind: "confirm"; what: string; keep: string; sendAgain: string }
    | null;
  /** Discard, or — once pressed — the question standing in its place. */
  discard:
    | { kind: "button"; label: string }
    | { kind: "confirm"; what: string; keep: string; discard: string };
  /** A refused discard's sentence, rendered in the row below the control. */
  refusal: string | null;
  /** A Send again that did not send, said in the row where the acts are. */
  sendRefusal: string | null;
}

export function draftCardPlan(
  row: Pick<WorldDraft, "heldSays">,
  ui: {
    confirming: boolean;
    confirmingSendAgain: boolean;
    refusal: DraftDiscardRefusal | null;
    sendRefusal?: DraftSendAgainRefusal | null;
  },
): DraftCardPlan {
  const held = row.heldSays === null ? null : heldSentence(row.heldSays);
  return {
    held,
    acts: held === null
      ? null
      : ui.confirmingSendAgain
        ? { kind: "confirm", what: Copy.draftsSendAgainWhat, keep: Copy.draftsDiscardCancel, sendAgain: Copy.draftsSendAgain }
        : { kind: "buttons", sendAgain: Copy.draftsSendAgain, itWasSent: Copy.draftsItWasSent },
    discard: ui.confirming
      ? { kind: "confirm", what: Copy.draftsDiscardWhat, keep: Copy.draftsDiscardCancel, discard: Copy.draftsDiscardConfirm }
      : { kind: "button", label: Copy.draftsDiscard },
    refusal: ui.refusal === null ? null : refusalSentence(ui.refusal),
    sendRefusal: ui.sendRefusal == null ? null : sendAgainSentence(ui.sendRefusal),
  };
}

/**
 * THE BACK GESTURE KEEPS. `true` = the press was the question's (consumed, the draft kept);
 * `false` = no question stands and the navigator takes it. Android's hardware back asks this;
 * iOS reaches the same answer through `onAccessibilityEscape` and by leaving the screen.
 */
export function backKeeps(confirming: boolean): boolean {
  return confirming;
}
