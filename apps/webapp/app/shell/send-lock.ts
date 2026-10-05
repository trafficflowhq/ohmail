"use client";

/**
 * The durable send lock. One press is one delivery, across a crash: the in-memory `locked` ref in
 * `useMailSend` dies with its component, so a reload inside the queued window left the outbox replaying
 * the send under its original key while the restored composer came up `idle` — the next press minted a
 * second Idempotency-Key, a second delivery nothing server-side could collapse. So the key is persisted
 * with the send lane the moment it is minted, before the verb reaches the engine, and a press on a lane
 * holding one resumes it (`OhmailEngine.mutate(m, { key })`): the server replays, reports or recovers,
 * and never sends again. The ref stays as the within-one-tick check. This is not a queue or a retry
 * record — the durable outbox is both; this holds one fact per send: the key, and the message's names.
 */

/**
 * Invariant S. A message-in-progress is named by its compose session while unsaved and by its row id
 * once saved; the record carries every name it has acquired. (1) The account holds at most one `drafts`
 * row with its content. (2) A row past `draft`, or one carrying a send record, is never PUT to, never
 * DELETEd by this client, never recovered into a fresh key. (3) An unconfirmed send is parked under the
 * message's names: a press resumes the same Idempotency-Key or is refused; unchanged content never
 * mints a second key while a record exists. (4) One predicate answers the hold — {@link holdOf}; every
 * write site calls it and a census pins the per-file call-site count, so a route a review finds is a
 * missing call, never a second predicate. An unreadable jar answers unknown; an empty jar admits.
 */

/**
 * Invariant T. A compose is bound to at most one message; when that message's fate resolves — the
 * mirror shows its row `sent`, the server answers 409 `send_recorded` to a discard, the durable outbox
 * settles a `mail_send` for the compose's lane — the compose adopts the resolving row or clears exactly
 * as the live confirmed path clears. It is never left populated with delivered text behind an `idle`
 * projection that would admit a fresh key. One function answers the fate: `settleCompose(fate)` in
 * `compose-autosave.ts`; every site that releases, adopts or clears on a fate goes through it. A door
 * that merely replaces the message on screen (reopen, Write-to, a mail link) is an identity move, not a
 * fate, and keeps its own release. The census pins both lists.
 */

/**
 * Record lifetimes, and the two decisions that live here rather than in a caller. A lane holds at most
 * one ordinary claim plus every unresolved record: `confirmed` and `failed` release the record for the
 * message they settle; `unverified` does not — nobody knows what it did. A record resumes across
 * sessions only when unresolved (`r.session === id.session` or `r.unverified === true`): an ordinary
 * claim belongs to the session it was pressed in, an unresolved one is the only evidence a message may
 * already be out. `unknown` admits the press — a browser that blocks storage must still send — and
 * refuses every recovery: no discard, no re-mint, no adopting a row on evidence it does not have.
 * Owner-keyed, wrapped, `"local"`-defaulted: the same three rules as `composeDraftKey`.
 */

import type { MailSend } from "./compose";
import { sendFingerprint } from "@ohmail/client-engine/send-fingerprint";
import { durableRemove, durableSet, type DurableWrite } from "./durable";
import { storageOwner } from "./storage-owner";

/**
 * The record shape this build writes. `1` and `2` were 0.14.0 and 0.14.1, retired at {@link load};
 * the next change to the fingerprint or the field set bumps this. Higher values are records from a
 * build this one has never seen: carried, never rewritten or deleted, and resumed only where their
 * fingerprint equals this build's own — a rolled-back install must not eat a newer one's evidence.
 */
export const SEND_LOCK_FORMAT = 3;

/**
 * THE FORMATS 0.14.0 AND 0.14.1 WROTE, retired — a literal, never `SEND_LOCK_FORMAT - 1`, which would
 * move with the format. Their records are dropped at {@link load}, and so is the nameless `v: 3`
 * record the 0.14.0 rewrite made: a send eleven releases old is not one anybody is waiting on.
 */
const LAST_RETIRED_FORMAT = 2;

/** One lane's unsettled send. `v` names the shape; an unrecognised record is carried, not guessed. */
export interface SendLock {
  /** {@link SEND_LOCK_FORMAT} at the moment it was written. */
  v: number;
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
  /**
   * The compose session this send was pressed in — the second identity. `subject` alone is not stable
   * across one message's life: unsaved it is `compose:<session>`, after the first autosave
   * {@link sendSubject} prefers the row and names it `draft:<id>`, so a record written before the row
   * existed parked nothing once the row appeared and a press re-minted a key for delivered mail. The
   * session id is minted beside the scratch draft and cleared with it (`composeSessionId`), so it
   * names the message for exactly as long as it exists. Recorded beside `subject`, not instead of it —
   * neither identity exists in every path — and {@link sendSubjects} parks when the two sets intersect.
   * Absent on records from older builds and on every lane that is not the compose surface.
   */
  session?: string;
  /** {@link sendFingerprint} of the message this key was minted for. */
  fp: string;
  /**
   * The same message as the compose buffer holds it — the identity a later mount can recompute.
   * {@link fp} is the mutation as sent: the press folds in the signature (`withSignature`) and the
   * resolved sending mailbox, neither of which is in the scratch buffer, so comparing the buffer
   * against `fp` matches only for an account with no signature — a guard that silently does not guard.
   * The press therefore records the buffer's own fingerprint beside the sent one, computed by the one
   * helper the later mount uses (`composeBufferFingerprint`) — one function, two moments, so the two
   * values cannot drift. Compose lane only; a record written before this field simply never latches.
   */
  bfp?: string;
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
 * Which message this key belongs to — the shared fingerprint, so the web lock and the adapter's
 * resume decision can never hash one message two ways. See `@ohmail/client-engine/send-fingerprint`.
 */
export { sendFingerprint };

/**
 * How long a persisted key is still worth resuming. Seven days, chosen against the SERVER's horizons:
 * `idempotency_keys` expires at 24 h, so past a day a resumed key no longer replays a stored RESPONSE — but
 * `outbound_sends` is a permanent reservation whose `UNIQUE (account_id, idempotency_key)` still refuses a second
 * delivery, the half that matters. Seven days is comfortably inside the guarantee protecting the recipient and well
 * past any window in which a person still believes the message is going. The key is no longer the whole protection:
 * it is keyed on something the CLIENT holds, so it defends nothing once the client loses it (a reinstall, a cleared
 * jar, a second device). The server now also claims the message's CONTENT for an hour, independent of any key,
 * refusing an identical second send as `duplicate_send`.
 */

/**
 * This record still earns its place: within the hour it turns a refusal into a REPLAY of the original outcome, and
 * past the hour it is the only thing that still resumes. Past the TTL the record is dropped: a week-old unsettled
 * lane is wreckage, and the honest thing is to let the next press be a new send.
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
  // THE FOUR FIELDS THAT MAKE A CLAIM A CLAIM, required at every version: which lane, which key,
  // when, and how to read the rest.
  if (typeof r.v !== "number" || !Number.isInteger(r.v) || r.v < 1) return false;
  if (typeof r.lane !== "string" || r.lane.length === 0) return false;
  if (typeof r.key !== "string" || r.key.length === 0) return false;
  if (typeof r.at !== "number") return false;
  /**
   * A RECORD FROM A FORMAT THIS BUILD DOES NOT KNOW IS CARRIED, NOT PARSED.
   *
   * Everything below is this build's field set, and a later shape is free to have moved any of
   * it. Refusing such a record here would DELETE it — `load` drops what it cannot recognise and
   * every writer saves the filtered list back — and deleting a newer install's record is how a
   * downgrade loses the only evidence that a message may already have been delivered. Nothing
   * else is read off a higher-version record: it is never rewritten or released, and it is resumed
   * only by a fingerprint equal to this build's own for its lane — the same key, never a second.
   */
  if (r.v > SEND_LOCK_FORMAT) return true;
  return typeof r.fp === "string"
    && (r.subject === undefined || typeof r.subject === "string")
    && (r.session === undefined || typeof r.session === "string")
    && (r.unverified === undefined || typeof r.unverified === "boolean");
}

/**
 * THE RETIRED RECORDS ARE DROPPED HERE, once, and the jar is saved without them: every `v` at or below
 * {@link LAST_RETIRED_FORMAT}, and a `v: 3` record naming nothing (no `subject`, no `session`) — the shape
 * the old 0.14.0 rewrite made, whose fingerprint is in an algebra this build no longer computes. A record
 * this build or a later one wrote is untouched.
 */
/**
 * `null` is not `[]`, and collapsing them was a fail-open. This returned `[]` for everything its `catch` swallowed,
 * so a browser refusing this app its own storage — a private window, site data blocked — read as "a browser with no
 * unresolved sends": the reopen took the recovery door, the autosave minted a row, the settled discard deleted one,
 * each decided on evidence never obtained. `null` = the jar could not be read; `[]` = the jar was read and holds
 * nothing. {@link holdOf} maps the first to `unknown` and every recovery fails closed on it, while the press is still
 * admitted (invariant S(4)). Only a THROWN accessor is `null`: content that will not parse is a readable jar holding
 * garbage — the next write replaces it — whereas `unknown` there would park the composer permanently with no exit; so
 * a `JSON.parse` failure keeps `[]`.
 */

function load(owner: string | null = storageOwner()): SendLock[] | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(sendLocksKey(owner));
  } catch {
    return null;
  }
  try {
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: SendLock[] = parsed.filter(isLock);
    const out = rows.filter((r) => !retired(r));
    if (out.length !== rows.length) save(out, owner);
    return out;
  } catch {
    return [];
  }
}

/** What the jar holds, with an unreadable jar read as empty — for the readers that admit on it. */
function loadOrEmpty(owner: string | null = storageOwner()): SendLock[] {
  return load(owner) ?? [];
}

/**
 * ── AND A LOCK THAT DID NOT REACH THE JAR SAYS SO ───────────────────────────────────────────
 *
 * This swallowed its own refusal, so in a private window the claim was as durable as the tab
 * while every reader above still spoke as though a record had been written. The verdict is
 * returned for the same reason the Screener's journal returns one, and `durable.ts` raises the
 * shell's once-per-session notice: the press is still admitted — a browser with no jar must
 * not lose the ability to send — but nobody is told a key is held across a reload when it is not.
 */
function save(rows: SendLock[], owner: string | null = storageOwner()): DurableWrite {
  const key = sendLocksKey(owner);
  return rows.length === 0
    ? durableRemove(key, "send.locks")
    : durableSet(key, JSON.stringify(rows), "send.locks");
}

/**
 * THE KEY THIS LANE'S UNSETTLED SEND OF *THIS MESSAGE* IS GOING OUT UNDER, or `null`. Both halves of the identity are
 * required — see {@link sendFingerprint} for the message half and why a lane alone is not enough. A record for the
 * lane whose fingerprint does not match is a key minted for a message the user has since replaced; it is DROPPED here
 * rather than resumed, so the new message gets a key of its own and the stale one stops being offered to anybody. The
 * TTL is applied on READ and swept in the same pass, so an expired record can never be resumed and can never
 * accumulate. `nowMs` is injected for the same reason it is on the Screener's journal: the caller's clock is the
 * engine's clock, and a guard that reads its own is a guard nobody can drive.
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
  /**
   * A RECORD FROM A LATER FORMAT IS NOT AGED OUT, and this arm is why the answer is not simply the two below it. `at`
   * is the only field of a newer shape this build may read, and the age limit acts on the FILTERED list: both readers
   * persist what they keep, so a downgrade that ran eight days after a newer install left an unresolved record would
   * have deleted the one thing naming the key that send went under — and re-upgrading would then mint a fresh key for
   * a message that may already have been delivered. `unverified` cannot answer for such a record either: the flag
   * means whatever the build that wrote it decided, so reading it is a guess. The record is carried, as everywhere
   * else in this file.
   */
  if (r.v > SEND_LOCK_FORMAT) return true;
  return r.unverified === true || nowMs - r.at <= SEND_LOCK_TTL_MS;
}

/**
 * A SEND RECORD IS NEVER DELETED WHILE ITS KEY IS OWED: the outbox has not been read yet, or the key is
 * on the outbox, the queue, the wire, or an uncollected late answer. Only that send's ending can still
 * reach its surface, and the record is what turns the ending back into a message. An owed record
 * outlives every sweep. One that is not owed may go when its send ENDED, when a newer record on its
 * lane REPLACES it, or when it AGED past {@link SEND_LOCK_TTL_MS}. Age keeps one other job: whether a
 * new press may resume, join or be held. {@link dropSendLocks} is the only save that shrinks the jar.
 */
export type SendLockOwed = (key: string) => boolean;

/** Why a caller asks a record to go — see {@link SendLockOwed}. */
export type SendLockDrop = "ended" | "replaced" | "aged";

function mayDrop(r: SendLock, why: SendLockDrop, owed: SendLockOwed, nowMs: number): boolean {
  // A later format's record is carried, never deleted: this build cannot read what it means.
  if (r.v > SEND_LOCK_FORMAT || owed(r.key)) return false;
  return why === "aged" ? !isLive(r, nowMs) : true;
}

/**
 * THE DOOR: reads the jar itself, so no caller can hand it a list it already shortened. `doomed`
 * names why a record should go (or `null`); `add` is a claim written in the same save. Returns
 * what the jar holds afterwards.
 */
function dropSendLocks(
  doomed: (r: SendLock) => SendLockDrop | null, owed: SendLockOwed, nowMs: number,
  owner: string | null, add: SendLock | null = null,
): SendLock[] {
  const rows = loadOrEmpty(owner);
  const kept = rows.filter((r) => {
    const why = doomed(r);
    return why === null || !mayDrop(r, why, owed, nowMs);
  });
  if (add !== null) kept.push(add);
  if (add !== null || kept.length !== rows.length) save(kept, owner);
  return kept;
}

export function resumeSendLock(
  lane: string,
  id: SendIdentity,
  nowMs: number,
  owed: SendLockOwed,
  owner: string | null = storageOwner(),
): string | null {
  const rows = load(owner);
  // AN UNREADABLE JAR RESUMES NOTHING and mints nothing: the press goes out under a fresh
  // session-only key, which is the admit arm of invariant S(4). It also writes nothing back —
  // `save` no-ops on the same refusal — so the sweep below cannot delete evidence it never read.
  if (rows === null) return null;
  if (rows.length === 0) return null;
  const live = rows.filter((r) => isLive(r, nowMs));
  /**
   * ONE LANE MAY HOLD SEVERAL RECORDS, AND ONLY ONE OF THEM IS ORDINARY: This used to take the FIRST record for the
   * lane and answer about it alone. That was true while a lane could hold at most one record, and an unresolved send
   * broke it: the record has to outlive the next press (it is the only thing naming the key a message may already
   * have gone under), so the lane now carries the unresolved ones alongside whichever ordinary claim is current.
   * Reading by `(lane, fingerprint)` is what keeps them apart — see {@link unverifiedSendIntents} for the other half.
   * ONE COMPARISON, IN THIS BUILD'S ALGEBRA: the retired formats never reach a reader — {@link load} drops them.
   */

  /**
   * That record is then exempt from the spent-record sweep below (it is `unverified`), it parks its own message at
   * the surface, and it is not offered here to any message at all.
   */
  /**
   * A RECORD RESUMES ACROSS SESSIONS ONLY WHEN IT IS UNRESOLVED — invariant S, decision 1: An ordinary claim belongs
   * to the message-in-progress it was pressed in. The compose lane is one lane for every message this browser will
   * ever write, so a claim left behind by a message that was replaced (a new compose, a mail link, a contact's Write
   * — each of which re-mints the session) would otherwise be handed to whatever is on screen next, and the server
   * replays the FIRST send's stored result at it: "Sent." about a message that never left. An UNRESOLVED record is
   * the opposite case and keeps resuming regardless of session: it is the only thing naming the key a message may
   * already have gone under, and refusing to resume it is precisely how the next press mints a fresh one for mail
   * that is already delivered.
   */

  /**
   * A record with no session of its own (a reply, a forward) is not scoped by this: it is named by
   * the message it answers, which no session can change.
   */
  const sessionAdmits = (r: SendLock): boolean =>
    r.unverified === true || r.session === undefined || id.session === null
    || r.session === id.session;
  const found = live.find(
    (r) => r.lane === lane && r.fp === id.fp && sessionAdmits(r),
  );
  // A different fingerprint means the key does not name THIS content, so it cannot be resumed and
  // the record is spent — EXCEPT an unverified one, which is kept regardless. Deleting it is how
  // reopening a draft and editing it turned into a fresh key for a message that may already have
  // been delivered. A record from a LATER format is exempt too: this build cannot read what its
  // fingerprint means, and a downgrade must not delete a newer install's evidence.
  dropSendLocks((r) => (
    r.lane === lane && r.fp !== id.fp && r.unverified !== true ? "replaced" : "aged"
  ), owed, nowMs, owner);
  return found?.key ?? null;
}

/** A record {@link load} drops — see its note. */
function retired(r: SendLock): boolean {
  return r.v <= LAST_RETIRED_FORMAT
    || (r.v === SEND_LOCK_FORMAT && r.subject === undefined && r.session === undefined);
}

/**
 * WHAT ONE MESSAGE IN HAND IS, in every spelling a stored record could be using.
 *
 * Assembled once per press rather than recomputed at each comparison: `sendFingerprint` hashes
 * every attachment's contents, and asking for it twice would put the bytes through a hash twice.
 */
export interface SendIdentity {
  /** {@link sendFingerprint} — this build's algebra. */
  fp: string;
  /** {@link sendSubjects} — every name the message answers to. */
  subjects: ReadonlyArray<string>;
  /** The compose session the press is in, or `null` off the compose lane. */
  session: string | null;
  /** The draft row the message carries, when it has one. */
  draftId: string | null;
}

export function sendIdentity(m: MailSend, session: string | null = null): SendIdentity {
  return {
    fp: sendFingerprint(m),
    subjects: sendSubjects(m, session),
    session,
    draftId: m.draftId ?? null,
  };
}

/**
 * THE KEY FOR A FINGERPRINT ALONE — the door for a caller that has no message. Every production press
 * goes through {@link resumeSendLock} with a real identity.
 */
export function readSendLock(
  lane: string, fp: string, nowMs: number, owed: SendLockOwed, owner: string | null = storageOwner(),
): string | null {
  return resumeSendLock(lane, {
    fp, subjects: [], session: null, draftId: null,
  }, nowMs, owed, owner);
}

/**
 * CLAIM A LANE UNDER A KEY — synchronous, and it must complete BEFORE the verb is expressed.
 *
 * That order is the whole guarantee. A key written after `engine.mutate` returns would leave the
 * exact window this file exists to close: a process killed between the POST and the write comes
 * back with the mail possibly sent and no record of the key it went under.
 */
export function claimSendLock(lock: SendLock, owed: SendLockOwed, owner: string | null = storageOwner()): void {
  /**
   * IT EVICTS THE LANE'S ORDINARY CLAIM AND NOTHING ELSE.
   *
   * This filtered on the lane alone, which deleted an UNRESOLVED record the moment anybody
   * pressed Send on that surface again — the record whose entire job is to outlive that press.
   * The lane keeps at most one ordinary claim (a fresh press replaces it, exactly as before) and
   * every unresolved record it has, minus any that names this same message: that one IS this
   * claim, and two rows for one message would answer twice about it.
   */
  // AN UNREADABLE JAR IS EMPTY HERE ON PURPOSE: there is nothing to evict, and a jar that then
  // refuses the write leaves the claim as durable as the tab — exactly what it was before this
  // file existed. What has changed is that the refusal is no longer silent: `save` answers, and
  // the shell says once that this browser is not keeping decisions between reloads.
  // A record from a LATER format is not this build's to evict: the door keeps it.
  const replaced = (r: SendLock): SendLockDrop | null => (
    r.lane === lock.lane && !(r.unverified === true && r.fp !== lock.fp) ? "replaced" : null);
  /**
   * THE VERSION IS STAMPED HERE, not taken from the caller.
   *
   * A caller can never legitimately write an older shape, and `v` is what every later reader
   * branches on — the retirement at {@link load} among them, which must never fire on a record this
   * build wrote. Leaving the number in the caller's hands made it a literal at the one call site that
   * had to be remembered on every format change, and 0.14.1 forgot it.
   */
  dropSendLocks(replaced, owed, lock.at, owner, { ...lock, v: SEND_LOCK_FORMAT });
}

/**
 * Release ONE MESSAGE's claim on a lane at a TERMINAL outcome — see the header for why `queued` is not one. The
 * fingerprint is required rather than optional, and that is the whole correction. A lane can hold an unresolved
 * record beside a live claim, so "release the lane" is no longer a statement anybody can make: releasing everything
 * would delete the record saying an earlier message may already have been delivered, and an optional fingerprint
 * would make that the DEFAULT for any caller that did not think about it. A confirmed or failed outcome for the
 * message named here releases that message's record — including its unresolved one, because an outcome the session
 * has now observed is no longer unknown — and leaves every other record on the lane alone.
 */
export function releaseSendLock(
  lane: string, fp: string, owed: SendLockOwed, owner: string | null = storageOwner(),
): void {
  // Nothing read, nothing to release — and nothing written, so an unreadable jar cannot lose a
  // record it never handed over.
  dropSendLocks((r) => (r.lane === lane && r.fp === fp ? "ended" : null), owed, Date.now(), owner);
}

/**
 * Every live claim, oldest first — for a restart's adoption pass. IT SHARES `isLive` WITH `readSendLock`, and that is
 * the point of the helper. This filtered on the age limit ALONE while its sibling exempted unverified locks from it,
 * and it PERSISTS what it filters — so the first caller anybody wrote would, seven days on, delete the one record
 * saying a message may already have been delivered. `unverifiedSendLock` would then answer false, the composer would
 * come back live, and the next press would mint a fresh key. There is no such caller today, which is exactly what
 * makes it worth fixing rather than leaving: an unreachable half of a pair is a trap for whoever reaches it, and this
 * one had a docblock inviting them to.
 */
export function allSendLocks(
  nowMs: number,
  /** Which keys may still produce an ending — see {@link SendLockOwed}. An owed record is kept and returned. */
  owed: SendLockOwed,
  owner: string | null = storageOwner(),
): SendLock[] {
  const live = dropSendLocks(() => "aged", owed, nowMs, owner);
  // RETURNED, not stored: a record from a later format stays in the jar and stays out of this
  // list, because a caller reading fields off it would be reading a shape this build never wrote.
  return live.filter((r) => r.v <= SEND_LOCK_FORMAT).sort((a, b) => a.at - b.at);
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
  /**
   * EVERY IDENTITY the message this key was minted for answers to — {@link sendSubjects}. A list rather than one
   * string, because one message-in-progress carries more than one name and acquires them at different moments. A
   * compose is `compose:<session>` from the first press and becomes `draft:<id>` as well the moment autosave gives it
   * a row; a draft reopened after the session was cleared has only the row. Comparing ONE name against ONE name meant
   * a message whose row appeared between two presses read as a different message and sent twice. EMPTY means this
   * browser could not name the message at all — no row, no session (a jar it cannot write, a state built by hand). It
   * is not evidence of a different message, so the reader fails closed on it, and the fingerprint is the only
   * comparison left.
   */
  subjects: ReadonlyArray<string>;
  /** {@link sendFingerprint} of the message the key was minted for. */
  fp: string;
  /**
   * {@link SendLock.bfp} — the COMPOSE BUFFER's fingerprint at the press, when the record carries
   * one. It is the only name that survives a reload, so it is what a restored surface compares
   * against to ask whether an unresolved intent is about the message on screen. Absent on a record
   * the shipped previous build wrote, and a caller that cannot show the intent names its message
   * must fail closed rather than treat "no evidence" as "not mine".
   */
  bfp?: string;
}

/**
 * WHAT A SEND IS *OF* — the identity an unresolved attempt parks: Not the fingerprint. The fingerprint changes the
 * moment the person edits what they wrote, and an edited reply is the same reply — so keying the park on it was a
 * designed escape from the lock: type one character into a reply whose outcome nobody knows, press Send, and a fresh
 * key goes out for a message that may already have been delivered. The subject is the thing being answered or
 * written, which an edit does not change:
 * · a reply — the parent message;
 * · a forward — the message being forwarded;
 * · a draft-backed compose — the draft row;
 */

/**
 * · a new compose with no row yet — the compose session (`composeSessionId`), which lives exactly as long as the
 *   message-in-progress does. `null` here means this browser cannot name it, and that is NOT "a new message": see the
 *   fail-closed arm in `canSend`.
 * The fingerprint keeps its own job, which is a different question: whether a stored key may be RESUMED for the
 * content in hand. Two messages with one subject (an edit) must not share a key; one message pressed twice must.
 */
/**
 * Every name this message answers to, most specific first — the identity a park compares. A set,
 * measured: {@link sendSubject} returns ONE name and prefers the draft row over the compose
 * session — right for what to WRITE, wrong for what to COMPARE, because the row appears part-way
 * through a message's life: a compose pressed with no row is recorded as `compose:<session>`,
 * autosave then creates a row, and the next press of the SAME UNEDITED message computes
 * `draft:<id>` — no match, nothing parked. On a send the server could not confirm that is a
 * second delivery: the surface presented `idle`, the press minted a second key, and the
 * recipient held two copies while the sender's Sent folder held one.
 */

/**
 * The two names are not redundant and neither is available everywhere: a compose that never
 * autosaved has a session and no row; a draft reopened after the session was cleared has a row
 * and a NEW session; a row autosave replaces changes `draft:<id>` under one unchanged session.
 * So both are collected, and a record parks a message when the record's set and the message's
 * set INTERSECT. A reply and a forward are named by the message they answer — which nothing can
 * change under them — so they answer to exactly one name and the session is not consulted.
 * EMPTY means this browser can name the message by nothing at all (no row, no session — a jar
 * it cannot write); callers read that as "unnameable", never as "a new message".
 */
export function sendSubjects(m: MailSend, session: string | null = null): string[] {
  if (typeof m.forwardOf === "string" && m.forwardOf.length > 0) return [`fwd:${m.forwardOf}`];
  if (m.inReplyTo !== null) return [`reply:${m.inReplyTo}`];
  const out: string[] = [];
  if (m.draftId !== undefined && m.draftId !== null && m.draftId.length > 0) out.push(`draft:${m.draftId}`);
  if (session !== null) out.push(`compose:${session}`);
  return out;
}

/**
 * THE ONE NAME A RECORD IS WRITTEN UNDER — the first of {@link sendSubjects}, unchanged.
 *
 * The record keeps a single `subject` for the shape it has always had, and carries the session
 * beside it in {@link SendLock.session}. Reading is what needs the whole set.
 */
export function sendSubject(m: MailSend, session: string | null = null): string | undefined {
  return sendSubjects(m, session)[0];
}

/**
 * EVERY NAME A STORED RECORD ANSWERS TO — the reading half of {@link sendSubjects}.
 *
 * The record's own `subject` plus the compose session it was pressed in. Both, for the same
 * reason the message side collects both: the record was written at one moment in the message's
 * life and is read at another, and whichever name the two moments have in common is the one that
 * has to decide.
 */
function lockSubjects(r: SendLock): string[] {
  const out: string[] = [];
  if (r.subject !== undefined) out.push(r.subject);
  const fromSession = r.session === undefined ? null : `compose:${r.session}`;
  if (fromSession !== null && !out.includes(fromSession)) out.push(fromSession);
  return out;
}

/**
 * WHICH SENDS ON THIS LANE ARE IN THE TERMINAL-UNKNOWN STATE, according to DURABLE storage. The composer's own phase
 * is component state and does not survive reopening the draft, a reload, or another tab — and those are exactly the
 * paths by which a person arrives back at a send that may already have gone. This is the fact that outlives all of
 * them. IT ANSWERS *WHICH*, NOT *WHETHER*, AND THAT IS THE CORRECTION: It used to answer a boolean about the LANE.
 * The compose surface has one lane for every message this browser will ever write, so one ambiguous delivery parked
 * that lane for good: the surface read `unverified`, `canSend` refuses `unverified`, the record is exempt from the
 * age limit on purpose, and Send and Send Later were therefore disabled for every future new message — with the only
 * exit being the reload that mints a fresh key for a message that may already be gone.
 */

/**
 * Naming the messages lets the uncertain one stay protected while a genuinely different message sends, which is the
 * whole of what a person needs here.
 */
export function unverifiedSendIntents(lane: string, owner: string | null = storageOwner()): SendIntent[] {
  // EMPTY on an unreadable jar, and that is the ADMIT arm of invariant S(4) rather than an
  // oversight: this feeds `canSend`, and a browser that will not let this app keep a record must
  // still be able to send. The recovery sites fail closed instead, through {@link holdOf}.
  return loadOrEmpty(owner)
    /**
     * A LATER FORMAT'S RECORD IS NOT INTERPRETED HERE, and it is not deleted either.
     *
     * Its `fp` and its names mean whatever the build that wrote it decided, so reading them would
     * be a guess dressed as a fact — and a wrong name here is a park on the wrong message. It
     * stays in the jar untouched (`isLock` carries it, every writer preserves it), which is the
     * protection that matters: the build that wrote it reads it correctly the moment the install
     * is upgraded back. A downgrade in the window shows no park for that one message.
     */
    .filter((r) => r.lane === lane && r.unverified === true && r.v <= SEND_LOCK_FORMAT)
    .map((r) => ({
      subjects: lockSubjects(r), fp: r.fp,
      ...(r.bfp === undefined ? {} : { bfp: r.bfp }),
    }));
}

/**
 * Is this compose a message we are still waiting to learn the fate of? THE one guard, one function because it was
 * measured failing in two places that had to agree and did not — both moments where this browser decides whether the
 * message in front of it is NEW: reopening a draft from the list (`openDraft`, asked with the row and no session —
 * the session at that moment is the one being left behind, and every draft would answer to it), and coming back after
 * a reload (`useComposeAutosave`'s adoption, asked with row AND session — a send pressed before autosave wrote
 * anything is named by the session alone). Answering `true` means: do not mint a row, do not start a new session, do
 * not treat it as recovered — it is the message the record names, it is parked, and the surface says so.
 */

/**
 * What went wrong when the two sites did not share it — measured end to end, twice, one recipient holding two copies
 * each time. The reopen minted a row and re-minted the session, so neither name the record carried was on the message
 * any more; and earlier, the reload alone: the adoption found the row moved past `draft`, dropped it, and let the
 * next pause create a fresh one — two rows for one message before anything was reopened. A row is matched by either
 * name a record can carry it under: the subject it was minted with (`draft:<id>`) and the row it ACQUIRED afterwards
 * ({@link attachSendLockDraft}); when the row moves they disagree, and the row still in the drafts list is the one
 * named by the subject — that reading is {@link unresolvedSendRows}, called from here rather than repeated.
 */

/**
 * A record may name NO row (`draftId: null`, `compose:<session>`), so the session arm is not a fallback: it is the
 * only name that message will ever have.
 */
export function parkedComposeMessage(
  lane: string,
  draftId: string | null,
  session: string | null,
  owner: string | null = storageOwner(),
): boolean {
  return parkedComposeRecord(lane, draftId, session, owner) !== null;
}

/** The identity a park holds a message by — {@link parkedComposeRecord}. */
export interface ParkedIdentity {
  /** The compose session the unresolved send was pressed in, when it had one. */
  session: string | null;
  /** The draft row the record names, when it has one. */
  draftId: string | null;
}

/**
 * THE SAME QUESTION, ANSWERED WITH THE NAMES — {@link parkedComposeMessage} is this, made boolean. The reopen needs
 * more than "yes": it has to put the message's identity BACK. A door in between (writing to a contact, a mail link
 * from outside) legitimately starts a new message and mints a new session, so the browser can arrive back at an
 * unconfirmed message holding neither of the names its record carries. Answering only `true` there produced a surface
 * that KNEW the message was parked and then presented it under a session the record had never heard of: no warning,
 * Send live, one press and a second copy — the same ending as the door this replaced, reached from a different
 * direction. `null` = not parked. Otherwise the record's own names, for the caller to restore.
 */
export function parkedComposeRecord(
  lane: string,
  draftId: string | null,
  session: string | null,
  owner: string | null = storageOwner(),
): ParkedIdentity | null {
  const rows = loadOrEmpty(owner)
    .filter((r) => r.lane === lane && r.unverified === true && r.v <= SEND_LOCK_FORMAT);
  if (session !== null) {
    const named = rows.find((r) => lockSubjects(r).includes(`compose:${session}`));
    if (named) return { session: named.session ?? session, draftId: named.draftId };
  }
  if (draftId === null) return null;
  // The ROW half is {@link unresolvedSendRows}, called rather than restated: the two names a row
  // is recorded under appear at different moments in one message's life, and a second reading of
  // that pair is a second chance to read only one of them.
  if (!unresolvedSendRows(lane, owner).has(draftId)) return null;
  const byRow = rows.find(
    (r) => r.draftId === draftId || lockSubjects(r).includes(`draft:${draftId}`),
  );
  return { session: byRow?.session ?? null, draftId: byRow?.draftId ?? draftId };
}

/**
 * ── THE HOLD, AS THREE ANSWERS RATHER THAN A BOOLEAN ────────────────────────────────────────
 *
 * `composeMessageHeld(parked, rowStatus) -> boolean` stood here. It carried two of the three
 * witnesses correctly and could not say the third thing a caller needs: whether it KNOWS. A
 * boolean has one place to put "no answer", and every caller put it with `false`.
 */
export type Hold =
  /** Nothing is waiting on this message. Every write site may proceed. */
  | { kind: "free" }
  /**
   * A send of this message has not been confirmed. `by` names the witness:
   * · `"record"` — the durable record this browser wrote. The only witness for a row the server still calls
   *   `draft`, and for a message with no row at all.
   * · `"status"` — the mirror says the row is past `draft`. The only witness for a row this browser never learned
   *   the id of: a press with no row makes the ADAPTER create one, that row is what the server marks, and nothing
   *   here can name it.
   */

  /**
   * `draftId`/`session` are the identity to RESTORE — a door in between (a contact's Write, a mail link) legitimately
   * mints a new session, so a caller that only learned "yes" would present the message under a session the record has
   * never heard of: no warning, Send live, one press, a second copy.
   */
  | {
      kind: "parked";
      by: "record" | "status";
      /**
       * WHAT THE MIRROR CALLS THE ROW, when `by` is `"status"` — `null` for a record park.
       *
       * Carried because one status is not like the others and a caller has to be able to tell:
       * `sent` is the server's TERMINAL CONFIRMATION, so a surface must not project it into "we
       * couldn't confirm this send". Every status past `draft` still refuses a WRITE — that is
       * invariant S(2) and it does not vary — but what the person is TOLD does.
       */
      status: string | null;
      draftId: string | null;
      session: string | null;
    }
  /**
   * NOBODY KNOWS. The jar threw on read, or the mirror cannot yet name the row this surface is
   * holding (a cold reload: the shell starts the engine in an effect and the rows arrive after).
   *
   * Not `free`. Collapsing the two is what let a private window read as "this browser has no
   * unresolved sends" and take every recovery door there is. See invariant S(4): the PRESS is
   * admitted on `unknown` (a browser that refuses storage must still send); every recovery —
   * discard, re-mint, adopt, create — fails closed.
   */
  | { kind: "unknown" };

/** The narrowest thing {@link holdOf} needs: one mirror read. Any `OhmailEngine` satisfies it. */
export interface HoldMirror {
  read(): { get<T = unknown>(type: string, id: string): T | undefined };
}

/**
 * Is this message held? The one predicate — invariant S(4). Every write site in the shell asks THIS and nothing else:
 * the autosave create, the autosave PUT, the adopt-on-mount, `openDraft`, `writeTo`, the mailto seam,
 * `cancelCompose`, the Send press, the settled discard. A census in the webapp's own suite pins the per-file
 * call-site COUNT, because a census over file membership cannot see a missing call. One function and not three,
 * because it was three (`parkedHere` in the autosave, `parkedComposeRecord` + `composeMessageHeld` at the reopen, the
 * send gate's own reading) and each of the seven fixes before this closed the duplicate route the previous one left —
 * every route the same shape: two of the three agreed a message was held and the third wrote anyway.
 */

/**
 * The three answers, and why `unknown` is not `free`. The record is asked FIRST — it speaks for a row the server
 * still calls `draft` and for a message with no row at all; the mirror's status SECOND — it speaks for the row the
 * adapter made for itself, whose id this browser is never told. `parked/status` is every status that is not `draft`
 * (`sending`, `unverified`, `sent`): it used to be `unverified` alone, so a STRANDED `sending` row (its answer never
 * arrived, its record swept) read as an ordinary draft — reopening took the recovery door and one press delivered the
 * message a second time; `sent` is in the list for the same reason and costs nothing. A row the mirror cannot NAME is
 * `unknown`, never `free`: absent and "not loaded yet" look identical through `get`, and on the path this exists for
 * — a reload — the mirror is empty at mount.
 */
export function holdOf(
  engine: HoldMirror,
  q: { lane: string; draftId: string | null; session: string | null },
  owner: string | null = storageOwner(),
): Hold {
  // THE JAR FIRST. A browser that will not answer about its own records cannot be read as a
  // browser with none — see {@link load}, which is where the two used to collapse.
  if (load(owner) === null) return { kind: "unknown" };
  const record = parkedComposeRecord(q.lane, q.draftId, q.session, owner);
  if (record !== null) {
    return {
      kind: "parked", by: "record", status: null,
      draftId: record.draftId, session: record.session,
    };
  }
  /**
   * No row is not a hold, and the sequence with no row is covered elsewhere. A compose never saved is named by its
   * session alone, and the record arm above is the only thing in the jar that can speak for it. The sequence needing
   * cover — press Send before the first autosave, lose the response, reload: the record is ORDINARY (nothing observed
   * an outcome), and while the outbox replays that send the restored surface's timer can create a second row. Parking
   * on that record was tried HERE and is wrong, proved by the suite: with no row the record's only name is the
   * compose SESSION, and a genuinely new message on the same lane answers to it too — the park refused a message
   * nobody had pressed Send on ("a DIFFERENT message written after the crash gets a key of its own", red).
   */

  /**
   * The exact discriminator is not in the jar: it is whether the durable OUTBOX still holds a `mail_send` for this
   * lane — names the actual pending verb, cannot mistake a new message for an old one, bounded by the queue draining.
   * Read where the surface already reads the engine (`sendInFlight` in `AppShell.tsx`), refusing the CREATE there.
   */
  if (q.draftId === null) return { kind: "free" };
  const row = engine.read().get<{ status?: unknown }>("draft", q.draftId);
  if (row === null || row === undefined || typeof row.status !== "string") return { kind: "unknown" };
  if (row.status !== "draft") {
    return {
      kind: "parked", by: "status", status: row.status,
      draftId: q.draftId, session: q.session,
    };
  }
  return { kind: "free" };
}

/**
 * THE SERVER SAYS THIS ROW WAS SENT, SO THE RECORD ABOUT IT IS SETTLED — release it.
 *
 * The confirmed path releases a record through {@link releaseSendLock}, keyed by the fingerprint
 * the press computed. A tab that DIED holding that answer leaves the record behind with nobody to
 * release it, and the next mount reads it as a send still owed an answer. The mirror's `sent` is
 * the server's own terminal word about that row, so it settles the record the same way — by the
 * ROW, which is the only name this path has.
 */
export function releaseSendLockForRow(
  lane: string, draftId: string, session: string | null, owed: SendLockOwed,
  owner: string | null = storageOwner(),
): void {
  // BOTH NAMES, for the reason everything else in this file reads both: the record was written at
  // one moment in the message's life and is settled at another. A press before the first autosave
  // recorded `compose:<session>` and NO row — matching on the row alone would leave exactly that
  // record behind, which is the one this path exists for.
  const names = new Set<string>([`draft:${draftId}`]);
  if (session !== null) names.add(`compose:${session}`);
  dropSendLocks((r) => (
    r.lane === lane && (r.draftId === draftId || lockSubjects(r).some((n) => names.has(n))) ? "ended" : null
  ), owed, Date.now(), owner);
}

/**
 * WHAT THE DRAFTS LIST'S DISCARD DOES WITH THE HOLD. The server is the authority on whether a send
 * is still running (`pending`, 409 by name) and admits the discard of an `unverified` row, so a hold
 * by RECORD or by `unverified`/`sent` status goes to the wire — the record is released when the
 * server confirms. Two refusals stay, each rendered in the row: a row still `sending` (the server
 * would refuse it anyway, and this saves the round trip), and a jar this browser cannot read
 * (invariant S(4): every recovery fails closed on `unknown`).
 */
export type DiscardDecision =
  | { kind: "wire" }
  | { kind: "refuse"; why: "still-sending" | "unknown-jar" };

export function discardDecision(hold: Hold): DiscardDecision {
  if (hold.kind === "unknown") return { kind: "refuse", why: "unknown-jar" };
  if (hold.kind === "parked" && hold.by === "status" && hold.status === "sending") {
    return { kind: "refuse", why: "still-sending" };
  }
  return { kind: "wire" };
}

/** `true` for every hold that is not `free` — the shape a write site's guard reads. */
export function holdRefusesWrite(hold: Hold): boolean {
  return hold.kind !== "free";
}

/**
 * ── WHICH DRAFT ROWS AN UNRESOLVED SEND ON THIS LANE BELONGS TO ─────────────────────────────
 *
 * {@link parkedComposeMessage}'s row half, and the only reading of it: both call sites in the app
 * ask the guard, the guard asks this, so the two cannot drift apart the way they did when each
 * site decided for itself. Exported on its own because a test can read a set and cannot read a
 * boolean's reasons.
 */
export function unresolvedSendRows(lane: string, owner: string | null = storageOwner()): Set<string> {
  const out = new Set<string>();
  for (const r of loadOrEmpty(owner)) {
    if (r.lane !== lane || r.unverified !== true || r.v > SEND_LOCK_FORMAT) continue;
    if (r.draftId !== null && r.draftId.length > 0) out.add(r.draftId);
    for (const s of lockSubjects(r)) if (s.startsWith("draft:")) out.add(s.slice("draft:".length));
  }
  return out;
}

/**
 * THE DRAFT ROW THIS MESSAGE HAS ACQUIRED SINCE THE KEY WAS MINTED — recorded, never re-keyed. A compose pressed
 * before autosave had written anything holds `draftId: null`, and a row appears moments later. The record's identity
 * does NOT move with it — that is the whole point of {@link SendLock.session}, and re-keying the subject onto the new
 * row is exactly the defect this pair of fields exists to close. What the row is worth is diagnostic: somebody
 * reading the jar beside a parked send, or the account's Drafts list, needs to know which row belongs to the message
 * whose outcome nobody knows. So it is written down and nothing branches on it. Matched on the SET, so it finds the
 * record however the message is named at this moment. Only a record that names this message is touched, and only when
 * the row has actually changed.
 */
export function attachSendLockDraft(
  lane: string,
  subjects: ReadonlyArray<string>,
  draftId: string | null,
  owner: string | null = storageOwner(),
): void {
  if (subjects.length === 0 || draftId === null) return;
  const rows = loadOrEmpty(owner);
  let moved = false;
  const next = rows.map((r) => {
    if (r.lane !== lane || r.draftId === draftId) return r;
    if (!lockSubjects(r).some((s) => subjects.includes(s))) return r;
    moved = true;
    return { ...r, draftId };
  });
  if (moved) save(next, owner);
}

/**
 * WHICH LANE AND WHICH MESSAGE AN IDEMPOTENCY-KEY BELONGS TO: The reverse of every other reader here, and it exists
 * for the one answer that arrives with no caller: a send whose owning session died, replayed at boot and settled by
 * the engine. That result carries the KEY it went out under and the row it was delivered from — and nothing else this
 * browser can act on. The record is what turns the key back into a message: it was written at the press,
 * synchronously, with the lane and the names. Live records only, and this build's format only: a key from a shape
 * this build cannot read is one whose meaning it would be guessing at.
 */
export function recordForSendKey(
  key: string, nowMs: number, owner: string | null = storageOwner(),
): SendLock | null {
  const rows = load(owner);
  if (rows === null) return null;
  return rows.find((r) => r.key === key && r.v <= SEND_LOCK_FORMAT && isLive(r, nowMs)) ?? null;
}

/**
 * AN ENDING OF A SEND (confirmed, refused, unverified) SPEAKS TO THE COMPOSER WHOSE RECORD NAMES ITS
 * KEY, AT ANY AGE. The age limit decides only whether a NEW press may join, or be held by, an old
 * record; it never decides whether an answer the server already gave is heard. A send replayed eight
 * days after its press is confirmed like any other, and reading its record through the limit left the
 * sent words in an editable composer, one edit away from a second copy. It prunes nothing, and it
 * reads this build's format only, as {@link recordForSendKey}.
 */
export function recordForEndedSend(key: string, owner: string | null = storageOwner()): SendLock | null {
  const rows = load(owner);
  if (rows === null) return null;
  return rows.find((r) => r.key === key && r.v <= SEND_LOCK_FORMAT) ?? null;
}

/**
 * Record that ONE MESSAGE's send on this lane came back unverified. See {@link SendLock.unverified}.
 *
 * Keyed by `(lane, fingerprint)` for the same reason {@link releaseSendLock} is: the lane may hold
 * more than one record, and marking "the first one for this lane" would stamp the ambiguity onto
 * whichever message happened to be listed first.
 */
export function markSendLockUnverified(lane: string, fp: string, owner: string | null = storageOwner()): void {
  const rows = loadOrEmpty(owner);
  const found = rows.find((r) => r.lane === lane && r.fp === fp);
  if (!found || found.unverified === true) return;
  save(rows.map((r) => (r === found ? { ...r, unverified: true } : r)), owner);
}
