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
import { OUTBOX_TYPE } from "@ohmail/client-engine";
import type { EngineMessage, MutationResult, OhmailEngine } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import {
  clearComposeDraft, composePlan, composeSessionId, readComposeDraft, readComposeRow,
  type MailSend,
} from "./compose";
import { durableRemove, durableSet } from "./durable";
import {
  allSendLocks, attachSendLockDraft, claimSendLock, holdOf, legacySendFingerprint_0_14_0,
  legacySendFingerprint_0_14_1, markSendLockUnverified, recordForSendKey,
  releaseSendLock, resumeSendLock, SEND_LOCK_FORMAT, sendFingerprint, sendIdentity, sendSubject,
  sendSubjects, unverifiedSendIntents, type Hold, type SendIntent,
} from "./send-lock";
import { storageOwner } from "./storage-owner";
import { scheduleLabel } from "./format";
import { EMPTY_RICH, parseRichValue, serializeRichValue, type RichValue } from "./rich-text";
import type { SignatureState } from "./signature";

export type SendPhase = "idle" | "sending" | "sent" | "queued" | "unverified" | "failed" | "duplicate";

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
   * attempt ceiling). What that licenses is one thing only: NOT telling the reader their request
   * may have failed to arrive, because a committed reservation proves it did. It does NOT
   * license closing the surface, and it does NOT license "ohmail sends it on its next pass" —
   * no pass claims an interactive row (`claimDue` requires a `send_key` this send has never
   * had). See `absorb` and `SendStatus` for both corrections.
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
  /**
   * ── UNRESOLVED SENDS THIS LANE STILL HOLDS, AND WHICH MESSAGES THEY ARE ────────────────────
   *
   * A `send_unverified` answer means the reservation may already have delivered and nobody can
   * tell. The only safe retry reuses the key it went under, so {@link canSend} locks Send — and
   * it used to lock the LANE, which for the compose surface is every message this browser will
   * ever write. One ambiguous delivery therefore disabled Send and Send Later for good.
   *
   * This names the messages instead, so the uncertain one stays locked and a genuinely different
   * message sends. Several may be listed: two sends can end unresolved, and both records outlive
   * every press after them.
   *
   * ── ABSENT AND EMPTY ARE DIFFERENT STATEMENTS, ON PURPOSE ──────────────────────────────────
   *
   * ABSENT means nobody named the intents — a state assembled by hand, or {@link phaseFor}'s own
   * answer, which sees a `MutationResult` and not the message it belongs to. An `unverified`
   * phase with nothing named FAILS CLOSED and locks the surface, exactly as it did before this
   * field existed. EMPTY means the durable record was read and holds nothing unresolved, which is
   * the ordinary state and locks nothing.
   */
  unresolved?: ReadonlyArray<SendIntent>;
  /**
   * THE SUBJECT OF THE MESSAGE THIS LANE IS HOLDING RIGHT NOW, when the mutation cannot name it.
   *
   * A new compose has no draft row until autosave gives it one, so `sendSubject` cannot name it
   * from the mutation alone — the name lives beside the scratch draft (`composeSessionId`) and the
   * hook reads it. Reply and forward name themselves and never need this.
   *
   * ABSENT and PRESENT are different statements. Present is the answered case. Absent means the
   * lane's subject could not be read — a jar this browser cannot write, a state assembled by hand
   * — and a message whose subject nobody can name is not evidence that it is a NEW one, so the
   * refusal below fails closed on it whenever the lane holds anything unresolved.
   */
  session?: string;
  /**
   * For `duplicate` only: what became of the send this one was refused as a copy of.
   *
   * Three states with three different truths — `sent` means a copy is provably out there,
   * `unverified` means the first attempt's fate is unknown and the Sent folder is worth a look,
   * `pending` means it is happening as the reader reads this. One sentence for all three would
   * have to claim something the product does not know in two of them.
   *
   * Absent when the server sent a member this build does not recognise, and the surface then says
   * the one thing true of all of them. See `firstSendStatusOf`.
   */
  firstSend?: "sent" | "unverified" | "pending";
}

export interface MailSendApi {
  /**
   * IS A SEND THIS MOUNT DID NOT ISSUE STILL OWED AN ANSWER ON THIS LANE?
   *
   * Read by the shell for two things: the create gate (a row written in that window is the second
   * one for a message already on its way) and the surface's phase (the send IS out there, so Send
   * is refused for it). It lives on the API rather than as a free function because the answer
   * depends on which keys THIS mount has pressed under, which only the hook knows.
   */
  restoredPending: (lane: string) => boolean;
  stateOf: (key: string) => SendState;
  /**
   * Press Send. A no-op while that surface's send is already in flight or queued.
   * `surface: "inline"` names the thread's dock as the sender — see {@link sendKeyOf} for why
   * a forward needs the surface said and a reply never does.
   *
   * `heldRow` is the draft row the hold should be asked about when the MUTATION cannot name one:
   * an inline reply's row is the adapter's and its editor is a scratch buffer, so this door asked
   * about `null` and got `free` while the row a previous press left sat unconfirmed.
   */
  send: (m: MailSend, opts?: { surface?: "inline"; heldRow?: string | null }) => void;
}

const IDLE: SendState = { phase: "idle" };

/**
 * THE PHASES IN WHICH A SEND OF THIS LANE'S MESSAGE IS STILL ON THE WIRE OR STILL OWED AN ANSWER.
 *
 * `sending` and `queued` are the two the autosave has to know about, and `sent` is the beat
 * between the confirmation and the surface closing. What they have in common is that a `drafts`
 * row created during any of them is a SECOND row for a message the send is already carrying —
 * the press-before-first-autosave race, measured on the release candidate as one message leaving
 * two rows behind.
 *
 * `unverified` is deliberately NOT here: it is terminal-unknown rather than in flight, and the
 * message is parked by `holdOf` at that point, which refuses the create for a stronger reason.
 */
export const SEND_IN_FLIGHT_PHASES: ReadonlySet<SendPhase> = new Set<SendPhase>([
  "sending", "queued", "sent",
]);

/**
 * ── IS A SEND OF THIS LANE'S MESSAGE STILL IN THE DURABLE OUTBOX? ───────────────────────────
 *
 * The phase set above is React state and starts empty on every mount, so it cannot see the one
 * sequence that has no row at all: press Send BEFORE the first autosave, lose the response,
 * reload. The verb is in the outbox and the replay will create the row server-side; the restored
 * surface holds no row, so its timer creates a SECOND one for the same message, and an edit of
 * that second row can later mint a fresh send key for a message the first has already delivered.
 *
 * THE OUTBOX IS THE EXACT DISCRIMINATOR, and the two weaker ones were tried and refused. The send
 * RECORD cannot do it: with no row its only name is the compose session, and a genuinely new
 * message on the same lane answers to that name too — parking on it refused a message nobody had
 * pressed Send on. A TTL cannot do it either: it bounds wreckage, not this. A pending `mail_send`
 * names the actual verb, and it stops naming it the moment the queue drains.
 *
 * Lane-scoped through `sendKeyOf`, the same derivation the press uses, so a reply's pending send
 * cannot refuse the compose surface's first save.
 */
/**
 * DOES THIS UNRESOLVED INTENT NAME THE MESSAGE THE LATCH WAS TAKEN FOR?
 *
 * Two witnesses, because a record is written at one moment in a message's life and read at
 * another. `bfp` is the compose buffer's fingerprint at the press — the only name that survives a
 * reload — and the SESSION is the name {@link parkedComposeRecord} parks by, so the two agree with
 * the park by construction. `false` on a record carrying neither: "no evidence" is not "not mine".
 */
function intentNamesLatched(
  intent: SendIntent, latch: { fp: string | null; session: string | null },
): boolean {
  if (latch.fp !== null && intent.bfp === latch.fp) return true;
  return latch.session !== null && intent.subjects.includes(`compose:${latch.session}`);
}

export function sendUnsettledFromLastSession(
  lane: string,
  /** The identity latched at mount, with the compose session it was taken under. See the hook. */
  latch: { fp: string | null; session: string | null },
  ownKeys: ReadonlySet<string>,
  /** `sendPendingInOutbox(engine, lane)` — the verb, which two of the arms below turn on. */
  pendingOnLane: boolean,
  owner: string | null = null,
): boolean {
  /**
   * ── THE COMPOSE ON SCREEN IS THE MESSAGE A SEND IS STILL CARRYING ──────────────────────────
   *
   * KEYED ON IDENTITY, NOT ON THE LANE, and the difference is why this holds where two earlier
   * shapes could not. A lane is `"compose"` — the name of every message this browser will ever
   * write. Refusing a press on the lane refuses a genuinely NEW message written after a crash,
   * which is the worse defect of the pair: a silently unsent mail. Measured twice, in both shapes
   * tried, against the durable lock's own kill test. Keyed on WHICH MESSAGE, a different one
   * simply never matches.
   *
   * The identity is {@link composeBufferFingerprint} on both sides — the value the press recorded
   * ({@link SendLock.bfp}) against the value the buffer computes now. The sent message's own
   * fingerprint cannot be used: a mount after a reload cannot reproduce it (the signature and the
   * resolved sending mailbox are not in the buffer), so that comparison would match only for an
   * account with no signature.
   *
   * ── FOUR ARMS, IN THIS ORDER, AND THE ORDER IS THE RULE ─────────────────────────────────────
   */
  /* 1. AN UNVERIFIED SEND *OF THIS MESSAGE* OUTRANKS THIS. `unverified` IS an answer — the worst
        one: the key is spent and nobody knows whether the mail left. THAT message parks by its
        record with the sentence naming that state, and holding it under "still being sent" would
        be false.

        PER MESSAGE, NOT PER LANE, and the difference was a second delivery. The lane is
        `"compose"` — the name of every message this browser will ever write — so ANY unverified
        record on it switched the restored hold off for a DIFFERENT message whose own send was
        still replaying: the fields stayed editable, an edit changed the fingerprint, and the press
        minted a fresh key for mail already on its way. Same correction `canSend`'s
        `unresolvedNames` carries, for the same reason.

        A record that cannot be SHOWN to name this message does not yield here — it falls through
        to arms 2 and 3, which hold it while its send is pending. */
  if (unverifiedSendIntents(lane, owner).some((i) => intentNamesLatched(i, latch))) return false;

  /* The lane's records, with the outbox exempting a pending one from the age limit — and from
     this read's own pruning, which would otherwise delete the answer before anybody read it. */
  const rows = allSendLocks(Date.now(), owner, pendingOnLane ? new Set([lane]) : undefined)
    // THIS MOUNT'S OWN PRESSES ARE NOT "FROM THE LAST SESSION", and leaving them in was the whole
    // of a measured regression: every record is written by a press, so a rule that reads them all
    // refuses the very resume the record exists for — 23 cases went red saying so, four of them
    // the durable lock's own kill tests.
    .filter((r) => r.lane === lane && !ownKeys.has(r.key));
  if (rows.length === 0) return false;

  /* 2. A RECORD THIS BUILD CANNOT DISCRIMINATE WITH FAILS CLOSED WHILE ITS SEND IS PENDING.
        A record written by the shipped previous build carries no `bfp`, so there is no way to ask
        whether the message on screen is the one it names. The upgrade window is real: install the
        new build with a send still waiting to go out and the old record is all there is.

        So while that lane's replay is pending, everything on it is held — INCLUDING a message that
        is genuinely different, which is the one case this arm is deliberately too strict about. It
        is bounded by the drain (seconds), it costs a wait rather than a duplicate, and the
        alternative is guessing with no evidence: the arm exists precisely because the evidence
        that would tell the two apart was never written down. */
  if (pendingOnLane && rows.some((r) => r.bfp === undefined)) return true;

  /* 3. AND THE ORDINARY CASE: this build's own record, naming the message on screen.

        THE LATCH IS RE-DERIVED WHEN THE COMPOSE SESSION CHANGES — see the hook — and that is what
        keeps this arm from following the composer onto a message the hold was never taken for. A
        SECOND check here, comparing the live session against the latched one, was written first and
        REMOVED: it and the re-derivation each closed the case on their own, so neither could be
        watched fail and a reader would have read the pair as one guarantee. Measured from both
        sides — remove either and the case stayed green. The re-derivation is the one kept, because
        it leaves the hold available to a LATER session that inherits a record of its own, where the
        session comparison would have refused every hold for the life of the mount. */
  return latch.fp !== null && rows.some((r) => r.bfp === latch.fp);
}

export function sendPendingInOutbox(engine: OhmailEngine, lane: string): boolean {
  return engine.pendingMutations().some((p) => p.mutation.kind === "mail_send"
    && sendKeyOf(p.mutation as unknown as MailSend) === lane);
}

/**
 * IS A SEND OF THIS LANE STILL IN THE **DURABLE** OUTBOX — the question the QUEUE cannot answer.
 *
 * {@link sendPendingInOutbox} reads `engine.pendingMutations()`, which is the in-memory queue, and
 * for a RESTORED send that list is empty at every moment a surface could look at it. Measured, at
 * five points on a restored engine — before `start()`, immediately after, +1 ms, +11 ms, and after
 * the drive resolved: zero, zero, zero, zero, zero. The entry is loaded and dispatched without
 * ever being observable, so a rule built on that read is a rule that never fires. Two arms of the
 * hold below were written on it and both were silently dead until this was measured.
 *
 * The STORE holds the row for the whole window — one before `start()`, one mid-flight, none once
 * the send settles — and `OUTBOX_TYPE` is exported for exactly this kind of read. So the durable
 * record of the verb is the evidence, and it lapses when the verb does, with no timer anywhere.
 */
export function sendPendingInDurableOutbox(engine: OhmailEngine, lane: string): boolean {
  const rows = engine.read().list(OUTBOX_TYPE) as ReadonlyArray<{ mutation?: { kind?: string } }>;
  return rows.some((r) => r.mutation?.kind === "mail_send"
    && sendKeyOf(r.mutation as unknown as MailSend) === lane);
}

/** There is one compose surface, so its send state needs one key. */
export const COMPOSE_SEND_KEY = "compose";

/**
 * WHAT THE COMPOSE BUFFER HOLDS, AS AN IDENTITY — computed once here and used at BOTH moments.
 *
 * The press records this beside the sent message's own fingerprint ({@link SendLock.bfp}), and a
 * mount coming back after a reload recomputes it from the restored buffer. Equal means the text on
 * screen is still the message that send is carrying; different means it is something else.
 *
 * ONE FUNCTION, TWO MOMENTS, and that is the point rather than a convenience. The alternative —
 * comparing the buffer against the fingerprint of the mutation AS SENT — cannot work: the press
 * folds the signature into the body and the html and resolves the sending mailbox, none of which
 * is in the buffer, so the comparison would match only for an account that has no signature. A
 * guard that silently does not guard for everybody else is the same defect as one that cannot fire
 * at all, and it is invisible from a test account with no signature set.
 *
 * `null` for an EMPTY buffer, which is not a message and must never match a record: a surface with
 * no compose on it (a reply-only harness, a shell that has never opened one) would otherwise latch
 * on somebody else's record and refuse a press it has no business refusing.
 */
export function composeBufferFingerprint(): string | null {
  const fields = readComposeDraft();
  const empty = fields.to.trim().length === 0
    && fields.subject.trim().length === 0
    && fields.body.trim().length === 0;
  if (empty) return null;
  const plan = composePlan(fields, fields.fromMailboxId ?? null);
  return sendFingerprint(plan.mutation as unknown as MailSend);
}

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
  const raw = serializeRichValue(value);
  // The draft still lives in React state for this session; a jar that refused it no longer
  // passes for one that kept it.
  if (raw === null) durableRemove(replyDraftKey(messageId), "reply.draft");
  else durableSet(replyDraftKey(messageId), raw, "reply.draft");
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
  // A meta with neither field stores nothing — absence IS the resting state, see above.
  if (meta.subject === undefined && meta.sig === undefined) {
    durableRemove(replyMetaKey(lane), "reply.meta");
    return;
  }
  durableSet(replyMetaKey(lane), JSON.stringify(meta), "reply.meta");
}

/**
 * DROP THE PER-LANE SCRATCH a settled send is done with — the body buffer and the editor meta.
 *
 * Module-level and shared, because two different endings now spend it: a delivery (`settle`) and
 * the server's accepted-pending hand-off, which closes the surface without discharging anything
 * else. A second copy of "which keys is this lane holding" is a second place for a lane to leak a
 * draft that outlives the message it was.
 *
 * Every removal goes through the durable door: a browser that refuses `localStorage` outright
 * holds nothing to remove, and one that refuses a single key says so rather than leaving the
 * pair half-dropped — the body and its meta are one lane's scratch and clear together.
 */
export function clearLaneScratch(key: string, m: MailSend, owner: string | null): void {
  if (m.inReplyTo === null) {
    if (key === COMPOSE_SEND_KEY) {
      clearComposeDraft(owner);
      // The delivered message's row is spent, and so is the block state keyed to it.
      if (m.draftId) durableRemove(replyMetaKey(`draft:${m.draftId}`), "reply.meta");
      return;
    }
    // The INLINE forward — the lane doubles as the scratch suffix, so the note clears here
    // exactly as a reply's draft does below. The compose form's autosave is deliberately
    // untouched: this send never used the form, and a half-written compose must survive
    // somebody forwarding a message mid-sentence.
    durableRemove(replyDraftKey(key), "reply.draft");
    durableRemove(replyMetaKey(key), "reply.meta");
    return;
  }
  durableRemove(replyDraftKey(m.inReplyTo), "reply.draft");
  durableRemove(replyMetaKey(m.inReplyTo), "reply.meta");
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
 *   · `failed` is NOT locked: it is terminal on the server for that draft, so the only way
 *     forward is a fresh send the user deliberately chooses. `unverified` IS locked, and only
 *     for the messages an unresolved send names — see the two arms in the body, which correct
 *     what this line used to claim about it.
 *   · `duplicate` is NOT locked either, and the reason is read from the other side: the server
 *     has refused THIS message as a copy of one it already holds, so the deliberate choice open
 *     to the reader is usually an EDIT — a changed message is admitted — and locking the button
 *     would leave no way to make that change and send it. (An earlier version of this line said
 *     `unverified` was free too; that was true of the code it was written against and is not true
 *     here. See the two arms in the body.)
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
/**
 * DOES THIS STATE'S UNRESOLVED LIST NAME *THIS* MESSAGE? — one answer, both readers.
 *
 * {@link canSend} decides whether the press is refused and {@link sendStateFor} decides whether
 * the surface says anything about it. Two copies of this would be two places for the button and
 * the sentence beside it to disagree, which is the failure the "one rule" header is about.
 *
 * The two states {@link SendState.unresolved} distinguishes are both here. ABSENT means nobody
 * supplied intents — `phaseFor` cannot, it sees a `MutationResult` and not the message it belongs
 * to — and an `unverified` phase with nothing named FAILS CLOSED, exactly as it did before the
 * field existed. PRESENT means the record was read, and only a match counts.
 */
function unresolvedNames(state: SendState, m: MailSend): boolean {
  if (state.unresolved === undefined) return state.phase === "unverified";
  if (state.unresolved.length === 0) return false;
  /**
   * BY SUBJECT, NOT BY FINGERPRINT — see {@link sendSubject}. The fingerprint answers "may this
   * stored key be resumed for this content"; the subject answers "is this the message whose
   * outcome nobody knows", and only the second may decide a refusal. Keying the refusal on the
   * fingerprint made an EDIT an escape from the lock, which is a second delivery by construction.
   */
  /**
   * EVERY NAME, NOT THE PREFERRED ONE — see {@link sendSubjects}, and this line is the measured
   * defect. `sendSubject` prefers the draft row, so a compose recorded as `compose:<session>`
   * before autosave had written anything was named `draft:<id>` half a second later, the two
   * forms could not match, and the surface unlocked for a message it held an unresolved record
   * of. A press with nothing edited then delivered it a second time. A record parks this message
   * when the two sets share a name.
   */
  const subjects = sendSubjects(m, state.session ?? null);
  /**
   * FAIL CLOSED, AND THE TWO STATES THIS DISTINGUISHES ARE NAMED. Empty here means the message
   * could not be named at all — no draft row yet AND no session id (a blocked jar, a hand-built
   * state). With something unresolved on this lane, a message we cannot name is not evidence that
   * it is a different one, and the cost of guessing wrong is a duplicate delivery.
   */
  if (subjects.length === 0) return true;
  /**
   * A RECORD THAT NAMES NOTHING PARKS BY THE ONLY IDENTITY IT HAS, which is the fingerprint it
   * was written under. Such a record was stored before the subject existed; comparing an absent
   * name against a real one is false for every message, so it would have parked NOTHING — a
   * fail-open direction on a duplicate-delivery guard, and one the record's own docblock does not
   * claim. Weaker than the subject, and it is what that record can answer.
   */
  /**
   * COMPUTED ONLY IF A RECORD ACTUALLY NEEDS IT, and that is a cost note rather than a behaviour
   * change: the predicate below reads `fp` in one branch only. `sendFingerprint` now hashes each
   * attachment's CONTENT (it identified a file by byte length, so a replacement of the same size
   * shared an Idempotency-Key), and this function runs on the render path that decides whether
   * Send is pressable — so hashing megabytes of base64 for every record that parks by subject,
   * which is every record a current build writes, would put the whole attachment through a hash
   * on each keystroke. Lazy, memoised for the length of the call, same answer.
   */
  let fp: string | null = null;
  const fpOf = (): string => (fp ??= sendFingerprint(m));
  /**
   * AND THE 0.14.0 FINGERPRINT, for the records that carry no name at all.
   *
   * A record with no names is a record from before the subject existed — a released 0.14.0 one —
   * and its `fp` is in 0.14.0's algebra, so comparing it against the CURRENT fingerprint is false
   * for every message. That would have parked nothing: a browser upgraded mid-uncertainty would
   * have shown no warning and an unlocked Send for the very message whose fate is unknown. The
   * legacy hash is cheap (it folds an attachment in by size, not by content), so it is asked
   * first and the expensive one only if it misses.
   */
  let legacyFp: string | null = null;
  const legacyFpOf = (): string => (legacyFp ??= legacySendFingerprint_0_14_0(m));
  /**
   * AND THE 0.14.1 ONE, for the same reason one step later.
   *
   * A `v: 2` record that carries no name at all — a 0.14.1 browser that could not read its own
   * session id — has its fingerprint in THAT build's algebra, which folded the draft row in. It is
   * neither the 0.14.0 spelling nor this one, so without this line such a record parked nothing:
   * no warning, Send live, for the very message whose fate is unknown.
   *
   * All three are tried because a nameless record does not say which build wrote it. Widening a
   * fail-closed comparison in the closed direction costs a false park at worst; the other
   * direction costs a second copy in somebody's mailbox.
   */
  let legacyFp0141: string | null = null;
  const legacyFp0141Of = (): string => (legacyFp0141 ??= legacySendFingerprint_0_14_1(m));
  /**
   * ── A SESSION MATCH IS FINAL. NEITHER THE ROW NOR THE FINGERPRINT OVERRIDES IT ─────────────
   *
   * A rule used to stand here: where BOTH sides named a draft row and the rows differed, they
   * were two messages and the row decided. It was written for one compose surface reopening one
   * draft after another under a SINGLE session — under which a record naming `draft:30` really
   * would have parked a message naming `draft:40`. The premise is what has been fixed instead:
   * every door that replaces the compose form re-mints the session (`clearComposeDraft` before
   * the seed, in `openDraft`, `writeTo` and the mailto seam), so one session names exactly one
   * message-in-progress and two messages cannot share one.
   *
   * With the premise gone the rule was a hole, in two shapes, both of them a second delivery:
   *
   *  · THE ROW MOVES UNDER ONE MESSAGE. A send from saved draft `d1` comes back unverified; the
   *    reload restores the same message but the composer's autosave had forgotten `d1` and made
   *    `d2`. Two rows, one message, one session — and the row rule read that as two messages and
   *    unlocked Send for a message that may already be in somebody's inbox. (`d1` is now adopted
   *    on mount, `compose-autosave.ts`, so the row does not move at all; this is the other half.)
   *  · THE CONTENT MOVES. Any rule that lets a fingerprint difference unlock is the escape the
   *    park exists to close: type one character into a message whose outcome nobody knows, and
   *    the press mints a fresh key at `crypto.randomUUID()` below.
   *
   * So the intersection is the whole answer. The one weaker comparison is a record that names
   * NOTHING — see the fingerprint arm's own note above; it is what that record can answer.
   */
  return state.unresolved.some((i) => {
    if (i.subjects.length === 0) {
      return i.fp === legacyFpOf() || i.fp === legacyFp0141Of() || i.fp === fpOf();
    }
    return i.subjects.some((s) => subjects.includes(s));
  });
}

/**
 * THE STATE AS IT APPLIES TO THE MESSAGE ON SCREEN — what a surface renders.
 *
 * `unverified` is a lane-level phase and `SendStatus` renders a warn sentence for it: "We
 * couldn't confirm this send. Check your Sent folder before retrying." That sentence is true of
 * the message the unresolved send belongs to and false of anything written afterwards on the same
 * surface — and with the press no longer refused, leaving it would put a warning about somebody
 * else's mail above a live Send button, permanently.
 *
 * So a surface renders THIS. It hands back the state untouched when the phase names the message,
 * and presents it as `idle` when it does not — the phase only, with `unresolved` carried through,
 * so a `canSend` reading the narrowed state gives the same answer as one reading the original.
 */
export function sendStateFor(state: SendState, m: MailSend): SendState {
  if (state.phase !== "unverified") return state;
  return unresolvedNames(state, m) ? state : { ...state, phase: "idle" };
}

/**
 * ── A ROW THE SERVER ITSELF MARKED UNVERIFIED, HELD BY THIS COMPOSE ─────────────────────────
 *
 * The record in this browser is one witness that a send may already have gone. The SERVER's own
 * `unverified` status on the row is another, and it is the one that survives everything the first
 * does not: a record this browser never wrote (the row the send created for itself, whose id the
 * client never learns), a record lost with the storage it lives in, another device's send.
 * Measured live: such a row is listed in Drafts, opening it took the recovery door, and one press
 * delivered the message a second time while the server held the first as unverified.
 *
 * So a compose HOLDING such a row is refused on the row's status alone, with the same sentence
 * the record produces — `phase` as well as `unresolved`, because the warning renders off the
 * phase (`sendStateFor`) and a lock with no sentence is a button that is broken for no stated
 * reason. Both names go in the intent: the row, and the session holding it, so the refusal
 * matches whether or not the composer has adopted it.
 *
 * A press already in flight is left alone — it is locked for a stronger reason and its own
 * outcome is on its way.
 */
export function heldRowUnverified(
  state: SendState,
  heldRow: string | null,
  hold: Hold,
  session: string | null,
  /**
   * THE MESSAGE THIS REPLY SURFACE IS ANSWERING, when the surface is the inline reply editor.
   *
   * A reply is named `reply:<parent id>` and never by a row ({@link sendSubjects}), so an intent
   * carrying the row alone matched no reply mutation and the warning was dropped over a reply
   * whose own row sat unconfirmed. `null` on the compose surface, which has no such name.
   */
  replyTo: string | null = null,
): SendState {
  if (state.phase === "sending" || state.phase === "queued" || state.phase === "sent") return state;
  if (heldRow === null) return state;
  /**
   * A PROJECTION OF {@link holdOf}, NOT A SECOND READING OF THE ROW.
   *
   * This used to look the row up in the drafts array and apply the status rule itself, which made
   * it the third place that decided what "held" means. It now consumes the answer: the caller asks
   * `holdOf` once and hands it here.
   *
   * `parked` only. `unknown` — a jar this browser cannot read — deliberately does NOT put the
   * warning up or lock the button: a browser that refuses this app its own storage must still be
   * able to send (invariant S(4)). The recovery sites are where `unknown` fails closed.
   */
  if (hold.kind !== "parked") return state;
  /**
   * ── THE MIRROR'S `sent` IS AUTHORITATIVE OVER THIS BROWSER'S "NOBODY KNOWS" ────────────────
   *
   * A send commits, `/sync` brings the row back as `sent`, and the tab that owned the response
   * died before it could settle the record. The restored compose is still holding that row, so
   * the status arm parks it — correctly, nothing may WRITE to a sent row — and projecting that
   * park into `unverified` put "We couldn't confirm this send" on screen about a message the
   * mirror says was delivered. A false state is worse than no state: it sends somebody to look
   * for mail that is in their Sent folder, and it refuses the press that would have replayed the
   * original key if it had not been sent.
   *
   * So the WRITE refusal and the SENTENCE part company here, and only here. The hold still says
   * parked, so `holdOf`'s consumers keep their hands off the row; the surface says nothing.
   * `compose-autosave.ts`'s adoption drops the row and settles the record on the same evidence.
   */
  if (hold.by === "status" && hold.status === "sent") return state;
  /* EVERY NAME THE MESSAGE ON THIS SURFACE ANSWERS TO — the row, the compose session holding it,
     and the message a reply is answering. `unresolvedNames` matches on the shared name, so a name
     missing here is a surface the refusal cannot reach. */
  const subjects = [
    `draft:${heldRow}`,
    ...(session === null ? [] : [`compose:${session}`]),
    ...(replyTo === null ? [] : [`reply:${replyTo}`]),
  ];
  return {
    ...state,
    phase: "unverified",
    unresolved: [...(state.unresolved ?? []), { subjects, fp: "" }],
  };
}

export function canSend(state: SendState, m: MailSend): boolean {
  /**
   * `sent` joins the two locked phases: it is the beat between the confirmation and the surface
   * closing, and a press landing inside it would mint a second key for a message already gone.
   *
   * `unverified` IS LOCKED TOO, and it used not to be. An unverified send is a TERMINAL-UNKNOWN
   * state, not a failure: the reservation may already have delivered, and the only thing that
   * makes a retry safe is reusing the key it went under. Leaving Send enabled here let the next
   * press mint a fresh key — and the compose had shed the draft id by then, so the server saw a
   * different draft under a different key and had nothing to collide with. Server uniqueness is
   * `(account_id, idempotency_key)`, so two reservations for one message is not a race: it is the
   * documented behaviour of pressing the button twice. A second copy in somebody's inbox cannot
   * be taken back, which is why this is a lock rather than a warning.
   */
  if (state.phase === "sending" || state.phase === "queued" || state.phase === "sent") return false;
  /**
   * ── THE UNVERIFIED LOCK IS PER MESSAGE, AND IT FAILS CLOSED WHEN NOBODY NAMED ONE ──────────
   *
   * `unverified` locked the whole lane, and for the compose surface a lane is every message this
   * browser will ever write — so one ambiguous delivery disabled Send and Send Later for all
   * future new messages, permanently: the durable record is exempt from the age limit by design,
   * and `stateOf` reads it on every mount. The mailbox was locked out of composing.
   *
   * So the refusal reads {@link SendState.unresolved}, which names the messages an unresolved
   * send belongs to. A press on one of them is refused for exactly the reason it always was; a
   * press on a genuinely different message is not.
   *
   * The two arms below are the two states that field distinguishes, and they must stay apart. An
   * `unverified` phase with NOTHING named is a state nobody supplied intents for — `phaseFor`
   * cannot, it sees a result and not the message — and it refuses, which is the behaviour before
   * this field existed. `unresolved` present is the answered case, and only a match locks.
   */
  if (unresolvedNames(state, m)) return false;
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
  /**
   * THE SERVER REFUSED THIS AS A SECOND COPY OF A MESSAGE IT ALREADY HAS.
   *
   * Its own phase and not `failed`, because "failed" is the product's word for *nothing went out
   * and you may try again*, and here the opposite may be true: something identical was already
   * accepted, possibly delivered, and the one thing the reader must not do is press Send again.
   * Not `unverified` either — that copy tells the reader a Sent-folder probe ran and came back
   * empty, and on this path no probe ran at all.
   *
   * `firstSend` is the fact the sentence turns on and only the server has it: whether the first
   * attempt is known sent, unconfirmed, or still running right now. It is carried as structured
   * detail rather than as prose so the surface can say it in the reader's own language — the
   * server's `message` stays in `reason` for diagnostics, exactly as it does for `failed`.
   */
  if (res.error?.code === "duplicate_send") {
    return {
      phase: "duplicate",
      code: "duplicate_send",
      ...(res.error?.message ? { reason: res.error.message } : {}),
      ...(firstSendStatusOf(res.error?.details) ? { firstSend: firstSendStatusOf(res.error.details)! } : {}),
    };
  }
  return {
    phase: "failed",
    ...(res.error?.message ? { reason: res.error.message } : {}),
    ...(res.error?.code ? { code: res.error.code } : {}),
  };
}

/**
 * Read `{ firstSend: { status } }` out of a refusal's details, or `undefined`.
 *
 * Defensive by construction: this is wire data, the shell renders a different sentence for each
 * member, and a member this build has not heard of must degrade to the general sentence rather
 * than to a blank line or a thrown render. An unrecognised status is therefore dropped, which is
 * the same rule the organizer reader applies to a refusal reason it does not know.
 */
export function firstSendStatusOf(details: unknown): "sent" | "unverified" | "pending" | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const fs = (details as { firstSend?: unknown }).firstSend;
  if (typeof fs !== "object" || fs === null) return undefined;
  const status = (fs as { status?: unknown }).status;
  return status === "sent" || status === "unverified" || status === "pending" ? status : undefined;
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
  /**
   * LANES THE SERVER HAS ACCEPTED — and it is STICKY, which a review had to point out.
   *
   * The 202 is said ONCE, by the request that reserved the send. Every retry after it presents
   * the same key against a live reservation and is answered `in_flight` (409), whose result maps
   * to a plain `queued` with no `accepted` flag — so `setPhase` overwrote the accepted state five
   * seconds after the press and the line went from "the product has this" to "this may not have
   * arrived". That is the collapse the two flavours exist to prevent, running BACKWARDS: the
   * request provably did arrive, because there is a committed reservation, and the surface was
   * saying it might not have. It fired on every accepted send and then persisted, because every
   * later retry is `in_flight` too.
   *
   * A committed reservation is a fact that cannot become untrue, so the flag is remembered per
   * lane rather than re-derived from each answer. Cleared only on a terminal outcome, beside the
   * lock — the two have the same lifetime for the same reason.
   */
  const accepted = useRef(new Set<string>());
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
            ? t("reply.toastForwarded")
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

  /**
   * THE COMPOSE SESSION ID FOR A LANE — the compose surface's, and `null` for every other lane.
   *
   * ── IT USED TO BE READ ONLY FOR A MESSAGE WITH NO NAME OF ITS OWN, AND THAT WAS THE DEFECT ──
   *
   * The old rule was `sendSubject(m, null) === undefined ? composeSessionId() : null`: a
   * draft-backed compose never touched storage for it, on the reasoning that the row already
   * names the message. The row does name it — but not for the whole of its life. A compose
   * pressed before autosave has written anything is named `compose:<session>`, and the row
   * appears half a second later; with the session unread from that point on, the record and the
   * surface could no longer be shown to be about the same message, and an unresolved send
   * unlocked and went out twice.
   *
   * So the session is the lane's fact, not the message's: read for the compose surface whatever
   * the message currently carries, and never for a reply or a forward, which are named by the
   * message they answer and cannot be renamed under them. This is the same expression
   * {@link stateFor} uses, in one place, so the record's identity and the surface's cannot drift.
   */
  const sessionOf = useCallback(
    (key: string): string | null => (key === COMPOSE_SEND_KEY ? composeSessionId(owner.current) : null),
    [],
  );

  const absorb = useCallback(
    (key: string, m: MailSend, res: MutationResult) => {
      let next = phaseFor(res);
      if (res.status === "queued") {
        // Remember the server's 202 the one time it is said, and re-apply it to every later
        // `in_flight` answer for this lane — see {@link accepted}.
        if (next.accepted === true) accepted.current.add(key);
        else if (accepted.current.has(key)) next = { ...next, accepted: true };
        queued.current.set(res.key, key);
        inFlight.current.set(res.key, m);
        /* THE ROW AN ACCEPTED SEND IS ABOUT, BOUND WHILE THE ANSWER IS STILL HERE.
           A queued send is unconfirmed and is parked under the message's names (invariant S(3)).
           The row is one of those names, and for a press that carried none it exists only on the
           server until this result names it — so a reload inside the queued window came back, read
           that row as an ordinary draft, and the next press minted a second key for one message.
           Diagnostic on the record, exactly as everywhere else: nothing chooses a key from it. */
        attachSendLockDraft(
          key, sendSubjects(m, sessionOf(key)),
          m.draftId ?? res.entityId
            ?? (key === COMPOSE_SEND_KEY ? readComposeRow(owner.current) : null),
          owner.current,
        );
        // STILL LOCKED: the intent is out there under this key and a second press would
        // mint another one. The DURABLE claim stands for the same reason and is what carries
        // that sentence across a reload — see `shell/send-lock.ts`.
        locked.current.add(key);
      } else {
        queued.current.delete(res.key);
        inFlight.current.delete(res.key);
        locked.current.delete(key);
        // Terminal: the reservation this named is settled, so the fact it was accepted is spent
        // with it. Cleared beside the lock because the two have the same lifetime.
        accepted.current.delete(key);
        /**
         * TERMINAL — and `unverified` is NOT one of the terminals that spends the key.
         *
         * For `confirmed`, `failed` and `duplicate` the key is spent: whatever it named on the
         * server is that key's permanent answer, and the next press is a genuinely new send.
         * Resuming a spent key would replay the old outcome for ever — a wedged Send button rather
         * than a duplicate.
         *
         * `duplicate` joins them because nothing is pending under it: the server refused the
         * request and rolled its own reservation back, so this key names nothing and the way
         * forward is an edit, which is a different message and therefore a different send.
         *
         * `unverified` means nobody knows whether it delivered. The lock is what carries the key
         * across a reload, so releasing it is exactly how the next press gets a FRESH key for a
         * message that may already be gone. This branch used to release it, on the reasoning that
         * "the server refuses every further send of that draft" — which stopped being true the
         * moment the compose shed the draft id before re-sending. The key is kept, so any retry
         * reuses it and the server can recognise the reservation; the send parks as needing a
         * check instead of quietly going twice.
         *
         * THE SERVER-SIDE CONTENT CLAIM DOES NOT CHANGE THIS, and it is worth saying so here
         * because it is the obvious thing to conclude. An identical second send is now refused for
         * an hour whatever key it carries, so a released key would no longer mean a duplicate — but
         * "no longer a duplicate" is not the same as "the right answer". Keeping the key still
         * gives the better one: within the hour the server REPLAYS the original outcome instead of
         * refusing, and past the hour the key is the only thing that still resumes. The two guards
         * are belt and braces and the braces stay.
         */
        // NAMED BY MESSAGE, not by lane. A lane can hold an unresolved record beside this one,
        // and releasing the lane would delete the record saying an earlier message may already
        // have been delivered — see `releaseSendLock`.
        const fp = sendFingerprint(m);
        if (next.phase !== "unverified") releaseSendLock(key, fp, owner.current);
        // DURABLY, because the phase below is component state: reopening the draft, a reload or
        // another tab all start from `idle`, and each of those is a way back to a send that may
        // already have gone. The lock is the only thing that survives them.
        //
        // The intent rides on the phase as well, so the surface locks THIS message rather than
        // the lane it was written on — `canSend` reads it, and a reload reads it back off disk.
        else {
          markSendLockUnverified(key, fp, owner.current);
          /* AND BIND THE ROW THIS SURFACE IS HOLDING, AT THE MOMENT THE RECORD IS WRITTEN.
             Measured live: a compose pressed with no row of its own is recorded as
             `compose:<session>`, and the armed autosave's row lands either side of this answer.
             The create-time attach (`compose-autosave.ts`) catches the row that lands AFTER;
             this catches the one that landed BEFORE, which nothing did — the record then named
             no row at all, the row sat in Drafts looking ordinary, and reopening it took the
             recovery door and sent the message a second time. `m.draftId` first: it is what the
             press itself carried. */
          /* AND THE ROW THE *ADAPTER* MADE, WHICH NOTHING HERE COULD NAME UNTIL NOW.
             A press that carried no row makes the adapter create one and send THAT; the server
             marks it `unverified` and the client was never told which row it was, so it sat in
             Drafts looking ordinary — reopening it took the recovery door and one press delivered
             the message a second time. `MutationRejectedError.entityId` carries it now
             (`http-adapter.ts`, the `unverified` arm), and it is preferred over the local fallback
             for exactly the case the fallback cannot cover.
             The lane test is gone with it: a reply or a forward pressed with no row has the same
             gap, and the record for those lanes is named by the parent message either way. */
          attachSendLockDraft(
            key, sendSubjects(m, sessionOf(key)),
            m.draftId ?? res.error?.entityId
              ?? (key === COMPOSE_SEND_KEY ? readComposeRow(owner.current) : null),
            owner.current,
          );
          next = { ...next, unresolved: [{ subjects: sendSubjects(m, sessionOf(key)), fp }] };
        }
      }
      // A confirmation is the only outcome that does anything beyond the phase, and `settle`
      // is where all of it lives — so a confirmation from a flush minutes later clears the
      // draft and discharges the debt exactly as the first press would have.
      if (res.status === "confirmed") settle(key, m);
      else setPhase(key, next);

      /**
       * ── AN ACCEPTED-PENDING SEND DOES NOT CLOSE THE SURFACE, AND THE FIRST VERSION DID ──────
       *
       * It ran `settledRef.current(key, m)` on the beat, reasoning that the server holds a
       * committed reservation so the editor has nothing left to hold. Both halves were wrong and
       * a review caught them.
       *
       * FIRST, that callback is not "close the surface". `AppShell.onSendSettled` says in three
       * places that it fires on a CONFIRMATION and on nothing else, and its body acts on it: it
       * marks the answered message READ and spends its resurfaced pin, steps the Reply Run past
       * the item, drops a drafted alternative as moot, and discards the stranded row a recovery
       * compose was seeded from. Every one of those states "this was answered" about a message
       * that may never have left. The comment that used to stand here claimed the triage debt was
       * not discharged; that was true of `settle`'s own discharge and false of the shell's, which
       * is the whole defect — reasoning about the function I wrote instead of the one I called.
       *
       * SECOND, the premise "the draft row carries it from here" does not hold for an INTERACTIVE
       * send. Nothing server-side picks that row up: `claimDue` requires `send_at` AND `send_key`
       * to be non-null and a manual send has neither, so no pass ever looks at it — and the
       * recovery arm that does claim a row runs verify-by-Sent, which never re-submits. The only
       * thing that resolves an interactive accepted-pending send is the retry driver in THIS
       * hook, which lives exactly as long as this surface's session. Closing the surface would
       * hand the message to a resolver that does not exist.
       *
       * So both queued flavours keep their surface, and the difference between them stays where
       * it belongs: in the sentence. The lane stays locked and its durable key stays claimed,
       * because the intent is out there under it and a second press would be a second delivery.
       */
    },
    [settle, setPhase, sessionOf],
  );

  /**
   * ── HANDING A LIVE MOUNT'S OWN LATE RESULT BACK TO IT ───────────────────────────────────────
   *
   * `flushPending()` is DESTRUCTIVE: whatever it returns is gone from the engine. The restore
   * collector below used to pull everything and then SKIP any key this mount was tracking, on the
   * reasoning that such a key is `flush`'s business — but by then the answer had been consumed and
   * `flush` would never see it. Nothing was left anywhere: no pending mutation, no late result, no
   * answer. The compose stayed `queued` for the rest of the session, every field and Cancel
   * disabled, for a message that HAD been delivered — and the only exit was a reload, which is
   * where a second Idempotency-Key comes from.
   *
   * So the collector routes by OWNERSHIP: a result whose key this mount owns is handed to exactly
   * the code path its own press would have run. This is that path, kept in a ref because the
   * collector's effect must not re-subscribe every time a callback identity moves.
   */
  const absorbOwn = useRef<(res: MutationResult) => boolean>(() => false);

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

  /**
   * FLUSH'S OWN PER-RESULT WORK, reachable from the restore collector — see {@link absorbOwn}.
   *
   * The SAME `absorb`, and the retry timer re-armed on a still-queued answer exactly as `flush`
   * does it, because a result handed over is a result `flush` will not see and everything `flush`
   * would have done for it has to happen once. Assigned during render rather than in an effect so
   * the collector never holds a stale closure over `absorb`.
   */
  absorbOwn.current = (res: MutationResult): boolean => {
    const key = queued.current.get(res.key);
    const m = inFlight.current.get(res.key);
    if (!key || !m) return false;
    absorb(key, m, res);
    if (res.status === "queued") arm();
    return true;
  };

  /**
   * ── THE ADOPTION PASS AT MOUNT, AND WHY IT EXISTS NOW WHEN IT DID NOT BEFORE ────────────────
   *
   * This file's header used to say there is deliberately no adoption pass at mount, because "a
   * mount that adopted the lane as `queued` would lock a button whose settlement can never arrive
   * through `flushPending`". That was true and it was a statement about the ENGINE, not about
   * adoption: a restored entry's result was discarded by the replay, so nothing could ever arrive.
   * The engine keeps it now (`replayOutboxInner` writes it to `lateResults`, where the timeout
   * path already wrote), so the objection is gone and the settlement is exactly what has to be
   * collected — because without it a send that completed on this boot leaves its message sitting
   * in the composer, and an edit there is a second delivery.
   *
   * ONE CONSUMER, UNCHANGED. `flushPending()` is destructive and `useMailSend` owns it; this is
   * that same owner, pulling on the one occasion its own maps are empty. `flush` cannot do it —
   * it returns early when nothing is queued IN THIS MOUNT, and it skips a result whose key it does
   * not recognise, which is every restored one.
   *
   * THE KEY IS TURNED BACK INTO A MESSAGE BY THE RECORD, not by guesswork: the press wrote the
   * lane and the names down synchronously, before the verb, which is the whole reason that record
   * exists. A result whose key names no record is left alone — it belongs to a surface this build
   * cannot speak for, and inventing a lane for it would settle the wrong message.
   */
  useEffect(() => {
    let cancelled = false;
    let running = false;
    /**
     * WHEN TO PULL, and a once-at-mount pull is the wrong answer — measured.
     *
     * The boot replay is asynchronous: the mount happens first and the result lands afterwards,
     * so a single pass at mount finds an empty `lateResults` and the settlement is never
     * collected. The trigger is therefore the engine's own notification, narrowed to the EDGE
     * where a `mail_send` on some lane stops being pending — which is when the replay has
     * finished with it.
     *
     * The edge is only a TRIGGER. What settles the compose is the RESULT this pull returns, never
     * the queue having emptied: a drain that produced no result for us leaves everything as it
     * was, which is the difference between "the send is over" and "nothing is queued any more".
     */
    const collect = async (): Promise<void> => {
      if (running || cancelled) return;
      running = true;
      try {
        await pass();
      } finally {
        running = false;
      }
    };
    /**
     * ASKED DIRECTLY, because the two indirect signals were both wrong and one of them silently.
     *
     * A falling edge on "a send is pending" never fires for the case this exists for: a replayed
     * entry is removed from the queue BEFORE it is dispatched, so a mount that did not issue it
     * never observes the pending state to fall from. Three pulls ran, all empty, while the answer
     * sat in the engine's map — the same ending the engine used to have, moved one layer out.
     * Pulling on every notification is the other bad option: `flushPending` takes the outbox gate
     * and can dispatch the queue, so that is a poll wearing a subscription's clothes.
     *
     * `hasLateResults()` is the exact question and it is free. `notify()` fires immediately after
     * an answer with no caller is recorded, so this collects on that notification and no other.
     */
    const off = engine.subscribe(() => {
      if (engine.hasLateResults()) void collect();
    });
    const pass = async (): Promise<void> => {
      const results = await engine.flushPending();
      if (cancelled) return;
      for (const res of results) {
        /* OWNERSHIP FIRST, BEFORE ANYTHING IS DECIDED ON IT. A key this mount owns belongs to the
           live path; because the pull already consumed it, it is HANDED OVER rather than skipped —
           skipping it is how a delivered compose came to sit `queued` for ever. */
        if (queued.current.has(res.key)) {
          absorbOwn.current(res);
          continue;
        }
        const record = recordForSendKey(res.key, Date.now(), owner.current);
        if (record === null) continue;
        /* WHICH SURFACE THIS ANSWER MAY SPEAK TO, asked ONCE because both endings below need it
           and for the same reason. The full argument is in the confirmed arm, where this test was
           written; the short form is that the record names the message it was minted for and the
           surface names what it holds now, so "different" means this answer is about a message
           this compose no longer holds and the screen must be left alone. A record with NO
           session is not a mismatch — a build or a lane that never had one is not evidence of a
           different message. */
        const speaksForScreen = !(
          record.lane === COMPOSE_SEND_KEY
          && record.session !== undefined
          && record.session !== composeSessionId(owner.current)
        );
        if (res.status === "confirmed") {
          /* THE SEND COMPLETED WHILE NOBODY WAS LISTENING. The surface bound to that message is
             told, with the row the send was delivered from, so it can end the way a live
             confirmation ends it.

             AND THE RECORD IS LEFT STANDING, which is the opposite of what `flush` does on the
             same status — measured, not chosen. Releasing here made "a reload inside the queued
             window cannot deliver the same mail twice" deliver twice: the replay had already put
             the mail out under key K, the release freed K, and the press that followed minted a
             SECOND key for a message the server had no way left to recognise. Two mails to a real
             person, from the fix meant to stop the spare draft row.

             The asymmetry is the difference between the two paths, not an oversight. `flush`
             releases because the surface that pressed is right there and clears itself in the same
             beat, so the key can go. This pass speaks for a surface it cannot see: settling is a
             message it sends, never a fact it can check. So the only durable evidence that this
             message has ALREADY GONE stays in the jar, and a press of the same message resumes K
             and is replayed rather than re-sent. A different message is unaffected — it has a
             different fingerprint, and the next press sweeps this record as spent. */

          /* ── WHICH COMPOSE THIS ANSWER IS FOR, AND THE ONE IT IS NOT ─────────────────────
             `settleCompose`'s `sentByMirror` arm CLEARS the form unconditionally — right on the
             live path, where the surface being cleared is the one that pressed. Here it is not:
             a contact's Write or a mail link re-mints the compose session and puts a DIFFERENT
             message on the same lane while the replay is still out there, and settling then wipes
             words nobody has sent. Measured — the case in the trace file read `expected '' to be
             'Wann kommt der Ofen?'` before this guard, which is a data loss the person cannot undo
             and cannot see the cause of. This pass opened that route; it closes it.

             The record names the message it was minted for; the surface names what it holds now.
             Equal means the answer is about what is on screen. Different means it is about a
             message this surface no longer holds, and the only correct action is to leave the
             screen alone — the record stays, so the message it names is still recognised if it
             comes back, and the diagnostic says so rather than the seam going quiet.

             A record with NO session is not a mismatch; it is a build or a lane that never had one
             (a reply and a forward are named by the message they answer, which no re-mint can
             change). Those settle as before: a rule that fails closed needs the state it fails
             closed ON to be distinguishable from "this shell has no such thing". */
          if (!speaksForScreen) {
            console.warn(
              "ohmail: send_settled_unbound — a send settled for a compose this surface no longer "
              + `holds (lane "${record.lane}"); the message on screen is a different one and was `
              + "left alone",
            );
            continue;
          }
          settledRef.current(record.lane, {
            kind: "mail_send", draftId: res.entityId ?? record.draftId ?? null,
          } as unknown as MailSend);
          continue;
        }
        if (res.error?.code === "send_unverified") {
          /* NOBODY KNOWS, and that is the one outcome the record must outlive — see
             `SendLock.unverified`. The row the send made for itself is bound to it here for the
             same reason `absorb` binds it: the drafts list must be able to name the message. */
          markSendLockUnverified(record.lane, record.fp, owner.current);
          if (res.entityId) {
            const names: string[] = [];
            if (record.subject !== undefined) names.push(record.subject);
            if (record.session !== undefined) names.push(`compose:${record.session}`);
            attachSendLockDraft(record.lane, names, res.entityId, owner.current);
          }
        } else if (res.status !== "queued") {
          /* ── EVERYTHING ELSE RELEASES AND REPORTS ──────────────────────────────────────────
             A settled late result ends the record it names exactly as the live press ending does:
             `confirmed` settles, `unverified` parks, everything else releases and reports.

             THE KEY IS SPENT AND NOTHING WAS DELIVERED. A replayed `mail_send` refused
             non-retryably — `send_failed`, or a typed 409 such as `mailbox_disabled` — is
             abandoned by the engine and handed back `rolled_back`; by the adapter's contract an
             answer that MIGHT have delivered is `send_unverified`, which is the arm above and is
             the one outcome the record must outlive. So there is nothing left for this record to
             protect, and leaving it standing was the whole defect: `restoredPending` reads it for
             the record's seven days, and the shell renders that as every field, Send AND Cancel
             inert under "still being sent from your last session" — for a send that is over and
             did not go. Nobody could edit the message, send it again, or discard it.

             `releaseSendLock` filters by `(lane, fp)`, so an unresolved record for a DIFFERENT
             message on the same lane is untouched.

             AND `queued` IS NOT ONE OF THESE, for the reason the live path branches on it first:
             a queued result is the ABSENCE of an answer, in the engine's own words at the
             late-result writer. The verb is back on the outbox and the hold is still true. Such a
             result reaches this loop only through the timed-out dispatch's own recorder, and
             releasing on it would free a key a request still on the wire is carrying — a second
             key for a message that may yet be delivered, which is the duplicate this whole file
             exists to prevent.

             NOTHING BEYOND THE RELEASE AND THE SENTENCE. Settling is the `confirmed` ending, and
             the row the adapter made for a press that carried none is not adopted here. */
          releaseSendLock(record.lane, record.fp, owner.current);
          /* The live path's own failure sentence, on the surface this answer is about: without it
             the composer comes back editable saying nothing, which is a message the person
             pressed Send on and no account of what happened to it. */
          if (speaksForScreen) setPhase(record.lane, phaseFor(res));
        }
      }
    };
    /* AND ONCE AT MOUNT, for the boot that finished its replay before this surface existed — the
       answer waits in `lateResults` precisely so a later reader can have it.

       GUARDED BY THE SAME QUESTION, and the guard is NOT COVERED BY A TEST — recorded here rather
       than left to be discovered, because a comment in this file is the claim under test.

       Removing the guard is GREEN across this suite, and the green has a reason: every harness
       awaits `engine.start()` before it mounts, so the replay has already emptied the outbox and
       there is nothing left for an unconditional pull to dispatch. The shipped shell does not
       await it. There, a mount can land mid-replay, and `flushPending()` DISPATCHES the queue as
       well as handing back late answers — so an unconditional pull is a second dispatch road
       beside the replay's own, on the one seam where a second road means a second mail. That is
       the property the guard defends and it is the whole reason it stays; it is not evidence, and
       nobody should read it as covered.

       (The red that prompted it was a different defect — releasing the send lock on adoption, in
       the `confirmed` arm below. That one IS measured, and it is why the release is gone.) */
    if (engine.hasLateResults()) void collect();
    return () => { cancelled = true; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

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

  /**
   * ── WHAT THIS LANE'S STATE IS, ONCE, FOR EVERY READER ──────────────────────────────────────
   *
   * `stateOf` and the refusal inside `send` are the same question, and they used to read two
   * different sources: `stateOf` consulted the durable record, `send` read `states[key]` alone.
   * The file's own comment beside that line claims `canSend` there "applies the SAME rule the
   * button's `disabled` uses" — which was false for exactly the durable half, because React
   * state starts empty on every mount and the record is what survives one. So a press that did
   * not come through the button could get past something the button enforces.
   *
   * The durable intents ride on whatever phase this answers rather than replacing it: a live
   * `sending` or `queued` must still refuse the press it is about, and an unresolved send from
   * another tab or an earlier session must still lock the message it belongs to.
   */
  const stateFor = useCallback((key: string): SendState => {
    const held = states[key];
    const unresolved = unverifiedSendIntents(key, owner.current);
    const base = held !== undefined && held.phase !== "idle"
      ? held
      : (unresolved.length > 0 ? { phase: "unverified" as const } : (held ?? IDLE));
    // Union rather than replace: `absorb` names the intent it just observed, and the record
    // holds every one this owner still has open, including sends this mount never saw.
    const named = [...(base.unresolved ?? [])];
    for (const i of unresolved) if (!named.some((x) => x.fp === i.fp)) named.push(i);
    if (named.length === 0) return base;
    // The lane's own subject rides along, because the compose surface's message cannot name
    // itself until autosave gives it a row — see `SendState.session`.
    const session = key === COMPOSE_SEND_KEY ? composeSessionId(owner.current) : null;
    return session === null ? { ...base, unresolved: named } : { ...base, unresolved: named, session };
  }, [states]);

  /**
   * EVERY IDEMPOTENCY-KEY THIS MOUNT HAS PRESSED UNDER — the discriminator for "inherited".
   *
   * A record is written by a press, so "a live record on this lane" cannot mean "a send from the
   * last session": it is also every send this session just made, and refusing those refuses the
   * resume the record exists for.
   */
  const ownKeys = useRef(new Set<string>());

  /**
   * ── THE LATCH: WHICH MESSAGE THIS COMPOSE WAS HOLDING WHEN THE SESSION BEGAN ─────────────────
   *
   * Taken when a compose session first becomes visible to this hook, and NOT re-derived while that
   * session lasts. That is the whole mechanism rather than an optimisation: at that moment the
   * buffer holds exactly what was pressed Send on, and every later read is of a buffer somebody
   * may have edited — the thing being guarded against. A hold that re-derived its own subject from
   * the edited text would unlock itself the instant it was needed, which was the first shape of
   * this and it was measured: the trace still delivered twice with the guard "working".
   *
   * PER SESSION, NOT PER SHELL MOUNT, and that correction cost a Send button that did nothing.
   * Latched once for the life of the mount, a hold taken for a restored message followed the
   * composer onto whatever came next — start a new message during the replay and it stayed held
   * after the drain, with no exit but a reload. The compose SESSION is the unit: an edit keeps it
   * (so the hold survives, as it must), while a contact's Write, a mail link or another draft
   * re-mints it (so the hold is re-derived for what is actually on screen).
   *
   * Read during render rather than in an effect, because an effect runs AFTER the first render and
   * the first render is where the compose decides whether it is editable. A hold that arrives one
   * paint late is a hold somebody can type past.
   */
  const latch = useRef<{ fp: string | null; session: string | null } | null>(null);
  {
    const live = composeSessionId(owner.current);
    if (latch.current === null || latch.current.session !== live) {
      latch.current = { fp: composeBufferFingerprint(), session: live };
    }
  }

  const send = useCallback(
    (m: MailSend, opts?: { surface?: "inline"; heldRow?: string | null }) => {
      const key = sendKeyOf(m, opts?.surface ?? "compose");
      // THE LOCK FIRST, off the ref, because it is the only check that is correct within one
      // tick. `canSend` then applies the SAME rule the button's `disabled` uses — through the
      // SAME derivation, see `stateFor` — so a caller that is not the button (a keyboard
      // shortcut, a future Reply Run step) cannot get past something the button enforces.
      if (locked.current.has(key)) return;
      /**
       * ── THE HOLD, ASKED AT THE PRESS AND NOT ONLY AT THE BUTTON ────────────────────────────
       *
       * `canSend` below reads the durable RECORD through `stateFor`. It does not read the row's
       * status, and the row's status is the only witness for a send whose row this browser never
       * learned the id of — so the surface's own `heldRowUnverified` (applied where the button is
       * rendered) refused a press the button could see while THIS door, which a keyboard shortcut
       * and every non-button caller comes through, let it past.
       *
       * `parked` refuses. `unknown` does NOT: a browser that will not let this app read its own
       * storage must still be able to send, and the key it sends under is session-only (invariant
       * S(4)). The row is written onto whatever record does exist on the way out, for the same
       * reason the `canSend` refusal below does it.
       */
      /* `opts.heldRow` IS THE INLINE REPLY'S ONLY NAME FOR A ROW. Its mutation carries no
         `draftId` — the reply's row is the adapter's — and its editor is a per-message scratch
         buffer, so this door asked about `null` and got `free` while the row the previous press
         created sat unconfirmed. The surface knows the row; it hands it in. */
      const hold = holdOf(engine, {
        lane: key,
        draftId: m.draftId ?? opts?.heldRow
          ?? (key === COMPOSE_SEND_KEY ? readComposeRow(owner.current) : null),
        session: sessionOf(key),
      }, owner.current);
      if (hold.kind === "parked") {
        attachSendLockDraft(key, sendSubjects(m, sessionOf(key)), m.draftId ?? null, owner.current);
        return;
      }

      /**
       * ── HELD FOR A SEND FROM THE LAST SESSION ────────────────────────────────────────────
       *
       * The compose came up holding a message a send is still carrying. The surface renders that
       * as a read-only form with a sentence, and this is the same refusal at the layer the wire
       * is actually reached from — a caller that is not the button (a keyboard shortcut, a future
       * Reply Run step) must not get past what the button enforces.
       *
       * It refuses the EDITED text as well as the identical one, and that is the point: an
       * identical press resumes the key through `resumeSendLock` below and is harmless, while an
       * edited one is a fingerprint mismatch, a fresh key, and a second copy at the recipient.
       * The hold is keyed on WHICH MESSAGE, so a different message never reaches this line.
       */
      if (key === COMPOSE_SEND_KEY
        && sendUnsettledFromLastSession(
          key, latch.current ?? { fp: null, session: null }, ownKeys.current,
          sendPendingInDurableOutbox(engine, key), owner.current,
        )) {
        attachSendLockDraft(key, sendSubjects(m, sessionOf(key)), m.draftId ?? null, owner.current);
        return;
      }

      if (!canSend(stateFor(key), m)) {
        /**
         * REFUSED — and the row this message has since acquired is written down on the way out.
         *
         * The record's identity does not move (that is what the session field is for), but the
         * draft row it names is a diagnostic and goes stale the moment autosave creates one: a
         * parked send recorded `draftId: null` while the account holds a row for the very
         * message nobody knows the fate of. Anybody reading the jar, or the account's Drafts
         * list, beside a refusal needs the two connected. Nothing branches on it — see
         * `attachSendLockDraft`.
         */
        attachSendLockDraft(key, sendSubjects(m, sessionOf(key)), m.draftId ?? null, owner.current);
        return;
      }

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
      const session = sessionOf(key);
      // ONE ASSEMBLY, because `sendFingerprint` hashes every attachment's contents and the resume
      // and the claim both need it — see `sendIdentity`.
      const id = sendIdentity(m, session);
      const fp = id.fp;
      /* Read HERE, at the press, from the same helper the later mount reads — see `SendLock.bfp`.
         Taken before `engine.mutate` for the same reason the claim is: what is written down has to
         describe the message that went, not the buffer as it stands some time afterwards. */
      const bufferFp = key === COMPOSE_SEND_KEY ? composeBufferFingerprint() : null;
      const subject = id.subjects[0];
      /**
       * THROUGH THE IDENTITY, not the fingerprint alone — that is what lets a record written by
       * the released 0.14.0 build be recognised. 0.14.1 changed what a fingerprint hashes, so the
       * same unchanged message computes a different one; the managed web app flips every browser
       * at once, and a browser holding an unresolved 0.14.0 record at that moment would not have
       * been recognised, would have minted a second key, and would have delivered the mail twice
       * where the first send had reached the server. `resumeSendLock` decodes such a record with
       * 0.14.0's own algebra and rewrites it in this build's shape on the way past.
       */
      const resumed = resumeSendLock(key, id, now, owner.current);
      const sendKey = resumed ?? crypto.randomUUID();
      if (!resumed) {
        claimSendLock({
          v: SEND_LOCK_FORMAT, lane: key, key: sendKey, at: now, draftId: m.draftId ?? null, fp,
          // Recorded at the press, from the mutation AS SENT — the same value `canSend` compares
          // against, so the UI and the wire cannot come to disagree about which message this is.
          ...(subject !== undefined ? { subject } : {}),
          // AND THE LANE'S SESSION BESIDE IT, unconditionally for the compose surface. The
          // subject can be re-computed to a different string later in this message's life (the
          // draft row appears); the session cannot, so it is the identity that survives the
          // window in which a duplicate delivery was reachable — see `SendLock.session`.
          ...(session !== null ? { session } : {}),
          // AND THE BUFFER'S OWN FINGERPRINT for the compose lane — the identity a mount after a
          // reload can recompute. See `SendLock.bfp`; `fp` above is not recomputable there.
          ...(key === COMPOSE_SEND_KEY && bufferFp !== null ? { bfp: bufferFp } : {}),
        }, owner.current);
      }

      ownKeys.current.add(sendKey);
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
    [engine, stateFor, setPhase, absorb, arm, sessionOf],
  );

  return useMemo(
    () => ({
      /**
       * THE DURABLE UNVERIFIED FACT OUTLIVES THE COMPONENT'S OWN PHASE — see {@link stateFor},
       * which the hook's own refusal reads through as well.
       *
       * `states` is React state and starts empty on every mount. Reopening the draft therefore
       * presented a fresh `idle` composer for a send that had come back unverified — Send live,
       * and the next press a new key for a message that may already be in somebody's inbox. The
       * record is consulted so the parked state survives the remount that used to clear it, and
       * it names WHICH messages are parked so the surface is not parked with them.
       */
      stateOf: stateFor,
      send,
      /** See {@link sendUnsettledFromLastSession} — the mount's own keys are what it excludes. */
      /** See {@link sendUnsettledFromLastSession} — the identity latched at mount is the key. */
      restoredPending: (lane: string) => lane === COMPOSE_SEND_KEY
        && sendUnsettledFromLastSession(
          lane, latch.current ?? { fp: null, session: null }, ownKeys.current,
          sendPendingInDurableOutbox(engine, lane), owner.current,
        ),
    }),
    [stateFor, send],
  );
}
