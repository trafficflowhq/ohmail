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
 *
 * ── THE LOCK IS DURABLE; THE REF IS ADVISORY ────────────────────────────────────────────
 *
 * Everything above was true within one session and false across a reload: `locked` is a `useRef`,
 * and a lock whose lifetime is a component's cannot prevent the double it exists to prevent. The Idempotency-Key is now persisted with the
 * send LANE at the moment it is minted (`shell/send-lock.ts`), synchronously and ahead of the
 * verb, and a press on a lane that already holds a key RESUMES it rather than minting a second
 * one. `locked` stays because it is the only check that is correct inside one tick; the durable
 * key is the one that is correct across a process, and it is the authoritative half.
 *
 * ── THE RESIDUAL, STATED RATHER THAN LEFT TO BE FOUND ───────────────────────────────────
 *
 * There is deliberately no adoption pass at mount, and the reason is that every version of one
 * introduced a worse failure than the one it removed. A restored outbox entry for a `mail_send` is
 * replayed by the ENGINE's drive (`replayOutbox` takes every `restored` entry, owner-settled or
 * not) and its result is routed to no surface, because the surface that owned it died. So a mount
 * that adopted the lane as `queued` would lock a button whose settlement can never arrive through
 * `flushPending` — a wedged Send on a mail client, which is worse than a stale composer.
 *
 * What is left is therefore this: after a reload that the boot replay has already settled, the
 * composer still shows the message until the reader presses Send once more, and that press returns
 * the server's stored outcome for the original send. **Nothing is delivered twice and nothing
 * claims to be sent that was not** — the invariant holds — but the scratch draft is not bound to
 * the send's durable record, so it outlives it. Closing that means binding the scratch buffer to
 * the lane's durable claim and clearing it on the draft row's own `sent` transition (which `/sync`
 * already emits); it is ledgered rather than smuggled in here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MutationResult, OhmailEngine } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import { clearComposeDraft, type MailSend } from "./compose";
import { claimSendLock, readSendLock, releaseSendLock, sendFingerprint } from "./send-lock";
import { storageOwner } from "./storage-owner";
import { scheduleLabel } from "./format";
import { EMPTY_RICH, parseRichValue, serializeRichValue, type RichValue } from "./rich-text";
import type { SignatureState } from "./signature";

export type SendPhase = "idle" | "sending" | "sent" | "queued" | "unverified" | "failed";

/**
 * How long the delivered state is held on screen before the surface closes — the beat.
 *
 * The composer used to close on the confirmation itself, which meant the only thing the reader
 * ever saw of a successful send was the surface disappearing. That reads as "something happened"
 * and not as "this was sent", and on a send that took four seconds it reads as neither. Six
 * hundred milliseconds is long enough for the button's own `sent` state to be seen and short
 * enough that nobody waits for it.
 *
 * It is NOT a delay on the delivery, on the toast, or on the triage discharge: all of those run
 * at the confirmation, exactly as before. Only the closing is on the beat.
 */
export const SENT_BEAT_MS = 600;

/**
 * When a send that is still going stops saying "Sending" and starts saying "Still sending".
 *
 * Chosen against what a send actually costs. The slowest part of one is the cold connection the
 * send path opens for every press, and how long that takes depends on the mail provider — fast
 * enough to be invisible on some, several seconds on others. Four seconds is past every ordinary
 * send and short of the point where a person decides the button is broken, which is the state
 * this line answers.
 */
export const SENDING_LONG_MS = 4_000;

export interface SendState {
  phase: SendPhase;
  /** The server's or the transport's own words, for `failed`. */
  reason?: string;
  /**
   * WHICH `queued` THIS IS, and the difference is the difference between two sentences.
   *
   * `true` — THE SERVER ACCEPTED IT. The reservation is committed under this key and the
   * submission is still being handed to the mail server (the send route's own `queued`, past its
   * attempt ceiling). So "Accepted. ohmail sends it on its next pass." is a true statement, and
   * the surface may close on it: the draft row carries the outcome from here.
   *
   * ABSENT — the request may never have arrived. A transport rejection, a replay hold, an
   * offline press: the intent is in the durable outbox and the retry driver is trying. The only
   * honest line is "Not sent yet", and the surface stays open.
   *
   * Saying "Accepted" about a request nobody received is the exact class of false claim the
   * four-phase machine exists to prevent, which is why this is a field and not an inference from
   * the phase.
   */
  accepted?: true;
  /** A `sent` that settled a SEND-LATER — the button says "Scheduled", not "Sent". */
  scheduled?: true;
  /**
   * When the current phase began, in `Date.now()` ms — for `sending` only, and read by
   * `SendStatus` to swap its line at {@link SENDING_LONG_MS}.
   *
   * On the STATE rather than in a timer inside the status line, because the phase can be entered
   * and left by four different paths (the press, a flush minutes later, a rejection, the beat)
   * and a component-local timer would have to be re-armed correctly by each of them. A timestamp
   * is re-derived correctly by construction.
   */
  since?: number;
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
  /**
   * Press Send. A no-op while that surface's send is already in flight or queued.
   * `surface: "inline"` names the thread's dock as the sender — see {@link sendKeyOf} for why
   * a forward needs the surface said and a reply never does.
   */
  send: (m: MailSend, opts?: { surface?: "inline" }) => void;
}

const IDLE: SendState = { phase: "idle" };

/** There is one compose surface, so its send state needs one key. */
export const COMPOSE_SEND_KEY = "compose";

/**
 * THE INLINE FORWARD'S LANE — namespaced so it can never collide with a reply lane (a bare
 * message id) or the compose surface's one key. The same string is the forward's scratch-buffer
 * suffix (`AppShell.openForward` reads the note back through `readReplyDraft(inlineForwardKey(id))`),
 * which is what lets `settle` clear it by the lane alone.
 */
export const inlineForwardKey = (messageId: string): string => `fwd:${messageId}`;

/**
 * Which send state a mutation belongs to — derived, never passed as a key.
 *
 * `send(m)` takes only the mutation plus, at most, WHICH SURFACE is sending: a reply's outcome
 * always lands on the message it answers, and a compose's on the compose surface. The surface
 * argument exists because a FORWARD is one mutation shape sent from two surfaces — the compose
 * form (`ComposeFields.forwardOf`) and the thread's inline dock — and the mutation alone cannot
 * say which editor's button should show "Sending…" and which scratch a confirmation should
 * clear. A surface is a fact the caller alone holds and cannot usefully lie about; the KEY is
 * still derived here, in one place.
 */
export function sendKeyOf(m: MailSend, surface: "compose" | "inline" = "compose"): string {
  if (m.inReplyTo !== null) return m.inReplyTo;
  if (surface === "inline" && m.forwardOf != null) return inlineForwardKey(m.forwardOf);
  return COMPOSE_SEND_KEY;
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
/** Every reply scratch key starts here. Exported so sign-out can sweep them — these hold MAIL
 * TEXT and, unlike the compose buffer, they are not owner-keyed at all. */
export const REPLY_DRAFT_PREFIX = "ohmail.ui.reply:";

export const replyDraftKey = (messageId: string): string => `${REPLY_DRAFT_PREFIX}${messageId}`;

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

/**
 * THE PER-MESSAGE EDITOR META — the subject as edited and the signature block's state, beside
 * the body scratch and on its lifecycle (closing the editor kept the body and
 * silently dropped these two, so a struck signature came back and a retitled reply lost its
 * title on reopen).
 *
 * Its own key rather than a field inside the body scratch, because the body's value is
 * shape-based (`parseRichValue`: a bare string or the rich envelope) and growing it a third
 * shape would complicate every reader for two small fields. The LANE is the key, exactly as
 * the body scratch's is: a reply's meta lives under the message id, an inline forward's under
 * `fwd:<id>`, and the compose form's under `draft:<rowId>` — the AUTOSAVED ROW's id, because
 * that is the one handle that survives a reload and names the same message on this device
 * (a content key broke on rich drafts, whose local text and server-derived
 * text legitimately differ). Cleared where the body scratch clears: in `settle`, because "the
 * send landed" means the whole per-message state is spent — and by the draft verbs that end a
 * row's life (`discardDraft`, the compose cancel).
 *
 * `subject` is absent while the derived `Re:` one stands; `sig` is absent while `following`
 * stands — absence IS the resting state, and a meta with neither field stores nothing.
 */
export interface ReplyEditorMeta {
  subject?: string;
  sig?: SignatureState;
}

/** Likewise for the reply editor's metadata half. */
export const REPLY_META_PREFIX = "ohmail.ui.replymeta:";

export const replyMetaKey = (lane: string): string => `${REPLY_META_PREFIX}${lane}`;

export function readReplyMeta(lane: string): ReplyEditorMeta {
  try {
    const raw = window.localStorage.getItem(replyMetaKey(lane));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ReplyEditorMeta>;
    // Field-wise, like every scratch reader: only the shapes the model names restore.
    const sig = parsed.sig;
    return {
      ...(typeof parsed.subject === "string" ? { subject: parsed.subject } : {}),
      ...(sig?.kind === "removed" ? { sig: { kind: "removed" as const } }
        : sig?.kind === "edited" && typeof sig.text === "string"
          ? { sig: { kind: "edited" as const, text: sig.text } }
          : {}),
    };
  } catch {
    return {}; // storage blocked — the editor still works for this session
  }
}

export function writeReplyMeta(lane: string, meta: ReplyEditorMeta): void {
  try {
    if (meta.subject === undefined && meta.sig === undefined) {
      window.localStorage.removeItem(replyMetaKey(lane));
      return;
    }
    window.localStorage.setItem(replyMetaKey(lane), JSON.stringify(meta));
  } catch {
    /* private mode refuses writes; the meta lives in React state only */
  }
}

/**
 * DROP THE PER-LANE SCRATCH a settled send is done with — the body buffer and the editor meta.
 *
 * Module-level and shared, because two different endings now spend it: a delivery (`settle`) and
 * the server's accepted-pending hand-off, which closes the surface without discharging anything
 * else. A second copy of "which keys is this lane holding" is a second place for a lane to leak a
 * draft that outlives the message it was.
 *
 * Every write is guarded: private mode refuses `localStorage` outright, and a lane that could not
 * store anything has nothing to remove.
 */
export function clearLaneScratch(key: string, m: MailSend, owner: string | null): void {
  if (m.inReplyTo === null) {
    if (key === COMPOSE_SEND_KEY) {
      clearComposeDraft(owner);
      // The delivered message's row is spent, and so is the block state keyed to it.
      if (m.draftId) {
        try {
          window.localStorage.removeItem(replyMetaKey(`draft:${m.draftId}`));
        } catch {
          /* private mode refuses writes and therefore holds nothing to remove */
        }
      }
      return;
    }
    // The INLINE forward — the lane doubles as the scratch suffix, so the note clears here
    // exactly as a reply's draft does below. The compose form's autosave is deliberately
    // untouched: this send never used the form, and a half-written compose must survive
    // somebody forwarding a message mid-sentence.
    try {
      window.localStorage.removeItem(replyDraftKey(key));
      window.localStorage.removeItem(replyMetaKey(key));
    } catch {
      /* private mode refuses writes and therefore holds nothing to remove */
    }
    return;
  }
  try {
    window.localStorage.removeItem(replyDraftKey(m.inReplyTo));
    window.localStorage.removeItem(replyMetaKey(m.inReplyTo));
  } catch {
    /* private mode refuses writes and therefore holds nothing to remove */
  }
}

/**
 * WHAT THE SEND BUTTON SAYS, and what the button wears while it says it — one derivation, both
 * surfaces.
 *
 * The compose form and the thread's inline dock render the same verb in the same six states, and
 * a second copy of "which word goes with which phase" is a second place for the button to claim a
 * delivery that did not happen. That is not hypothetical for one pair in particular: `sent` and
 * `queued` differ by whether the mail is gone, and they are one `?:` apart.
 *
 * `attr` is the value for `data-send`, which is what `packages/ui` paints the state from. Only the
 * three phases the stylesheet names are ever written — a state it has no rule for would be an
 * attribute that changes nothing, which reads in the DOM as a claim the CSS is not making. The
 * not-sent phases deliberately carry none: the button is back at rest and Send is the retry.
 *
 * `scheduled` is COMPOSE-ONLY because a send-later appointment is: the reply scope has no such
 * key, and asking for one would render the key's own name at a reader. The fallback is `sent`,
 * which for a reply is always the true word.
 */
export function sendVerb(
  state: SendState, scope: "compose" | "reply",
): { key: "send" | "sending" | "sent" | "scheduled" | "queued"; attr?: "sending" | "sent" | "queued" } {
  if (state.phase === "sending") return { key: "sending", attr: "sending" };
  if (state.phase === "sent") {
    return state.scheduled === true && scope === "compose"
      ? { key: "scheduled", attr: "sent" }
      : { key: "sent", attr: "sent" };
  }
  if (state.phase === "queued") return { key: "queued", attr: "queued" };
  return { key: "send" };
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
 *     (`drafts-service.ts:167-171`) and would post it — EXCEPT ON A FORWARD, see below.
 *   · `unverified` and `failed` are NOT locked: both are terminal on the server for that
 *     draft, so the only way forward is a fresh send the user deliberately chooses.
 *   · a COMPOSE additionally needs a recipient and a mailbox to send from. Both are refused
 *     here rather than on the wire, where `POST /drafts` would already have written a row
 *     before `POST /drafts/:id/send` answered 400.
 *
 * A reply needs neither check when its envelope is DERIVED: `Engine.enrich` fills both from
 * the parent, and a parent the mirror does not know produces no effects and is rejected by
 * the engine with nothing sent. A reply whose recipients were EDITED carries them — and then
 * an empty or unparseable set is `to: []` (`replyEnvelopePlan`, the same emptying rule as
 * `composePlan`) and is refused here, at the one predicate every caller consults. Present-
 * but-empty and absent are different statements on purpose: absent means "enrich decides",
 * empty means "the user removed or mistyped every recipient", and only the second may block.
 *
 * ── A FORWARD IS EXEMPT FROM THE EMPTY-BODY REFUSAL, AND ONLY FROM THAT ONE ────────────────
 *
 * Reported from real use: *"forwarding a mail enforces a message, a fwd mail must also be able to
 * be sent without a message."* The refusal above was written for the two shapes where `body` is
 * the whole message — a reply and a compose — and on a forward it is not: the FORWARDED MESSAGE
 * is the content (the server quotes it and streams its attachments from `forwardOf`, which is why
 * the client sends only an id), and the note above it is the optional part. "Pass this along, no
 * comment" is the ordinary case, and it was the one case the lock made unreachable.
 *
 * The discriminator is `forwardOf` itself — a NON-EMPTY string, so the `forwardOf: null` the wire
 * type admits (`types.ts`: the field is `string | null`, exclusive with `inReplyTo`) still means
 * "not a forward" and keeps the refusal. Reading the field rather than taking a flag is what keeps
 * this one predicate: the mutation already carries the fact, and a caller-supplied "this is a
 * forward" boolean would be a second place for the lock and the wire to disagree.
 *
 * Nothing else is relaxed. An empty forward with no recipient, or with no sending mailbox, or on a
 * send already in flight is refused by the three checks below exactly as a written one is —
 * `forward-send.test.ts` walks all three.
 */
export function canSend(state: SendState, m: MailSend): boolean {
  // `sent` joins the two locked phases: it is the beat between the confirmation and the surface
  // closing, and a press landing inside it would mint a second key for a message already gone.
  if (state.phase === "sending" || state.phase === "queued" || state.phase === "sent") return false;
  const isForward = typeof m.forwardOf === "string" && m.forwardOf.length > 0;
  if (!isForward && m.body.trim().length === 0) return false;
  if (m.inReplyTo === null) {
    if (!m.mailboxId) return false;
    if (!m.to || m.to.length === 0) return false;
  } else if (m.to !== undefined && m.to.length === 0) {
    return false;
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
  // `send_queued` is the SERVER's own accepted-pending answer (HTTP 202 from the send route past
  // its attempt ceiling): the reservation is committed under this key. Every other queued result
  // is the transport's — the request may never have arrived. See `SendState.accepted`.
  if (res.status === "queued") {
    return res.error?.code === "send_queued" ? { phase: "queued", accepted: true } : { phase: "queued" };
  }
  if (res.error?.code === "send_unverified") return { phase: "unverified" };
  return {
    phase: "failed",
    ...(res.error?.message ? { reason: res.error.message } : {}),
    ...(res.error?.code ? { code: res.error.code } : {}),
  };
}

/**
 * Which triage states a delivered reply discharges WITH `triage_set: none`.
 *
 * `reply_later` (Answer Later) and `bubbled_up` (a Resurface that came due) are both "come
 * back to this", and replying IS coming back to it. `set_aside` (Parked) and `muted` are
 * statements about the message rather than an owed answer, and a reply is not an obvious
 * argument to undo either.
 *
 * `resurfaced` — the PIN — is deliberately NOT here, and it is not un-discharged: the settle
 * answers it with a deliberate `mark_seen` instead (see the branch in `settle`), because the
 * pin's own release mechanism is "reading spends the resurface" and a bare state-clear would
 * put the answered row back in "New for you" unread.
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

/**
 * LET THE ACKNOWLEDGEMENT REACH THE SCREEN BEFORE THE WORK STARTS.
 *
 * `setPhase(key, {phase:"sending"})` is a React state update inside a click handler, so React
 * commits it when the handler RETURNS. `engine.mutate` was called before that — and its prologue
 * is not free: it enriches the mutation, writes the durable outbox entry, and on a send with files
 * base64s the attachment bytes. All of that ran in the same task the commit was waiting to finish,
 * so on the sends that are slowest to start the button was still saying "Send" while the work was
 * already under way. That is the "nothing seems to be happening" of the report, and it happens
 * before a single byte reaches the network.
 *
 * A TASK BOUNDARY, not a frame. `setTimeout(…, 0)` puts the mutation's prologue in a LATER task
 * than the one the handler and React's commit share, which is the whole ordering guarantee this
 * needs — the paint follows the commit on the browser's own schedule, and nothing here has to
 * know when. `requestAnimationFrame` was tried and is deliberately not used: it would make the
 * press depend on a frame clock, which a hidden tab throttles to nothing and a non-visual host
 * does not have at all, so the one gesture in the app that must never stall would be waiting on
 * the least reliable timer in the platform.
 *
 * A MICROTASK would not do: microtasks drain before the task ends, so the prologue would still be
 * in front of the commit. Anything that awaits a press therefore has to cross a task boundary —
 * which is why the suites' drain helpers flush timers rather than only `Promise.resolve()`.
 */
function afterPaint(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

export function useMailSend(
  engine: OhmailEngine,
  toast: ToastFn,
  /**
   * Close the surface if it is still the one open — see `AppShell.onSendSettled`. The settled
   * MUTATION rides along because the shell's draft bookkeeping needs its `draftId`: a compose
   * send that carried no row id made its own row, and the row autosave adopted in the meantime
   * is then a phantom copy of a delivered message (`compose-autosave.ts` → `settled`).
   */
  onSettled: (key: string, m: MailSend) => void,
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
   * The pending BEATS, by lane — the timers that close a surface {@link SENT_BEAT_MS} after its
   * terminal state was shown.
   *
   * Held so they can be cleared on unmount (a timer that fires into a dead tree would run
   * `onSettled` for a surface that is already gone) and re-armed rather than stacked when one
   * lane reaches two beat-worthy states in a row, which a flush can produce.
   */
  const beats = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const beat = useCallback((key: string, then: () => void) => {
    const held = beats.current.get(key);
    if (held !== undefined) clearTimeout(held);
    beats.current.set(key, setTimeout(() => {
      beats.current.delete(key);
      then();
    }, SENT_BEAT_MS));
  }, []);

  useEffect(() => {
    const held = beats.current;
    return () => {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    };
  }, []);

  /**
   * A send that DID land. The scratch draft goes, the triage debt goes, and the surface
   * closes if it is still the one on screen.
   */
  const settle = useCallback(
    (key: string, m: MailSend) => {
      clearLaneScratch(key, m, owner.current);
      if (m.inReplyTo !== null) {
        // ── the reply IS the evidence the message was answered ─────────────────────────
        //
        // Read at CONFIRM time, not at press time: the state may have moved while the request
        // was out, and a send that failed must never clear a debt. A compose answers nothing,
        // so it discharges nothing — the branch is the whole difference between the two.
        const msg = engine.read().get<EngineMessage>("message", m.inReplyTo);
        const state = msg?.triage?.state as string | undefined;
        if (clearsTriage(state)) {
          void engine.mutate({ kind: "triage_set", messageId: m.inReplyTo, state: "none" });
        } else if (state === "resurfaced") {
          /**
           * A REPLY TO A PINNED ROW IS THE ANSWER THE PIN WAS WAITING FOR — so it clears the
           * resurface, automatically, through the ONE mechanism that already exists: a
           * deliberate `mark_seen` (no `via`) spends the pin in the same transaction on both
           * sides of the wire (`spendResurface` server-side, `spentResurface` in the overlay)
           * and stamps `lastReadAt`, filing the row at the top of "Earlier" — exactly what the
           * explicit "Done" verb (`resurface_done`) performs. `mark_seen`'s own doc has named
           * "the settled reply that marks its parent read" a deliberate caller all along; this
           * makes that sentence true for the pinned case, which nothing dispatched for:
           * `OhboxView`'s replyDone effect acts only on rows in the NEW session order, and a
           * pinned row is never there — so answering a resurfaced message left its pin
           * standing, saying "deal with this" about mail the reader had just dealt with.
           *
           * Not `triage_set: none` like the branch above: that clears the STATE but leaves the
           * row unread (the pin forces unread), so the answered message would come back bold in
           * "New for you" — a claim of new attention the reader just spent. Answered = read.
           */
          void engine.mutate({ kind: "mark_seen", messageIds: [m.inReplyTo], unread: false });
        }
      }

      /**
       * THE DELIVERED STATE IS SHOWN, and only then does the surface close — see
       * {@link SENT_BEAT_MS}. Everything above this line ran at the confirmation and is
       * unaffected: the scratch is cleared, the triage debt is discharged, the toast is raised
       * below. The beat delays exactly one thing, the closing.
       *
       * `scheduled` rides the state for the same reason the toast branches on `m.sendAt`:
       * nothing was sent, an appointment was made, and the button may not say "Sent" over it.
       */
      setPhase(key, m.sendAt ? { phase: "sent", scheduled: true } : { phase: "sent" });
      beat(key, () => {
        setPhase(key, IDLE);
        settledRef.current(key, m);
      });
      // Each lane's own sentence — keyed on the LANE, not the mutation shape, for the same
      // reason the cleanup above is. A forward is not a reply, and a toast that said "Reply
      // sent." over a forward was measured live; the key shim keeps the sentence honest until
      // the locale files carry it (`t.has` hands over the moment they do).
      //
      // A SEND-LATER confirm (`m.sendAt`) is the one mutation-shape branch, and it is honest
      // rather than convenient: nothing was sent, an appointment was made, and "Sent." over a
      // message that is still on the account would be exactly the false claim the four-phase
      // machine exists to prevent. The sentence carries the time, read where the reader is.
      toast(
        key === COMPOSE_SEND_KEY
          ? (m.sendAt
            ? t("compose.toastScheduled", { when: scheduleLabel(m.sendAt, new Date()) })
            : t("compose.toastSent"))
          : key.startsWith("fwd:")
            ? (t.has("reply.toastForwarded") ? t("reply.toastForwarded") : "Forwarded.")
            : t("reply.toastSent"),
      );
    },
    [engine, setPhase, toast, t, beat],
  );

  /**
   * THE MAILBOX THIS HOOK'S STORAGE BELONGS TO, captured once at mount.
   *
   * `storageOwner()` answers the mailbox the window is showing NOW, and a send does not settle
   * now. `engine.mutate`'s promise outlives the surface that started it: the desktop replaces the
   * mailbox, the shell remounts under the new one (which is what its key is for), and then
   * mailbox A's promise resolves and runs `absorb` — whose `releaseSendLock` and
   * `clearComposeDraft` would resolve their keys through the module global and delete MAILBOX B's
   * unfinished message and B's durable idempotency claim.
   *
   * Losing B's draft is the visible half. Losing B's LOCK is the worse one: that record is what
   * makes a press survive a crash without delivering twice, so clearing it under B reopens the
   * duplicate-send the durable key exists to prevent.
   *
   * Captured in a ref rather than read per call, because the shell is keyed by this same id — one
   * mount is one mailbox for its whole life, so the value cannot go stale within it, and a
   * settlement that arrives late writes to the partition it was started in.
   */
  const owner = useRef<string | null>(storageOwner());

  const absorb = useCallback(
    (key: string, m: MailSend, res: MutationResult) => {
      const next = phaseFor(res);
      if (res.status === "queued") {
        queued.current.set(res.key, key);
        inFlight.current.set(res.key, m);
        // STILL LOCKED: the intent is out there under this key and a second press would
        // mint another one. The DURABLE claim stands for the same reason and is what carries
        // that sentence across a reload — see `shell/send-lock.ts`.
        locked.current.add(key);
      } else {
        queued.current.delete(res.key);
        inFlight.current.delete(res.key);
        locked.current.delete(key);
        // TERMINAL — `confirmed`, `failed` or `unverified`. The key is spent: whatever it named
        // on the server is now that key's permanent answer, and the next press is a NEW send that
        // must get a new key. Resuming a spent one would replay the old outcome for ever, which
        // is a wedged Send button rather than a duplicate mail — still wrong, and this is the line
        // that stops it. `unverified` is included deliberately, matching `canSend`, which does not
        // lock it: the server refuses every further send of that draft, so the user's next press
        // has to be able to be a genuinely fresh one.
        releaseSendLock(key, owner.current);
      }
      // A confirmation is the only outcome that does anything beyond the phase, and `settle`
      // is where all of it lives — so a confirmation from a flush minutes later clears the
      // draft and discharges the debt exactly as the first press would have.
      if (res.status === "confirmed") settle(key, m);
      else setPhase(key, next);

      /**
       * THE SERVER HAS IT — hand the surface back, on the same beat a delivery gets.
       *
       * Only for `accepted`, i.e. the send route's own 202: the reservation is committed under
       * this key, so the draft row is now the record of what happens next and the editor has
       * nothing left to hold. A transport-queued send is NOT this — the request may never have
       * arrived — and its surface stays open under "Not sent yet".
       *
       * What is deliberately NOT done here is everything `settle` does beyond closing. The lane
       * stays LOCKED and its durable key stays claimed, because the intent is still out there and
       * a second press would be a second delivery; the triage debt is NOT discharged, because a
       * reply that has not landed has answered nothing; and the toast says accepted rather than
       * sent. The scratch IS cleared — the server's row carries the message from here, and a
       * local copy that outlived it would come back as a phantom draft beside it.
       */
      if (res.status === "queued" && next.accepted === true) {
        beat(key, () => {
          clearLaneScratch(key, m, owner.current);
          settledRef.current(key, m);
          toast(t(key === COMPOSE_SEND_KEY ? "compose.statusAccepted" : "reply.statusAccepted"));
        });
      }
    },
    [settle, setPhase, beat, toast, t],
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
    (m: MailSend, opts?: { surface?: "inline" }) => {
      const key = sendKeyOf(m, opts?.surface ?? "compose");
      // THE LOCK FIRST, off the ref, because it is the only check that is correct within one
      // tick. `canSend` then applies the SAME rule the button's `disabled` uses, so a caller
      // that is not the button (a keyboard shortcut, a future Reply Run step) cannot get past
      // something the button enforces.
      if (locked.current.has(key)) return;
      if (!canSend(states[key] ?? IDLE, m)) return;

      /**
       * ── THE DURABLE HALF, AND IT DOES NOT REFUSE THE PRESS ────────────────────────────────
       *
       * A stored key means this lane has an unsettled send. The press is allowed through and
       * RESUMES that key, rather than being refused, and the difference matters: refusing would
       * leave the reader holding a message the product will not send and cannot explain, with the
       * only exit being a reload that produces the very second key this exists to prevent.
       * Resuming makes the SERVER the authority instead — `SendService.resumeExisting` replays a
       * `sent` row's stored result without re-sending, reports a `failed` one, answers `in_flight`
       * while the first attempt may still be running, and never sends again under a key it has
       * already reserved. One press, one delivery, decided where the delivery lives.
       *
       * The claim is written BEFORE `engine.mutate`, synchronously. A key persisted afterwards
       * would leave the window this whole file is about: a process killed between the POST and
       * the write comes back with the mail possibly sent and no record of the key it went under.
       */
      const now = Date.now();
      const fp = sendFingerprint(m);
      const resumed = readSendLock(key, fp, now, owner.current);
      const sendKey = resumed ?? crypto.randomUUID();
      if (!resumed) {
        claimSendLock({ v: 1, lane: key, key: sendKey, at: now, draftId: m.draftId ?? null, fp }, owner.current);
      }

      locked.current.add(key);
      setPhase(key, { phase: "sending", since: Date.now() });
      // ACKNOWLEDGE FIRST, WORK SECOND — see {@link afterPaint}. The lock and the durable claim
      // above are synchronous and stay that way: they are what make a second press impossible,
      // and a yield in front of either would open the window they exist to close.
      void afterPaint()
        .then(() => engine.mutate(m, { key: sendKey }))
        .then((res) => {
          absorb(key, m, res);
          if (res.status === "queued") arm();
        })
        .catch((err: unknown) => {
          // `mutate` resolves rather than throws for every outcome it models; anything that
          // gets here is a bug in the engine, and swallowing it would leave the editor stuck
          // on "Sending…" with no way out.
          //
          // THE DURABLE CLAIM IS NOT RELEASED HERE, and that is the safe direction rather than an
          // omission: an engine that threw may or may not have persisted and posted the verb, so
          // the next press resuming this key is exactly right — the server decides whether it has
          // seen it. Releasing would mint a fresh key over an outcome nobody can name.
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
