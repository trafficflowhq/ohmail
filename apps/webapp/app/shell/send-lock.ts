"use client";

/**
 * THE SEND LOCK, WHERE A LOCK BELONGS: ON DISK, NOT IN A REF.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * `useMailSend` holds `queued`, `inFlight` and `locked` in `useRef`,
 * and the file's own comment explains why `locked` had to move OUT of React state: two calls in one
 * tick each read `idle`, each minted an Idempotency-Key, and each delivered — two reservations, two
 * deliveries, to a real person. That argument is correct and it does not go far enough. **A ref
 * dies with its component.** A reload inside the queued window leaves the durable outbox to replay
 * the send under its original key (correct) while the restored composer — the scratch draft is in
 * `localStorage` and is only cleared when the UI observes a confirmation — comes up `idle`, and the
 * next press mints a SECOND key. A second key is a different key, so `idempotency_keys` cannot
 * replay it and `outbound_sends UNIQUE (account_id, idempotency_key)` cannot collapse it: the same
 * message is delivered twice to an external recipient, which is a thing this product cannot take
 * back. One press is one delivery, across a crash, is the guarantee the send path owes; nothing
 * else in this application has an outcome that cannot be rolled back.
 *
 * ── THE FIX: THE DURABLE KEY *IS* THE LOCK ──────────────────────────────────────────────────
 *
 * The Idempotency-Key is persisted with the send LANE at the moment it is minted — synchronously,
 * before the verb reaches the engine — and a press on a lane that already holds one RESUMES that
 * key instead of minting a fresh one (`OhmailEngine.mutate(m, { key })`). From there the server is
 * the authority, and it already has the right answer: `SendService.resumeExisting` replays a `sent`
 * row's stored result without re-sending, reports a `failed` one, answers `in_flight` while the
 * first attempt may still be running, and verify-by-Sent recovers a genuinely orphaned `pending`.
 * **The one thing it never does is send again.**
 *
 * So the in-memory `locked` ref stays and becomes ADVISORY: it is the only check that is correct
 * within a single tick, which is the race it was written for. This is the one that is correct
 * across a process, which is the race it was not.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * It is not a queue and it is not a retry record — the durable outbox is both of those and owns
 * the verb from the moment `mutate` is called. This holds one fact per SEND: *the key that send is
 * going out under*, with the subject and the fingerprint that say which message it was.
 *
 * A lane therefore holds at most one ordinary claim and every UNRESOLVED record it has collected.
 * That is a change from the one-per-lane rule this paragraph used to state, and the reason is that
 * the two kinds of record have different lifetimes: an ordinary claim is spent by the next press,
 * while an unresolved one is the only evidence a message may already be out there and must outlive
 * every press after it. `confirmed` and `failed` release the record for the message they settle —
 * resuming a spent key would replay the old outcome for ever, a wedged Send button rather than a
 * duplicate mail, but still wrong. `unverified` does NOT release: nobody knows what it did.
 *
 * Owner-keyed, wrapped, `"local"`-defaulted: the same three rules `composeDraftKey` states one file
 * over, for the same reasons. A blocked jar means the lock is only as durable as the tab, which is
 * exactly where this file found it.
 */

import type { MailSend } from "./compose";
import { storageOwner } from "./storage-owner";

/** One lane's unsettled send. `v` names the shape; an unrecognised record is ignored, not guessed. */
export interface SendLock {
  v: 1;
  /** The lane, as `sendKeyOf` derives it: `"compose"`, `"fwd:<id>"`, or a parent message id. */
  lane: string;
  /** The Idempotency-Key this lane's send is going out under. */
  key: string;
  /** Epoch ms at the mint. */
  at: number;
  /** The draft row the send names, when it has one — diagnostic, never used to choose a key. */
  draftId: string | null;
  /**
   * WHICH MESSAGE THIS SEND IS OF — {@link sendSubject}. Absent on a record written before the
   * subject existed; such a record parks nothing by subject and is read by fingerprint alone,
   * which is what it was written under.
   */
  subject?: string;
  /** {@link sendFingerprint} of the message this key was minted for. */
  fp: string;
  /**
   * TRUE once this lane's send came back UNVERIFIED — issued, answer lost, nobody knows.
   *
   * It changes what the record means. An ordinary lock is a convenience: it lets a resumed press
   * reuse a key instead of minting one. An unverified lock is the ONLY durable evidence that a
   * message may already be out there, so it outlives both of the things that discard an ordinary
   * one — the age limit, and a change of content — because discarding it is precisely how the
   * next press comes to mint a fresh key for a message that has already gone.
   */
  unverified?: boolean;
}

/**
 * WHICH MESSAGE THIS KEY BELONGS TO — the guard that stops a resumed key from swallowing a
 * DIFFERENT message, which is the worse defect a naive durable lock would introduce.
 *
 * Consider the lane alone as the identity. A compose that never autosaved has `draftId: null`,
 * so the lane `"compose"` plus a null draft id is the identity of *every* compose this browser
 * will ever write. Crash between the mint and the terminal outcome, write a NEW message, press
 * Send: the stored key is resumed, the server finds that key already reserved and replays the
 * FIRST send's stored result, the editor reads `confirmed`, clears the scratch and says "Sent."
 * — and the new message was never sent at all. A silently unsent mail is strictly worse than the
 * duplicate this file exists to prevent, so the lock is bound to the message and not just to the
 * surface.
 *
 * A cheap non-cryptographic hash (FNV-1a) over the envelope the user actually composed. It is not
 * a security control and nothing branches on a collision being impossible: a collision would mean
 * two different messages that agree on every recipient, the subject, the body, the parent and the
 * schedule, which is a message being sent twice on purpose. What it has to do is CHANGE when the
 * user changes what they wrote, and it does.
 *
 * The attachments are folded in by name, type and byte length rather than by content: hashing
 * megabytes of base64 on every press to detect an edit nobody makes silently (you cannot alter a
 * picked file in place) is a cost with no case behind it.
 */
export function sendFingerprint(m: MailSend): string {
  const addrs = (xs: ReadonlyArray<{ address: string }> | undefined): string =>
    (xs ?? []).map((a) => a.address.toLowerCase()).join(",");
  /**
   * ── EVERY FIELD THE WIRE CARRIES, AND THE TWO THAT WERE MISSING ─────────────────────────────
   *
   * This hashed `html ?? body` and left `threadId` out. Both are the same defect: a field the
   * SERVER is given that the fingerprint cannot see, so two different messages hash alike.
   *
   *  · `html ?? body` — a rich message carries BOTH, and the plain-text half is what a recipient
   *    whose client refuses HTML actually reads. It also hid the signature on a rich send: the
   *    signature is appended to `body` and to `html` (`withSignature`), so a plain-text-only
   *    change to it was invisible.
   *  · `threadId` — sent, and never hashed.
   *
   * `sendFingerprintFieldsCovered` in the test dir is the census that keeps this list equal to the
   * mutation's own fields, so a field added to the wire cannot quietly stay out of the identity.
   */
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.draftId ?? "", m.mailboxId ?? "",
    m.threadId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.body ?? "", m.html ?? "", m.sendAt ?? "",
    (m.attachments ?? []).map((a) => `${a.filename}:${a.contentType}:${a.contentBase64.length}`).join("|"),
  ].join("\u0000");
  // FNV-1a, 32-bit, unsigned, base36 — short enough to read in a jar dump and stable across builds.
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * HOW LONG A PERSISTED KEY IS STILL WORTH RESUMING.
 *
 * Seven days, and the number is chosen against the SERVER's two horizons rather than invented.
 * `idempotency_keys` expires at 24 h, so past a day a resumed key no longer replays a stored
 * RESPONSE — but `outbound_sends` is a permanent reservation and its `UNIQUE (account_id,
 * idempotency_key)` still refuses a second delivery, which is the half that matters here. Seven
 * days is therefore comfortably inside the guarantee that protects the recipient and well past any
 * window in which a person still believes the message is going.
 *
 * Past it the record is dropped: a week-old unsettled lane is wreckage, and the honest thing is to
 * let the next press be a new send rather than to resume a key whose row nobody will ever look at.
 */
export const SEND_LOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Every owner's lane key starts here. Exported so sign-out can sweep them without respelling it. */
export const SEND_LOCKS_PREFIX = "ohmail.send.locks.";

/** One key per ACCOUNT, holding every lane — see the header for why it is owner-keyed. */
export function sendLocksKey(owner: string | null = storageOwner()): string {
  return `${SEND_LOCKS_PREFIX}${owner ?? "local"}`;
}

function isLock(x: unknown): x is SendLock {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 1
    && typeof r.lane === "string" && r.lane.length > 0
    && typeof r.key === "string" && r.key.length > 0
    && typeof r.at === "number"
    && typeof r.fp === "string"
    && (r.unverified === undefined || typeof r.unverified === "boolean");
}

function load(owner: string | null = storageOwner()): SendLock[] {
  try {
    const raw = window.localStorage.getItem(sendLocksKey(owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLock) : [];
  } catch {
    return [];
  }
}

function save(rows: SendLock[], owner: string | null = storageOwner()): void {
  try {
    if (rows.length === 0) window.localStorage.removeItem(sendLocksKey(owner));
    else window.localStorage.setItem(sendLocksKey(owner), JSON.stringify(rows));
  } catch {
    /* private mode, or a full quota — the lock is as durable as the tab, exactly as before */
  }
}

/**
 * THE KEY THIS LANE'S UNSETTLED SEND OF *THIS MESSAGE* IS GOING OUT UNDER, or `null`.
 *
 * Both halves of the identity are required — see {@link sendFingerprint} for the message half and
 * why a lane alone is not enough. A record for the lane whose fingerprint does not match is a key
 * minted for a message the user has since replaced; it is DROPPED here rather than resumed, so the
 * new message gets a key of its own and the stale one stops being offered to anybody.
 *
 * The TTL is applied on READ and swept in the same pass, so an expired record can never be resumed
 * and can never accumulate. `nowMs` is injected for the same reason it is on the Screener's
 * journal: the caller's clock is the engine's clock, and a guard that reads its own is a guard
 * nobody can drive.
 */
/**
 * IS THIS RECORD STILL WORTH KEEPING? One answer, shared by every reader.
 *
 * Seven days is the right limit for wreckage — a lane nobody ever settled. An unverified send is
 * not wreckage: it is a message that may be sitting in somebody's inbox, and this record is the
 * only thing that still names the key it went under. So it does not age out.
 *
 * Shared rather than repeated because it WAS repeated, and the two copies disagreed: one exempted
 * unverified locks and the other did not, and the one that did not also persisted its own answer.
 */
function isLive(r: SendLock, nowMs: number): boolean {
  return r.unverified === true || nowMs - r.at <= SEND_LOCK_TTL_MS;
}

export function readSendLock(lane: string, fp: string, nowMs: number, owner: string | null = storageOwner()): string | null {
  const rows = load(owner);
  if (rows.length === 0) return null;
  const live = rows.filter((r) => isLive(r, nowMs));
  /**
   * ── ONE LANE MAY HOLD SEVERAL RECORDS, AND ONLY ONE OF THEM IS ORDINARY ────────────────────
   *
   * This used to take the FIRST record for the lane and answer about it alone. That was true
   * while a lane could hold at most one record, and an unresolved send broke it: the record has
   * to outlive the next press (it is the only thing naming the key a message may already have
   * gone under), so the lane now carries the unresolved ones alongside whichever ordinary claim
   * is current. Reading by `(lane, fingerprint)` is what keeps them apart — see
   * {@link unverifiedSendIntents} for the other half.
   */
  const exact = live.find((r) => r.lane === lane && r.fp === fp);
  // A different fingerprint means the key does not name THIS content, so it cannot be resumed and
  // the record is spent — EXCEPT an unverified one, which is kept regardless. Deleting it is how
  // reopening a draft and editing it turned into a fresh key for a message that may already have
  // been delivered.
  const kept = live.filter((r) => !(r.lane === lane && r.fp !== fp && r.unverified !== true));
  if (kept.length !== rows.length) save(kept, owner);
  return exact?.key ?? null;
}

/**
 * CLAIM A LANE UNDER A KEY — synchronous, and it must complete BEFORE the verb is expressed.
 *
 * That order is the whole guarantee. A key written after `engine.mutate` returns would leave the
 * exact window this file exists to close: a process killed between the POST and the write comes
 * back with the mail possibly sent and no record of the key it went under.
 */
export function claimSendLock(lock: SendLock, owner: string | null = storageOwner()): void {
  /**
   * IT EVICTS THE LANE'S ORDINARY CLAIM AND NOTHING ELSE.
   *
   * This filtered on the lane alone, which deleted an UNRESOLVED record the moment anybody
   * pressed Send on that surface again — the record whose entire job is to outlive that press.
   * The lane keeps at most one ordinary claim (a fresh press replaces it, exactly as before) and
   * every unresolved record it has, minus any that names this same message: that one IS this
   * claim, and two rows for one message would answer twice about it.
   */
  const rows = load(owner).filter((r) => r.lane !== lock.lane
    ? true
    : r.unverified === true && r.fp !== lock.fp);
  rows.push(lock);
  save(rows, owner);
}

/**
 * Release ONE MESSAGE's claim on a lane at a TERMINAL outcome — see the header for why `queued`
 * is not one.
 *
 * The fingerprint is required rather than optional, and that is the whole correction. A lane can
 * hold an unresolved record beside a live claim, so "release the lane" is no longer a statement
 * anybody can make: releasing everything would delete the record saying an earlier message may
 * already have been delivered, and an optional fingerprint would make that the DEFAULT for any
 * caller that did not think about it. A confirmed or failed outcome for the message named here
 * releases that message's record — including its unresolved one, because an outcome the session
 * has now observed is no longer unknown — and leaves every other record on the lane alone.
 */
export function releaseSendLock(lane: string, fp: string, owner: string | null = storageOwner()): void {
  const rows = load(owner);
  const kept = rows.filter((r) => !(r.lane === lane && r.fp === fp));
  if (kept.length !== rows.length) save(kept, owner);
}

/**
 * Every live claim, oldest first — for a restart's adoption pass.
 *
 * IT SHARES `isLive` WITH `readSendLock`, and that is the point of the helper. This filtered on
 * the age limit ALONE while its sibling exempted unverified locks from it, and it PERSISTS what
 * it filters — so the first caller anybody wrote would, seven days on, delete the one record
 * saying a message may already have been delivered. `unverifiedSendLock` would then answer false,
 * the composer would come back live, and the next press would mint a fresh key.
 *
 * There is no such caller today, which is exactly what makes it worth fixing rather than leaving:
 * an unreachable half of a pair is a trap for whoever reaches it, and this one had a docblock
 * inviting them to.
 */
export function allSendLocks(nowMs: number, owner: string | null = storageOwner()): SendLock[] {
  const rows = load(owner);
  if (rows.length === 0) return [];
  const live = rows.filter((r) => isLive(r, nowMs));
  if (live.length !== rows.length) save(live, owner);
  return live.slice().sort((a, b) => a.at - b.at);
}

/**
 * WHICH MESSAGE AN UNRESOLVED SEND BELONGS TO — the identity a lock is scoped to.
 *
 * Both halves, because neither alone is an identity. The fingerprint changes the moment the
 * person edits what they wrote, and a draft that is reopened and edited is still the same
 * message — that is the case {@link readSendLock} exists for. A draft id is only an identity
 * when there IS one: an interactive compose that never autosaved carries `null`, and `null`
 * matching `null` would make every such compose the same message, which is precisely the
 * lane-only defect this file's header describes.
 */
export interface SendIntent {
  /** {@link sendSubject} of the message the key was minted for, when the record names one. */
  subject: string | undefined;
  /** {@link sendFingerprint} of the message the key was minted for. */
  fp: string;
}

/**
 * ── WHAT A SEND IS *OF* — the identity an unresolved attempt parks ───────────────────────────
 *
 * Not the fingerprint. The fingerprint changes the moment the person edits what they wrote, and an
 * edited reply is the same reply — so keying the park on it was a designed escape from the lock:
 * type one character into a reply whose outcome nobody knows, press Send, and a fresh key goes out
 * for a message that may already have been delivered.
 *
 * The subject is the thing being answered or written, which an edit does not change:
 *  · a reply — the parent message;
 *  · a forward — the message being forwarded;
 *  · a draft-backed compose — the draft row;
 *  · a new compose with no row yet — the compose session (`composeSessionId`), which lives exactly
 *    as long as the message-in-progress does. `null` here means this browser cannot name it, and
 *    that is NOT "a new message": see the fail-closed arm in `canSend`.
 *
 * The fingerprint keeps its own job, which is a different question: whether a stored key may be
 * RESUMED for the content in hand. Two messages with one subject (an edit) must not share a key;
 * one message pressed twice must.
 */
export function sendSubject(m: MailSend, session: string | null = null): string | undefined {
  if (typeof m.forwardOf === "string" && m.forwardOf.length > 0) return `fwd:${m.forwardOf}`;
  if (m.inReplyTo !== null) return `reply:${m.inReplyTo}`;
  if (m.draftId !== undefined && m.draftId !== null && m.draftId.length > 0) return `draft:${m.draftId}`;
  return session === null ? undefined : `compose:${session}`;
}

/**
 * WHICH SENDS ON THIS LANE ARE IN THE TERMINAL-UNKNOWN STATE, according to DURABLE storage.
 *
 * The composer's own phase is component state and does not survive reopening the draft, a reload,
 * or another tab — and those are exactly the paths by which a person arrives back at a send that
 * may already have gone. This is the fact that outlives all of them.
 *
 * ── IT ANSWERS *WHICH*, NOT *WHETHER*, AND THAT IS THE CORRECTION ───────────────────────────
 *
 * It used to answer a boolean about the LANE. The compose surface has one lane for every message
 * this browser will ever write, so one ambiguous delivery parked that lane for good: the surface
 * read `unverified`, `canSend` refuses `unverified`, the record is exempt from the age limit on
 * purpose, and Send and Send Later were therefore disabled for every future new message — with
 * the only exit being the reload that mints a fresh key for a message that may already be gone.
 * Naming the messages lets the uncertain one stay protected while a genuinely different message
 * sends, which is the whole of what a person needs here.
 */
export function unverifiedSendIntents(lane: string, owner: string | null = storageOwner()): SendIntent[] {
  return load(owner)
    .filter((r) => r.lane === lane && r.unverified === true)
    .map((r) => ({ subject: r.subject, fp: r.fp }));
}

/**
 * Record that ONE MESSAGE's send on this lane came back unverified. See {@link SendLock.unverified}.
 *
 * Keyed by `(lane, fingerprint)` for the same reason {@link releaseSendLock} is: the lane may hold
 * more than one record, and marking "the first one for this lane" would stamp the ambiguity onto
 * whichever message happened to be listed first.
 */
export function markSendLockUnverified(lane: string, fp: string, owner: string | null = storageOwner()): void {
  const rows = load(owner);
  const found = rows.find((r) => r.lane === lane && r.fp === fp);
  if (!found || found.unverified === true) return;
  save(rows.map((r) => (r === found ? { ...r, unverified: true } : r)), owner);
}
