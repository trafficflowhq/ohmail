"use client";

/**
 * BUYING A DRAFTED REPLY — the control that names the cost before it spends, and hands the
 * answer to the editor rather than to the wire.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────────────────
 *
 * `POST /messages/:id/draft` has been live for a long time and nothing has ever called it.
 * The "Draft reply" verb navigated to Compose, which is the shape of a feature that was
 * planned and not connected: the route stores a `drafts` row and answers `202 {draftId}`, and
 * the surface had no way to ask for one or to show what came back.
 *
 * Two invariants decide everything about how this is built, and neither is negotiable:
 *
 *  · **Nothing sends.** AI proposes and the user decides; nothing leaves the account without an
 *    explicit act. The drafter produces text. It lands in the reply editor as
 *    editable content and stops there — no `mail_send`, and no triage change. A generated
 *    draft is not a sent reply, so it must not discharge the Reply Run's debt: that discharge
 *    is owned by `onSendSettled`, keyed on a SEND settling, and this module dispatches no
 *    mutation at all. There is deliberately nothing here to get wrong, which is the point.
 *  · **The cost is stated before it is taken** — no paid API call without the revenue for it
 *    behind it, and none without the person knowing the price. One draft is 15 credits — see
 *    {@link DRAFT_REPLY_COST_CREDITS}, and why it is no longer "one action". The
 *    figure is not computed from a balance this client happens to be holding — it is what the
 *    route charges, once per accepted request, and the sentence a person consents to says
 *    exactly that.
 *
 * ── WHY THE PRICE IS A CONSTANT HERE AND A SERVER ROUND TRIP IN THE SCREENER ─────────────
 *
 * `screener-suggest.ts` prices its batch with a dry run and refuses to guess, and the reason
 * is that the batch's SIZE is a question only the server can answer: which of these senders is
 * still held, whose mail is withheld from the model, whose answer has already been bought. A
 * price computed in the browser would be a second implementation of that eligibility rule.
 *
 * There is no such rule here. One press is one message and one draft; there is no set to
 * price and no eligibility to re-derive, so a dry run would be a network round trip that
 * always returns the same number. What the client must NOT do — and does not — is decide
 * whether the action is affordable or permitted. That stays entirely with the server, and its
 * refusal is rendered verbatim.
 *
 * ── THE ANSWER COMES BACK IN TWO STEPS, AND NOT THROUGH THE MIRROR ───────────────────────
 *
 * The 202 carries only `{draftId}`; the draft itself arrives in the client mirror on the next
 * `/sync` drain. Waiting for that would key a person's experience of pressing a button to the
 * sync scheduler's cadence, so the draft is read directly with `GET /drafts/:id` — a `read`
 * route that spends nothing. The row is written inside the request that answered 202, so it is
 * there. The mirror still converges; it is simply not the thing being waited on.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError, api, apiConfigured } from "../api-client";
import type { RichValue } from "./rich-text";

/**
 * `closed` — the verb is idle.
 * `offered` — the cost is on screen and nothing has been spent.
 * `running` — the request is in flight.
 */
export type DraftReplyPhase = "closed" | "offered" | "running";

export interface DraftReplyControl {
  phase: DraftReplyPhase;
  /** The message the offer is about, so a stale offer cannot be confirmed against another. */
  messageId: string | null;
  /** What one press costs, in CREDITS. Stated before {@link confirm} is reachable. */
  cost: number;
  /** One sentence about the current state, already translated, or null. */
  notice: string | null;
  /** Offer to draft a reply to this message. Spends nothing. */
  open: (messageId: string) => void;
  cancel: () => void;
  /** Spend, and hand the result to `onDraft`. */
  confirm: () => void;
}

/** One draft, in the shape the editor holds. */
export type DraftedReply = RichValue;

/**
 * WHAT ONE DRAFT COSTS: 15 CREDITS.
 *
 * This used to be `DRAFT_REPLY_COST_ACTIONS = 1`, and its comment argued that quoting the price
 * in AI ACTIONS rather than credits was the honest choice, because "credits are an internal
 * ledger unit nobody is quoted a plan in". Weighted debits inverted both halves of that: the plan
 * is sold in CREDITS now (1,000 / 2,000 / 4,000 on the card), and an action no longer has one
 * price — `AI_ACTION_WEIGHTS.debit_draft` is 15 against a classification's 1. The unit a person is
 * quoted and the unit the server charges are the same unit again, which is the only thing that
 * makes a client-side literal safe to state at all.
 *
 * A literal and not an import, because the webapp deliberately takes no dependency on
 * `@trafficflow/db` (`connect-gate-order.test.ts` asserts this source never names `PLAN_LIMITS`).
 * The drift that opens is closed the way the mailbox count is:
 * `test/landing-pricing-matches-plan-card.test.ts` reads this literal out of the source and
 * compares it to the server's `AI_ACTION_WEIGHTS.debit_draft`.
 *
 * `DraftingService` still spends exactly once per accepted request; only the size changed.
 */
export const DRAFT_REPLY_COST_CREDITS = 15;

export function useDraftReply(opts: {
  /**
   * Where the answer goes. Called with the drafted reply and the message it answers; the
   * CALLER decides whether it replaces or is appended to whatever is already typed, because
   * only the caller can see the editor.
   */
  onDraft: (draft: DraftedReply, messageId: string) => void;
}): DraftReplyControl {
  const t = useTranslations("draftReply");
  const { onDraft } = opts;

  const [phase, setPhase] = useState<DraftReplyPhase>("closed");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The press counter, and the key of the press in flight.
   *
   * `run` discards an answer that arrives after the user has moved on — the same guard
   * `screener-suggest.ts` keeps for its dry runs. `key` is minted ONCE per press and reused if
   * that press has to be retried at the transport level, which is what makes a lost response
   * replay instead of buying a second draft; a second deliberate press is a different purchase
   * and gets a different key.
   */
  const io = useRef<{ run: number; key: string | null }>({ run: 0, key: null });

  const open = useCallback((id: string) => {
    io.current.run += 1;
    io.current.key = null;
    setMessageId(id);
    setNotice(null);
    setPhase("offered");
  }, []);

  const cancel = useCallback(() => {
    io.current.run += 1;
    io.current.key = null;
    setPhase("closed");
    setNotice(null);
  }, []);

  const confirm = useCallback(() => {
    const id = messageId;
    if (!id || phase === "running") return;
    if (!apiConfigured()) {
      // The demo world has no API. Saying so beats a spinner that never resolves.
      setNotice(t("unavailable"));
      return;
    }
    const run = ++io.current.run;
    io.current.key ??= newKey();
    const key = io.current.key;
    setPhase("running");
    setNotice(t("running"));

    void (async () => {
      /**
       * WHICH STEP FAILED — because the opaque sentence below is a claim about the draft, and only
       * the SECOND step can honestly make it.
       *
       * One `catch` covers both requests. The failure sentence for an unhandled fault says "the
       * draft was written but could not be loaded", which is true when the 202 already came back
       * and the read is what died — and FALSE when the paid POST itself faulted, where no draft
       * exists and nothing was written. Saying it anyway would be the app inventing a row and
       * telling somebody their money bought it.
       */
      let bought = false;
      try {
        const { draftId } = await api<{ draftId: string }>(`/messages/${id}/draft`, {
          method: "POST",
          headers: { "Idempotency-Key": key },
        });
        bought = true;
        // `GET /drafts/:id` rather than the mirror — see the header. `cost: read`, spends
        // nothing, and the row was written inside the request that answered above.
        const draft = await api<{ body?: string; html?: string | null }>(`/drafts/${draftId}`);
        if (io.current.run !== run) return;
        io.current.key = null;
        setPhase("closed");
        setNotice(null);
        onDraft({ text: draft.body ?? "", html: draft.html ?? "" }, id);
      } catch (err) {
        if (io.current.run !== run) return;
        /**
         * BACK TO THE OFFER, AND NO RETRY LOOP.
         *
         * Every refusal on this path already has a true sentence written by the code that made
         * the decision — "no AI actions remain on this account" (402), "cannot AI-draft a
         * sensitive message" (422), "this deployment has no AI drafter connected" (503) — and
         * a second taxonomy here is how somebody with an empty balance is told the model is
         * down. The key is kept: if the user presses again it is the SAME purchase being
         * retried, which is what stops a lost response from being charged twice. Nothing
         * retries on its own, because a 402 retried in a loop is a person being asked to buy
         * something they have already been told they cannot afford.
         */
        setPhase("offered");
        setNotice(messageFor(err, t("failed"), bought ? t("failedOpaque") : t("failedOpaqueEarly")));
      }
    })();
  }, [messageId, phase, onDraft, t]);

  return {
    phase,
    messageId,
    cost: DRAFT_REPLY_COST_CREDITS,
    notice,
    open,
    cancel,
    confirm,
  };
}

/**
 * The SERVER's own sentence — or an honest one when the server did not give one.
 *
 * ── WHY A 500 NEEDS ITS OWN ARM ────────────────────────────────────────────────────────────
 *
 * Every refusal on this path was written to be read: "no AI actions remain on this account" (402),
 * "cannot AI-draft a sensitive message" (422), "this deployment has no AI drafter connected" (503).
 * Passing those through verbatim is right, and it is why this function is a one-liner.
 *
 * An unhandled fault is not one of them. The envelope for a 500 is
 * `{"error":{"code":"internal","message":"internal error"}}`, and quoting that puts the words
 * "internal error" in front of a person as though the app were explaining itself. That is what this
 * surface did while `GET /drafts/:id` answered 500 to an id it could not parse: the button failed,
 * said nothing usable, and re-offered itself — which is a surface that invites pressing again
 * rather than one that explains. The server half of that defect is fixed (a malformed id is now a
 * 400 with a real sentence); this arm is for the next unmodelled fault, because there will be one.
 *
 * ── THE TEST IS THE `code`, NOT THE STATUS, AND I GOT THAT WRONG FIRST ─────────────────────
 *
 * The obvious rule is `status >= 500`. It is wrong, and `draft-reply.test.tsx` said so within a
 * minute: this route's "this deployment has no AI drafter connected" is a **503**, and it is one of
 * the most useful sentences on the path — an operator can act on it and a person understands it.
 * Swallowing it would have replaced a good sentence with a vaguer one and called that an
 * improvement.
 *
 * So the test is the CODE. `errorResponse("internal", …)` is the API's envelope for a throw nobody
 * modelled — the only case where the message is machine noise — and every deliberate refusal on
 * this path carries a code of its own. An empty message is caught too, because a blank notice is
 * the same failure with fewer characters.
 *
 * `status === 0` is the transport's own code for "we never reached ohmail", which already carries a
 * true sentence from `api-client` and is left alone.
 */
export function messageFor(err: unknown, fallback: string, opaque: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return err.code === "internal" || err.message.trim() === "" ? opaque : err.message;
}

/** A fresh idempotency key — see `screener-suggest.ts` for why the fallback exists. */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
