"use client";

/**
 * SENDING MAIL — the client half of the gated send, and the one action in
 * this app that cannot be taken back.
 *
 * Everything else the shell dispatches is a local edit the server later agrees with; a
 * rejection rolls the overlay back and nothing is lost. A send is not that. So this state
 * machine exists for one reason: **a send that has not been delivered must never look like
 * one that has.** Four outcomes, four different things on screen:
 *
 *   `sending`     the request is out. Send is locked — a second press would mint a second
 *                 Idempotency-Key, which is a second draft AND a second reservation, which
 *                 is a real double-send to a real person.
 *   `queued`      the transport failed or the server said `in_flight`. The intent stands
 *                 (the engine kept the overlay and the key), the editor keeps the text, and
 *                 the copy says "not sent yet" — never "sent". Retried on a backoff below.
 *   `unverified`  SMTP threw AND the server's Sent-folder probe found no copy. Genuinely
 *                 ambiguous: it may have gone out. We do NOT retry — the send path never
 *                 resends on its own when the outcome is ambiguous, because that is how a
 *                 person receives the same mail twice — and we do not lock the button either,
 *                 because the server refuses every further send of THAT draft
 *                 (`send-service.ts:162-168`), so a lock would brick the editor forever after
 *                 one hiccup. The warning stays on screen and the next press is a fresh
 *                 send the user deliberately chose.
 *   `failed`      a definite refusal. Text kept, reason shown, Send live again.
 *
 * ── ONE MACHINE, TWO SURFACES ───────────────────────────────────────────────────────────
 *
 * It shipped serving the inline reply only, and Compose was given this machine rather than one
 * of its own. Nothing above is reply-specific: the lock, the retry driver, the
 * four-outcome reading of the wire and "a 200 is inspected, not trusted" are properties of
 * SENDING, and a second copy of them is a second place for "one press is one delivery" to be
 * true in. The
 * difference between the two callers is one field on the mutation (`inReplyTo`) and one line
 * in `settle` (a reply discharges a triage debt; a compose has none).
 *
 * States are keyed by {@link sendKeyOf}: the parent message id for a reply, the constant
 * {@link COMPOSE_SEND_KEY} for the compose surface, of which there is exactly one.
 *
 * ── WHY THERE IS A RETRY DRIVER HERE ────────────────────────────────────────────────────
 *
 * `OhmailEngine.flushPending()` had NO caller anywhere in the app. A retryable rejection
 * queues the mutation with its key preserved and then nothing ever drains it — so `queued`
 * would have been a permanent state wearing a hopeful label. Convergence is safe on the
 * server's side: while the first invocation lives, a same-key request answers `in_flight`;
 * once it finalizes, the same key replays the terminal outcome; past `SEND_STALE_AFTER_MS`
 * the retry itself triggers verify-by-Sent recovery. ONE timer for the whole queue, because
 * `flushPending` drains all of it.
 *
 * ── COMPLETION IS ROUTED THROUGH HERE, NOT THROUGH THE BUTTON ───────────────────────────
 *
 * A confirmation can arrive from the original `mutate()` OR from a flush minutes later, by
 * which time the user may have closed the editor or walked to another view. Both paths land
 * in `settle`, so the scratch draft is cleared and the triage debt discharged either way, and
 * the surface is
 * closed only if it still happens to be the one on screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MutationResult, OhmailEngine } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import { clearComposeDraft, type MailSend } from "./compose";
import { EMPTY_RICH, parseRichValue, serializeRichValue, type RichValue } from "./rich-text";

export type SendPhase = "idle" | "sending" | "queued" | "unverified" | "failed";

export interface SendState {
  phase: SendPhase;
  /** The server's or the transport's own words, for `failed`. */
  reason?: string;
  /**
   * The server's stable machine name for the refusal, when it sent one.
   *
   * `reason` is server English and is rendered as a quotation — correct for the long tail of
   * SMTP refusals nobody can enumerate, and wrong for a refusal the product has its own words
   * for. `mailbox_disabled` is the one that matters today: `SendService.reserve` throws it at
   * 409 for a mailbox that cannot send, and the surface that shows it now also holds the control
   * that fixes it, so the copy can point at that instead of quoting a sentence written for an
   * API consumer. See `SendStatus`.
   */
  code?: string;
}

export interface MailSendApi {
  stateOf: (key: string) => SendState;
  /** Press Send. A no-op while that surface's send is already in flight or queued. */
  send: (m: MailSend) => void;
}

const IDLE: SendState = { phase: "idle" };

/** There is one compose surface, so its send state needs one key. */
export const COMPOSE_SEND_KEY = "compose";

/**
 * Which send state a mutation belongs to — derived, never passed.
 *
 * `send(m)` takes only the mutation, so there is no way for a caller to hand in a key that
 * disagrees with what it is sending: a reply's outcome always lands on the message it answers,
 * and a compose's always lands on the compose surface.
 */
export function sendKeyOf(m: MailSend): string {
  return m.inReplyTo ?? COMPOSE_SEND_KEY;
}

/* ── the per-message reply scratch buffer ─────────────────────────────────────────────── */

/**
 * `localStorage` key for a per-message reply draft.
 *
 * It lives beside the send machine rather than in `InlineReply` because clearing it is part of
 * what "the send landed" MEANS, and that happens in `settle` below — possibly minutes after
 * the editor closed. Keeping the key and the cleanup in one file is also what stops the two
 * from being imported in a cycle.
 */
export const replyDraftKey = (messageId: string): string => `ohmail.ui.reply:${messageId}`;

/**
 * The buffer HOLDS TWO HALVES NOW, and the key it holds them in did not change.
 *
 * Every reply written before the rich editor shipped is a BARE STRING under this key, and the
 * whole point of the buffer is that nobody's half-written sentence is thrown away by a deploy.
 * `parseRichValue` is the shape-based read that makes both readable from one key — see
 * `rich-text.ts` for why it is shape-based and not "did it parse as JSON".
 */
export function readReplyDraft(messageId: string): RichValue {
  try {
    return parseRichValue(window.localStorage.getItem(replyDraftKey(messageId)));
  } catch {
    return EMPTY_RICH; // storage blocked — the editor still works for this session
  }
}

/**
 * `serializeRichValue` answers `null` for a value with nothing in it, and null REMOVES the key
 * — the buffer's rule has always been that an empty draft stores nothing. It also answers a
 * bare string for a reply with no formatting, so the common case stays readable by a bundle
 * that predates the envelope.
 */
export function writeReplyDraft(messageId: string, value: RichValue): void {
  try {
    const raw = serializeRichValue(value);
    if (raw === null) window.localStorage.removeItem(replyDraftKey(messageId));
    else window.localStorage.setItem(replyDraftKey(messageId), raw);
  } catch {
    /* private mode refuses writes; the draft lives in React state only */
  }
}

/* ── the one rule ─────────────────────────────────────────────────────────────────────── */

/**
 * MAY THIS BE SENT RIGHT NOW? — ONE predicate, every consumer.
 *
 * The button's `disabled` and the state machine's own refusal used to be two copies of the
 * same rule, and a mutation test proved what that costs: deleting the guard inside
 * `useMailSend.send` left every assertion green, because they all went through the button.
 * A rule with two implementations has one that nothing watches.
 *
 * It judges the MUTATION and not the form, which is what lets the compose surface express
 * "one of these addresses is a typo" as `to: []` (see `composePlan`) instead of as a second
 * predicate that only the button would consult.
 *
 *   · `sending`/`queued` are locked because a second press mints a second Idempotency-Key,
 *     which is a second reservation, which is a second delivery to a real person.
 *   · an empty body is locked because the server accepts a blank one
 *     (`drafts-service.ts:167-171`) and would post it.
 *   · `unverified` and `failed` are NOT locked: both are terminal on the server for that
 *     draft, so the only way forward is a fresh send the user deliberately chooses.
 *   · a COMPOSE additionally needs a recipient and a mailbox to send from. Both are refused
 *     here rather than on the wire, where `POST /drafts` would already have written a row
 *     before `POST /drafts/:id/send` answered 400.
 *
 * A reply needs neither check: `Engine.enrich` derives both from the parent, and a parent the
 * mirror does not know produces no effects and is rejected by the engine with nothing sent.
 */
export function canSend(state: SendState, m: MailSend): boolean {
  if (state.phase === "sending" || state.phase === "queued") return false;
  if (m.body.trim().length === 0) return false;
  if (m.inReplyTo === null) {
    if (!m.mailboxId) return false;
    if (!m.to || m.to.length === 0) return false;
  }
  return true;
}

/**
 * `MutationResult` → what the editor shows. A pure function because it is the whole
 * correctness of the slice compressed into six lines — "queued must not read as sent",
 * "ambiguous is its own thing" — and a hook is a poor place to keep something that wants
 * asserting one row at a time.
 */
export function phaseFor(res: MutationResult): SendState {
  if (res.status === "confirmed") return IDLE;
  if (res.status === "queued") return { phase: "queued" };
  if (res.error?.code === "send_unverified") return { phase: "unverified" };
  return {
    phase: "failed",
    ...(res.error?.message ? { reason: res.error.message } : {}),
    ...(res.error?.code ? { code: res.error.code } : {}),
  };
}

/**
 * Which triage states a delivered reply discharges.
 *
 * `reply_later` (Answer Later) and `bubbled_up` (a Resurface that came due) are both "come
 * back to this", and replying IS coming back to it. `set_aside` (Parked) and `muted` are
 * statements about the message rather than an owed answer, and a reply is not an obvious
 * argument to undo either.
 */
export function clearsTriage(state: string | undefined): boolean {
  return state === "reply_later" || state === "bubbled_up";
}

/**
 * Retry schedule for a queued send, in ms. Capped and finite-stepped rather than
 * exponential-forever: past ten minutes the server's own verify-by-Sent recovery is what
 * resolves the row, and a client hammering it faster than that buys nothing.
 */
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export function useMailSend(
  engine: OhmailEngine,
  toast: ToastFn,
  /** Close the surface if it is still the one open — see `AppShell.onSendSettled`. */
  onSettled: (key: string) => void,
): MailSendApi {
  const t = useTranslations();
  const [states, setStates] = useState<Record<string, SendState>>({});
  /** `Idempotency-Key → send key` for everything currently queued, so a flush can settle it. */
  const queued = useRef(new Map<string, string>());
  /** `Idempotency-Key → the frozen mutation`, so a late confirmation knows what it delivered. */
  const inFlight = useRef(new Map<string, MailSend>());
  /**
   * THE LOCK — a ref, and it has to be, which a test proved rather than a comment claimed.
   *
   * `send` first gated on `states[key]`, i.e. React state captured at RENDER. Two calls
   * inside one tick therefore both read `idle`, both dispatched, and each minted its own
   * Idempotency-Key: two reservations, two deliveries, to a real person. The button's
   * `disabled` does not save you — it only exists after the re-render the second call beat,
   * and a double-tap or any programmatic caller gets there first.
   *
   * Holds every send key that is `sending` OR `queued` — the two phases where an intent
   * is already out under a key. Cleared on any terminal outcome, from whichever path
   * delivered it.
   */
  const locked = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const setPhase = useCallback((key: string, next: SendState) => {
    setStates((prev) => {
      if (next.phase === "idle") {
        if (!(key in prev)) return prev;
        const { [key]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: next };
    });
  }, []);

  /**
   * A send that DID land. The scratch draft goes, the triage debt goes, and the surface
   * closes if it is still the one on screen.
   */
  const settle = useCallback(
    (key: string, m: MailSend) => {
      if (m.inReplyTo === null) {
        clearComposeDraft();
      } else {
        try {
          window.localStorage.removeItem(replyDraftKey(m.inReplyTo));
        } catch {
          /* private mode refuses writes and therefore holds nothing to remove */
        }

        // ── the reply IS the evidence the message was answered ─────────────────────────
        //
        // Read at CONFIRM time, not at press time: the state may have moved while the request
        // was out, and a send that failed must never clear a debt. A compose answers nothing,
        // so it discharges nothing — the branch is the whole difference between the two.
        const msg = engine.read().get<EngineMessage>("message", m.inReplyTo);
        if (clearsTriage(msg?.triage?.state)) {
          void engine.mutate({ kind: "triage_set", messageId: m.inReplyTo, state: "none" });
        }
      }

      setPhase(key, IDLE);
      settledRef.current(key);
      toast(m.inReplyTo === null ? t("compose.toastSent") : t("reply.toastSent"));
    },
    [engine, setPhase, toast, t],
  );

  const absorb = useCallback(
    (key: string, m: MailSend, res: MutationResult) => {
      const next = phaseFor(res);
      if (res.status === "queued") {
        queued.current.set(res.key, key);
        inFlight.current.set(res.key, m);
        // STILL LOCKED: the intent is out there under this key and a second press would
        // mint another one.
        locked.current.add(key);
      } else {
        queued.current.delete(res.key);
        inFlight.current.delete(res.key);
        locked.current.delete(key);
      }
      // A confirmation is the only outcome that does anything beyond the phase, and `settle`
      // is where all of it lives — so a confirmation from a flush minutes later clears the
      // draft and discharges the debt exactly as the first press would have.
      if (res.status === "confirmed") settle(key, m);
      else setPhase(key, next);
    },
    [settle, setPhase],
  );

  const flush = useCallback(async (): Promise<void> => {
    timer.current = null;
    if (queued.current.size === 0) return;
    const results = await engine.flushPending();
    let stillQueued = false;
    for (const res of results) {
      const key = queued.current.get(res.key);
      const m = inFlight.current.get(res.key);
      // A queued mutation that is not one of ours (a move that failed offline, say) is
      // drained by the same call and is none of this state machine's business.
      if (!key || !m) continue;
      absorb(key, m, res);
      if (res.status === "queued") stillQueued = true;
    }
    if (stillQueued) {
      const wait = BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)]!;
      attempt.current += 1;
      timer.current = setTimeout(() => void flush(), wait);
    } else {
      attempt.current = 0;
    }
  }, [engine, absorb]);

  const arm = useCallback(() => {
    if (timer.current !== null) return; // one timer for the whole queue
    const wait = BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)]!;
    attempt.current += 1;
    timer.current = setTimeout(() => void flush(), wait);
  }, [flush]);

  // Coming back online is better news than any timer, so take it immediately.
  useEffect(() => {
    const onOnline = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      attempt.current = 0;
      void flush();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [flush]);

  const send = useCallback(
    (m: MailSend) => {
      const key = sendKeyOf(m);
      // THE LOCK FIRST, off the ref, because it is the only check that is correct within one
      // tick. `canSend` then applies the SAME rule the button's `disabled` uses, so a caller
      // that is not the button (a keyboard shortcut, a future Reply Run step) cannot get past
      // something the button enforces.
      if (locked.current.has(key)) return;
      if (!canSend(states[key] ?? IDLE, m)) return;

      locked.current.add(key);
      setPhase(key, { phase: "sending" });
      void engine
        .mutate(m)
        .then((res) => {
          absorb(key, m, res);
          if (res.status === "queued") arm();
        })
        .catch((err: unknown) => {
          // `mutate` resolves rather than throws for every outcome it models; anything that
          // gets here is a bug in the engine, and swallowing it would leave the editor stuck
          // on "Sending…" with no way out.
          locked.current.delete(key);
          setPhase(key, { phase: "failed", reason: String(err) });
        });
    },
    [engine, states, setPhase, absorb, arm],
  );

  return useMemo(
    () => ({ stateOf: (key: string) => states[key] ?? IDLE, send }),
    [states, send],
  );
}
