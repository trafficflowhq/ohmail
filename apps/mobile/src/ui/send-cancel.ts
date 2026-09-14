/**
 * CANCEL CANCELS — the composer's half of it, as a decision rather than a branch inside a sheet.
 *
 * A queued send belongs to the INTENT, not to the screen: closing the composer over one is the
 * person withdrawing it, and the composer that unmounted without doing so is why a correspondent
 * received the same message twice. There is no React Native renderer in this workspace
 * (`test/fourth-door.test.ts` records it), so the decision lives here and is driven directly;
 * `MessageActions.tsx` is read to prove it is the decision the sheet actually takes.
 */
/**
 * The engine's three withdrawal answers, RESTATED rather than imported. `src/ui` sits outside the
 * engine seam and `test/privacy.test.ts` confines that package to a named allow-list — widening a
 * confinement for a three-word union is the wrong trade, so the two are pinned mutually assignable
 * in `test/send-once-through-cancel.test.ts` instead, where a drift is a compile error.
 */
export type WithdrawAnswer = "withdrawn" | "on_the_wire" | "gone";

/** The compose sheet's send phase — `MessageActions.tsx`'s own union. */
export type ComposerPhase = "idle" | "sending" | "queued" | "unverified";

/** What closing the composer means right now. */
export type CancelAct = "close" | "withdraw";

/**
 * WHICH CLOSE THIS IS. A queued send whose key this composer holds is withdrawn before the sheet
 * goes; everything else just closes. `alreadySent` is the second press: the first one answered
 * "too late", the person read it, and pressing again dismisses rather than asking the engine the
 * same question twice.
 */
export function cancelAct(o: {
  phase: ComposerPhase;
  key: string | null;
  alreadySent: boolean;
}): CancelAct {
  if (o.phase !== "queued" || o.key === null || o.alreadySent) return "close";
  return "withdraw";
}

/** What the sheet does with the engine's answer. */
export type CancelSaid = "close" | "already_sent";

/**
 * THE ANSWER, RENDERED. `withdrawn` is the cancellation and the sheet goes. `gone` is a key the
 * queue no longer holds — the flush ledger has already said what became of it, so this press has
 * nothing to add and the sheet goes too. `on_the_wire` withdrew NOTHING: the request has left and
 * this device cannot un-send it, which is a sentence the person is owed rather than a silent close.
 */
export function afterWithdraw(outcome: WithdrawAnswer): CancelSaid {
  return outcome === "on_the_wire" ? "already_sent" : "close";
}
