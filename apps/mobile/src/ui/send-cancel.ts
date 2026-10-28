/**
 * CANCEL SEND CANCELS, AND A CLOSE KEEPS — the composer's half of it, as a decision rather than a
 * branch inside a sheet.
 *
 * A queued send belongs to the INTENT, not to the screen. Leaving the sheet (Back, a tap outside,
 * the footer's close) leaves the send standing under its one key: the person was told it goes when
 * the network is back, and the flush keeps that promise once. Only the explicit Cancel send
 * withdraws it, and says so. One delivery per intent is the key's job (`sendIntentOf` and the
 * standing-send join), not the close's; a send left this way, or restored after a relaunch, is
 * joined only by a press carrying the same words, files and time (`leaveSend`), so a later message
 * never replaces it. A close after a Cancel the server could not answer keeps the words in Drafts.
 */
import type { queuedCaptionKey } from "../engine/send-waits";
import { refuse, type Refusal } from "../refusal";

/**
 * The engine's three withdrawal answers, RESTATED rather than imported. `src/ui` sits outside the
 * engine seam and `test/privacy.test.ts` confines that package to a named allow-list — widening a
 * confinement for a three-word union is the wrong trade, so the two are pinned mutually assignable
 * in `test/send-once-through-cancel.test.ts` instead, where a drift is a compile error.
 */
export type WithdrawAnswer = "withdrawn" | "on_the_wire" | "gone" | "unknown";

/** The compose sheet's send phase — `MessageActions.tsx`'s own union. */
export type ComposerPhase = "idle" | "sending" | "queued" | "unverified";

/** Which way out the person took: any close of the sheet, or the explicit Cancel send. */
export type CloseRoad = "close" | "cancelSend";

/** What that way out means right now. */
export type CancelAct = "close" | "withdraw" | "keepSend";

/**
 * WHICH CLOSE THIS IS. Over a queued send whose key this composer holds, Cancel send withdraws it
 * and a close keeps it (`keepSend`); everything else just closes. `alreadySent` is the second
 * press after a "too late" answer, and `cancelOwed` a close after a Cancel the server could not
 * answer: the sentence was said in the sheet, so the close only dismisses.
 */
export function cancelAct(o: {
  road: CloseRoad;
  phase: ComposerPhase;
  key: string | null;
  alreadySent: boolean;
  cancelOwed?: boolean;
}): CancelAct {
  if (o.phase !== "queued" || o.key === null || o.alreadySent) return "close";
  if (o.road === "cancelSend") return "withdraw";
  return o.cancelOwed === true ? "close" : "keepSend";
}

/** Is Cancel send offered in the footer? Only while it would withdraw. */
export const cancelSendOffered = (o: { phase: ComposerPhase; key: string | null; alreadySent: boolean }): boolean =>
  cancelAct({ ...o, road: "cancelSend" }) === "withdraw";

/**
 * The sentence a withdrawn send earns. It names Drafts only where a row is known to hold the words:
 * the standalone engine writes the row before it holds the send step, and a bound row is released
 * back to a draft.
 */
export const cancelledSay = (o: { standalone: boolean; bound: boolean }): Refusal =>
  refuse(o.standalone || o.bound ? "sendCancelledInDrafts" : "sendCancelled");

/** The sheet's caption, said again as it closes over a waiting send. Literal arms: `refusal.test.ts` reads the keys. */
export const keptSay = (caption: ReturnType<typeof queuedCaptionKey>): Refusal =>
  refuse(caption === "replySendingLong" ? "replySendingLong" : caption === "replyQueuedOffline" ? "replyQueuedOffline" : "replyQueued");

/** What the sheet does with the engine's answer. */
export type CancelSaid = "close" | "already_sent" | "unknown";

/**
 * What the flush ledger says became of this key — `World.sendOutcome`'s answer, restated here for
 * the reason {@link WithdrawAnswer} is, and pinned mutually assignable in the same test.
 */
export type SendVerdict = "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown";

/**
 * THE ANSWER, RENDERED. `withdrawn` is the cancellation and the sheet goes. `on_the_wire`
 * withdrew NOTHING: the request has left and this device cannot un-send it, which is a sentence
 * the person is owed rather than a silent close.
 *
 * `gone` is a key the queue no longer holds, and it means one of two things. A flush that already
 * DELIVERED it leaves this press nothing to cancel — and closing in silence made the flush's own
 * toast, which may long since have gone, the only notice the message ever went. So the ledger's
 * verdict is read at the press: a confirmed send says it was sent, and everything else closes.
 */
export function afterWithdraw(outcome: WithdrawAnswer, settled: SendVerdict = "unknown"): CancelSaid {
  if (outcome === "on_the_wire") return "already_sent";
  // Nothing cancelled: the sheet stays and says so. The phone's store shares no disk with another
  // window, so on the phone this is the server not answering for a send that may have left.
  if (outcome === "unknown") return "unknown";
  return outcome === "gone" && settled === "confirmed" ? "already_sent" : "close";
}

/** What a Cancel send press ends in: the sheet's next step, and the sentence it leaves with. */
export interface CancelEnding { said: CancelSaid; say: Refusal | null }

/**
 * THE CANCEL SEND PRESS, as the sheet takes it. `null` is a press while an earlier one is still
 * being asked. The verdict is read AFTER the withdrawal answers: a flush can settle under the
 * await, and the fresher reading is the one this press is owed.
 */
export async function cancelSendPress(o: {
  asking: { current: boolean };
  withdraw: () => Promise<WithdrawAnswer>;
  verdict: () => SendVerdict;
  standalone: boolean;
  bound: boolean;
}): Promise<CancelEnding | null> {
  if (o.asking.current) return null;
  o.asking.current = true;
  try {
    const answer = await o.withdraw();
    const said = afterWithdraw(answer, o.verdict());
    // Only this press's withdrawal is a cancellation; a key already `gone` ended elsewhere, and the flush says how.
    return { said, say: said === "close" && answer === "withdrawn" ? cancelledSay(o) : null };
  } finally {
    o.asking.current = false;
  }
}

/** The row a waiting send's press wrote, as Drafts lists it (`WorldDraft.waiting`); `null` before it has one. */
export const waitingRowOf = (
  drafts: readonly { id: string; waiting: { key: string; rowless: boolean } | null }[], key: string,
): string | null => drafts.find((d) => d.waiting?.key === key && !d.waiting.rowless)?.id ?? null;
