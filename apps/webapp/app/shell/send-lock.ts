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
 * the verb from the moment `mutate` is called. This holds exactly one fact per lane: *the key this
 * lane's unsettled send is going out under*. It is released on any terminal outcome the session
 * observes (confirmed, failed, unverified), because those are the states where the next press is a
 * genuinely new send and must get a genuinely new key — resuming a spent key would replay the old
 * outcome for ever, which is a wedged Send button rather than a duplicate mail, but is still wrong.
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
  /** {@link sendFingerprint} of the message this key was minted for. */
  fp: string;
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
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.draftId ?? "", m.mailboxId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.html ?? m.body ?? "", m.sendAt ?? "",
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
    && typeof r.fp === "string";
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
export function readSendLock(lane: string, fp: string, nowMs: number, owner: string | null = storageOwner()): string | null {
  const rows = load(owner);
  if (rows.length === 0) return null;
  const live = rows.filter((r) => nowMs - r.at <= SEND_LOCK_TTL_MS);
  const found = live.find((r) => r.lane === lane);
  if (found && found.fp !== fp) {
    const kept = live.filter((r) => r !== found);
    save(kept, owner);
    return null;
  }
  if (live.length !== rows.length) save(live, owner);
  return found?.key ?? null;
}

/**
 * CLAIM A LANE UNDER A KEY — synchronous, and it must complete BEFORE the verb is expressed.
 *
 * That order is the whole guarantee. A key written after `engine.mutate` returns would leave the
 * exact window this file exists to close: a process killed between the POST and the write comes
 * back with the mail possibly sent and no record of the key it went under.
 */
export function claimSendLock(lock: SendLock, owner: string | null = storageOwner()): void {
  const rows = load(owner).filter((r) => r.lane !== lock.lane);
  rows.push(lock);
  save(rows, owner);
}

/** Release a lane on a TERMINAL outcome — see the header for why `queued` is not one. */
export function releaseSendLock(lane: string, owner: string | null = storageOwner()): void {
  const rows = load(owner);
  const kept = rows.filter((r) => r.lane !== lane);
  if (kept.length !== rows.length) save(kept, owner);
}

/** Every live claim, oldest first — the restart's adoption pass reads this. */
export function allSendLocks(nowMs: number, owner: string | null = storageOwner()): SendLock[] {
  const rows = load(owner);
  if (rows.length === 0) return [];
  const live = rows.filter((r) => nowMs - r.at <= SEND_LOCK_TTL_MS);
  if (live.length !== rows.length) save(live, owner);
  return live.slice().sort((a, b) => a.at - b.at);
}
