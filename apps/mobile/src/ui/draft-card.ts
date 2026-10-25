/**
 * WHAT THE DRAFTS CARD SAYS AND OFFERS — the decisions `DraftReader` renders, pure so every hold
 * state is measured without a device. The webapp `DraftsView` is the reference: a held row says
 * what is known and offers Send again / It was sent — dismiss; Discard asks where it was pressed
 * (one sentence, Keep, Discard; back keeps); a refused discard is said in the row, never a toast.
 */
import { Copy } from "../copy";
import type { queuedCaptionKey } from "../engine/send-waits";
import type { DraftHeldSays, DraftSendAgainOutcome, WorldDraft } from "../state/world";

/**
 * Why a Discard or a Cancel send did not happen, said in the row: a send still running on the
 * server, a waiting send already on its way, or a Cancel the server did not answer.
 */
export type DraftDiscardRefusal = "stillSending" | "alreadySent" | "cancelUnknown";

/** Why a Send again did not send, said in the row — never a toast. */
export type DraftSendAgainRefusal = Exclude<DraftSendAgainOutcome, "sent" | "alreadySent" | "superseded">;

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
    case "alreadySent":
      return Copy.replyAlreadySent;
    case "cancelUnknown":
      return Copy.replyCancelUnreachable;
  }
}

export function sendAgainSentence(why: DraftSendAgainRefusal): string {
  switch (why) {
    case "changed": return Copy.draftsSendAgainChanged;
    case "unchecked": return Copy.draftsSendAgainUnchecked;
    case "notHeld": return Copy.draftsSendAgainNotHeld;
    case "busy": return Copy.draftsSendAgainBusy;
    case "queued": return Copy.replyQueued;
    case "unverified": return Copy.replyUnverified;
    case "failed": return Copy.replyFailed;
  }
}

/** Send again's question on the card: what it does, and that it may arrive twice — the sheet's words. */
export function sendAgainQuestion(): string {
  return `${Copy.draftsSendAgainWhat} ${Copy.replyUnverifiedSendAgain}`;
}

/** The card's controls, as a plan: what stands where, in the catalogue's words. */
export interface DraftCardPlan {
  /** The held sentence, or `null` for an ordinary draft. */
  held: string | null;
  /** A send waiting to go: its line, what is known of it, and the Cancel send label. */
  waiting: { line: string; caption: string; cancelSend: string } | null;
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
  /** After a Send again that can't be matched to the held message: answer not arrived, then edit. */
  notArrived: string | null;
}

export function draftCardPlan(
  row: Pick<WorldDraft, "heldSays"> & Partial<Pick<WorldDraft, "waiting">>,
  ui: {
    confirming: boolean;
    confirmingSendAgain: boolean;
    refusal: DraftDiscardRefusal | null;
    sendRefusal?: DraftSendAgainRefusal | null;
    /** A waiting send's caption off the network door ({@link queuedCaptionKey}); a send on the wire is still sending. */
    queued?: ReturnType<typeof queuedCaptionKey>;
  },
): DraftCardPlan {
  const waiting = row.waiting ?? null;
  const held = waiting !== null || row.heldSays === null ? null : heldSentence(row.heldSays);
  return {
    held,
    waiting: waiting === null
      ? null
      : {
        line: Copy.draftsWaiting,
        caption: waiting.wire ? Copy.replySendingLong : Copy[ui.queued ?? "replyQueued"],
        cancelSend: Copy.cancelSend,
      },
    acts: held === null
      ? null
      : ui.confirmingSendAgain
        ? { kind: "confirm", what: sendAgainQuestion(), keep: Copy.draftsDiscardCancel, sendAgain: Copy.draftsSendAgain }
        : { kind: "buttons", sendAgain: Copy.draftsSendAgain, itWasSent: Copy.draftsItWasSent },
    discard: ui.confirming
      ? {
        kind: "confirm", what: waiting !== null ? Copy.draftsDiscardWaitingWhat : Copy.draftsDiscardWhat,
        keep: Copy.draftsDiscardCancel, discard: Copy.draftsDiscardConfirm,
      }
      : { kind: "button", label: Copy.draftsDiscard },
    refusal: ui.refusal === null ? null : refusalSentence(ui.refusal),
    sendRefusal: ui.sendRefusal == null ? null : sendAgainSentence(ui.sendRefusal),
    notArrived: held !== null && ui.sendRefusal === "changed" ? Copy.draftsNotArrived : null,
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
