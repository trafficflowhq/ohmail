"use client";

/**
 * Buying a drafted reply — the control that names the cost before it spends, and hands the answer to the editor
 * rather than the wire. Two non-negotiable invariants: NOTHING SENDS — AI proposes and the user decides; the text
 * lands in the reply editor and stops there — no `mail_send`, no triage change, and no discharge of the Reply Run's
 * debt (that is `onSendSettled`'s, keyed on a SEND settling). And THE COST IS STATED BEFORE IT IS TAKEN — one draft
 * is 15 credits ({@link DRAFT_REPLY_COST_CREDITS}), the figure the route charges, not one computed from a balance.
 */

/**
 * The price is a constant here and a dry run in the Screener: the batch's size is a question only the server can
 * answer, while one press here is one message — but the client never decides affordability; the server's refusal
 * renders verbatim. The 202 carries only `{draftId}`; the draft is read directly with `GET /drafts/:id` (a `read`
 * route that spends nothing) rather than waiting on the sync cadence — the mirror still converges, it is just not
 * what is waited on.
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
 * What one draft costs: 15 credits. It used to be `DRAFT_REPLY_COST_ACTIONS = 1`, arguing that
 * actions were the honest unit; weighted debits inverted both halves — the plan is sold in CREDITS
 * (1,000 / 2,000 / 4,000 on the card) and an action no longer has one price
 * (`AI_ACTION_WEIGHTS.debit_draft` is 15 against a classification's 1). The quoted unit and the
 * charged unit are the same again, the only thing that makes a client literal safe. A literal, not
 * an import: the webapp takes no dependency on `@trafficflow/db` (`connect-gate-order.test.ts`
 * asserts it), and `test/landing-pricing-matches-plan-card.test.ts` reads this literal out of the
 * source and compares it to the server's weight. `DraftingService` still spends once per request.
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
         * BACK TO THE OFFER, AND NO RETRY LOOP. Every refusal on this path already has a true sentence written by the
         * code that made the decision — "no AI actions remain on this account" (402), "cannot AI-draft a sensitive
         * message" (422), "this deployment has no AI drafter connected" (503) — and a second taxonomy here is how
         * somebody with an empty balance is told the model is down. The key is kept: if the user presses again it is
         * the SAME purchase being retried, which is what stops a lost response from being charged twice. Nothing
         * retries on its own, because a 402 retried in a loop is a person being asked to buy something they have
         * already been told they cannot afford.
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
 * The server's own sentence — or an honest one when the server did not give one. Every refusal on this path was
 * written to be read: "no AI actions remain on this account" (402), "cannot AI-draft a sensitive message" (422),
 * "this deployment has no AI drafter connected" (503) — passed through verbatim. An unhandled fault is not one of
 * them: a 500's envelope is `{"error":{"code":"internal","message":"internal error"}}`, and quoting it puts "internal
 * error" in front of a person as though the app were explaining itself — which this surface did while `GET
 * /drafts/:id` answered 500 to an id it could not parse: the button failed, said nothing usable, and re-offered
 * itself. The server half is fixed (a malformed id is now a 400 with a real sentence); this arm is for the next
 * unmodelled fault.
 */

/**
 * The test is the `code`, not the status. The obvious rule — `status >= 500` — is wrong, and
 * `draft-reply.test.tsx` said so within a minute: "this deployment has no AI drafter connected"
 * is a 503 and one of the most useful sentences on the path. `errorResponse("internal", …)` is
 * the API's envelope for a throw nobody modelled — the only case where the message is machine
 * noise — and every deliberate refusal carries a code of its own. An empty message is caught
 * too: a blank notice is the same failure with fewer characters. `status === 0` is the
 * transport's own "we never reached ohmail", already a true sentence from `api-client`, and is
 * left alone.
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
