/**
 * What one install remembers about one mailbox's `ohmail/_meta`. Every field is a POSITION IN A
 * NUMBERING (the claim read's own uid, the settings uid, the sweep and drain floors), worthless
 * the moment the numbering is replaced — and the claim read uses its uid as a search FLOOR, so a
 * wrong one returns a short answer that looks complete, which is how a mailbox gets two
 * organizers. Keyed by `(install, mailbox)` with UIDVALIDITY inside the value: keying by the
 * triple would orphan entries on every replacement. A generation mismatch CLEARS the entry and
 * says so. In memory only: every field records where to look, never what was settled, so losing
 * the lot costs one re-walk and can never lose a record.
 */

import { epochOf, sameEpoch } from "../epoch.js";

/** Whose memory this is. Both required, both explicit — never inferred from a connection. */
export interface MetaIdentity {
  readonly installId: string;
  readonly mailboxId: string;
}

/** Thrown at a seam that was handed an identity it cannot key a memory by. */
export class MetaIdentityError extends Error {
  constructor(who: string, what: string) {
    super(`${who} was given no usable ${what}, so what it remembers could not be attributed to `
      + "one install on one mailbox");
    this.name = "MetaIdentityError";
  }
}

/**
 * THE CHECK THAT HAS TO BE AT RUN TIME.
 *
 * The tests in this package are not typechecked, so making these fields required does not fail a
 * build for the places that construct an io — they would bind `undefined` and every mailbox in
 * the process would share one entry under that key. Silent, and precisely the defect the key
 * exists to prevent, so the check is where it will fire rather than where it would read well.
 */
export function assertMetaIdentity(who: string, id: MetaIdentity | undefined): void {
  if (id === undefined || id === null) throw new MetaIdentityError(who, "identity");
  if (typeof id.installId !== "string" || id.installId.trim() === "") {
    throw new MetaIdentityError(who, "install id");
  }
  if (typeof id.mailboxId !== "string" || id.mailboxId.trim() === "") {
    throw new MetaIdentityError(who, "mailbox id");
  }
}

/** A folder generation, or `null` when the server did not say. */
export type Generation = number | bigint | null;

/** Every position one install keeps in one mailbox's meta folder. All optional; all hints. */
export interface MetaMemo {
  /** The uid the server gave this install's own claim when it wrote it. */
  readonly claimUid?: number;
  /** This process's monotonic clock (`performance.now()`) when it appended that claim. */
  readonly claimWrittenMonoMs?: number;
  /** The uid the server gave this install's own settings document. */
  readonly profileUid?: number;
  /** Where the acknowledgement sweep stopped looking. */
  readonly sweepCursor?: number;
  /** Renew cleanups in a row the server PROVABLY did not carry out (still there, or refused). */
  readonly cleanupRefusals?: number;
  /** The own claim the gate probes before renewing once that count reaches its bound. */
  readonly undeletableUid?: number;
}

interface Entry {
  generation: Generation;
  memo: MetaMemo;
}

/**
 * WHAT A READ FOUND — and `invalidated` is the case that used to be indistinguishable from
 * `empty`, which is why a mailbox stuck behind a replaced folder looked like an idle one.
 */
export type MemoRead =
  | { readonly kind: "memo"; readonly memo: MetaMemo }
  | { readonly kind: "empty" }
  /**
   * THE CALLER COULD NOT LEARN THE FOLDER'S GENERATION, so nothing here may be used — and
   * nothing here is thrown away either.
   *
   * These are not the same as a mismatch and treating them as one was destructive: this entry is
   * SHARED by four positions, so one caller that cannot see the generation would have cleared the
   * claim anchor, the settings anchor and the sweep's place along with its own. A reader that
   * cannot check a position simply does without it.
   */
  | { readonly kind: "unusable" }
  | { readonly kind: "invalidated"; readonly was: Generation; readonly now: Generation };

const store = new Map<string, Entry>();

function keyOf(id: MetaIdentity): string {
  /* NUL-JOINED, AND WRITTEN AS AN ESCAPE ON PURPOSE. The separator has to be a character
   * neither field can contain: join on a space or a colon and two distinct pairs collide --
   * install "a b" with mailbox "c", and install "a" with mailbox "b c", would share one
   * memory, which is the cross-install leak this key exists to prevent, reintroduced by the
   * separator itself.
   *
   * A LITERAL NUL in the source would make every grep over this file silently skip ALL of it
   * and exit as though the pattern were absent, which has produced false conclusions in this
   * repository before. The escape behaves identically and leaves the file readable. */
  return `${id.installId}\u0000${id.mailboxId}`;
}

/**
 * Generations compare by VALUE across `number` and `bigint`, because a server may report either
 * and the same folder must not look replaced merely because the type changed on the wire. Through
 * `epoch.ts`, so this module holds ONE notion of sameness rather than a second `BigInt` compare
 * beside the door. Both arguments are always KNOWN by the time they arrive — the two guards below
 * turn an unnamed generation away first, and that is deliberately where the decision is: a reader
 * that cannot check a position must be told `unusable` and keep the entry, not told "mismatch"
 * and clear three other readers' positions with its own.
 */
function sameGeneration(a: Generation, b: Generation): boolean {
  return sameEpoch(epochOf(a), epochOf(b));
}

/** Read this install's memory of this mailbox, valid only for `generation`. */
export function readMemo(id: MetaIdentity, generation: Generation): MemoRead {
  assertMetaIdentity("the meta memory", id);
  const entry = store.get(keyOf(id));
  if (entry === undefined) return { kind: "empty" };
  /* Asked without a generation: the caller cannot check anything, which is a fact about the
   * CALLER and not about this entry. Deleting here would let one blind reader wipe three other
   * readers' positions. */
  if (!epochOf(generation).known) return { kind: "unusable" };
  if (!sameGeneration(entry.generation, generation)) {
    store.delete(keyOf(id));
    return { kind: "invalidated", was: entry.generation, now: generation };
  }
  return { kind: "memo", memo: entry.memo };
}

/**
 * Record positions for this install and mailbox under `generation`, merging with whatever is
 * already held FOR THAT SAME generation and replacing outright otherwise — a folder that has been
 * renumbered shares nothing with the one before it.
 */
export function writeMemo(id: MetaIdentity, generation: Generation, patch: MetaMemo): void {
  assertMetaIdentity("the meta memory", id);
  // A position under an unknown generation cannot be checked for staleness later, so it is not
  // kept at all: an unverifiable memory is worse than none, because none falls back to a walk.
  if (!epochOf(generation).known) { store.delete(keyOf(id)); return; }
  const existing = store.get(keyOf(id));
  const base = existing !== undefined && sameGeneration(existing.generation, generation)
    ? existing.memo
    : {};
  store.set(keyOf(id), { generation, memo: { ...base, ...patch } });
}

/**
 * THE STORED ENTRY AND THE GENERATION IT BELONGS TO, WITHOUT CHECKING IT.
 *
 * For the one caller that cannot check first: the request drain must pass its resume point INTO
 * the read that would tell it the folder's generation, so the check has to happen after. It uses
 * this, then compares and discards. Nothing else should: `readMemo` is the door, and a position
 * used without a check is only safe where using a stale one costs a wasted window and never a
 * wrong decision — which is true of a walk's resume point and of nothing else here.
 */
export function peekMemo(id: MetaIdentity): { generation: Generation; memo: MetaMemo } | null {
  assertMetaIdentity("the meta memory", id);
  const entry = store.get(keyOf(id));
  return entry === undefined ? null : { generation: entry.generation, memo: entry.memo };
}

/** Forget one field without disturbing the others. */
export function forgetMemo(id: MetaIdentity, field: keyof MetaMemo): void {
  assertMetaIdentity("the meta memory", id);
  const entry = store.get(keyOf(id));
  if (entry === undefined) return;
  const next = { ...entry.memo };
  delete next[field];
  store.set(keyOf(id), { generation: entry.generation, memo: next });
}

/**
 * WHEN THIS INSTALL SHRINKS THE FOLDER WITHOUT A REQUEST KEY — not a position, so not under a
 * generation: what the gate's last read saw of the folder's size, and when the shrink last ran.
 * A keyless pass shrinks only when that read reached the holder's reserve below the window, or
 * once per `intervalMs` (REVIEW-02514 LOW 1). Losing it costs one shrink pass, never a record.
 */
const shrinkClock = new Map<string, { nearCeiling: boolean; lastRanMs: number | null }>();

/** The gate's read saw the folder at or past the point a keyless organizer must shrink it. */
export function noteMetaNearCeiling(id: MetaIdentity, nearCeiling: boolean): void {
  assertMetaIdentity("the meta memory", id);
  const held = shrinkClock.get(keyOf(id));
  shrinkClock.set(keyOf(id), { nearCeiling, lastRanMs: held?.lastRanMs ?? null });
}

/** Is a keyless shrink owed now? Never run in this process counts as owed. */
export function metaShrinkDue(id: MetaIdentity, nowMs: number, intervalMs: number): boolean {
  assertMetaIdentity("the meta memory", id);
  const held = shrinkClock.get(keyOf(id));
  if (held === undefined || held.lastRanMs === null || held.nearCeiling) return true;
  return nowMs - held.lastRanMs >= intervalMs || nowMs < held.lastRanMs;
}

/** The shrink ran; the size reading it answered is spent until the gate reads again. */
export function noteMetaShrinkRan(id: MetaIdentity, nowMs: number): void {
  assertMetaIdentity("the meta memory", id);
  shrinkClock.set(keyOf(id), { nearCeiling: false, lastRanMs: nowMs });
}

/** Test seam: drop everything. Never called by product code. */
export function resetMetaMemos(): void {
  store.clear();
  shrinkClock.clear();
}
