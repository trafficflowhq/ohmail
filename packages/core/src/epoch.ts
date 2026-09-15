/**
 * ═══ A UIDVALIDITY IS A NAMED EPOCH OR IT IS NOTHING — never a number that defaults to zero ═══
 *
 * A remembered UID is a fact only under the UIDVALIDITY that issued it, so comparing a stored
 * `(uidvalidity, uid)` against a live folder has THREE answers. Spelling the third as `0` gave it
 * two, and both readings lost mail: `0` compared EQUAL to the other `0`; `String(undefined)`
 * compared UNEQUAL to every epoch and read as a contradiction, which is terminal. The wire and
 * the database keep their spellings — what changes is that no site compares them itself: a value
 * becomes an {@link Epoch} first, and an unknown one can neither match nor contradict.
 */

/** A UIDVALIDITY that was named, or the absence of one. There is no third representation. */
export type Epoch =
  | { readonly known: true; readonly value: string }
  | { readonly known: false };

/** The absence, as a value — so a caller never writes `0` or `undefined` to mean it. */
export const UNKNOWN_EPOCH: Epoch = { known: false };

/** RFC 3501 §2.3.1.1: UIDVALIDITY is an unsigned 32-bit `nz-number`. Zero is not an epoch. */
const EPOCH_MAX = 4294967295n;

/**
 * Read one value as an epoch. Absent, null, zero, out of RFC 3501's range, or not a plain
 * decimal (`"undefined"`, `"1e9"`, `" 7 "`, `"007"`, `"0x7"`) — all of it is UNKNOWN. The
 * accepted spelling is the canonical decimal, so two known epochs compare as strings.
 */
export function epochOf(v: bigint | number | string | null | undefined): Epoch {
  if (v === null || v === undefined) return UNKNOWN_EPOCH;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v <= 0) return UNKNOWN_EPOCH;
    return epochOf(BigInt(v));
  }
  if (typeof v === "bigint") {
    return v > 0n && v <= EPOCH_MAX ? { known: true, value: String(v) } : UNKNOWN_EPOCH;
  }
  if (!/^[1-9][0-9]{0,9}$/.test(v)) return UNKNOWN_EPOCH;
  return BigInt(v) <= EPOCH_MAX ? { known: true, value: v } : UNKNOWN_EPOCH;
}

/**
 * The epoch half of a `NativeLocator.ref` (`${uidvalidity}:${uid}`). A `0:0` placeholder — the
 * shape a NULL `native_locator` column and an APPEND with no APPENDUID take — is UNKNOWN, which
 * is what it always meant; it used to be read as "claims nothing, so let the command through".
 */
export function epochOfRef(ref: string): Epoch {
  const parts = ref.split(":");
  // A ref that is not `${uidvalidity}:${uid}` at all names no epoch either — reading its whole
  // text as the epoch would let a malformed value answer a question it cannot.
  return parts.length < 2 ? UNKNOWN_EPOCH : epochOf(parts[0]);
}

/**
 * Are these the same epoch? UNKNOWN is never the same as anything, itself included — two
 * unanswered questions are not one answer.
 */
export function sameEpoch(a: Epoch, b: Epoch): boolean {
  return a.known && b.known && a.value === b.value;
}

/**
 * The one comparison behind every locator-addressed command.
 *
 *  · `usable` — both epochs are named and agree; the UID means what it was written to mean.
 *  · `stale`  — both are named and CONTRADICT; the folder was recreated, the message is not here.
 *  · `unknown` — either side is unnamed; nothing is proved either way, so the caller refuses
 *    without moving or deleting anything, says so, and re-reads.
 */
export function epochVerdict(ref: Epoch, reported: Epoch): "usable" | "stale" | "unknown" {
  if (!ref.known || !reported.known) return "unknown";
  return ref.value === reported.value ? "usable" : "stale";
}

/**
 * A remembered uid and the epoch that issued it. The pair travels together or the uid is not a
 * fact: a folder deleted and recreated re-issues the same small integers to different messages,
 * so a bare number names whatever sits at it now.
 */
export interface UidRef {
  readonly epoch: Epoch;
  readonly uid: number;
}

/** Pair each uid with the epoch of the read that named it. */
export function uidRefsAt(epoch: Epoch, uids: readonly number[]): UidRef[] {
  return uids.map((uid) => ({ epoch, uid }));
}

/**
 * THE ONE GUARD BEHIND EVERY REMEMBERED-UID DECISION — the passive folder skip and all three
 * `ohmail/_meta` cleanups. `reported` is what the server states NOW, read back at the moment of use
 * and never derived. A batch is `stale` as soon as one ref contradicts it, `unknown` when nothing
 * contradicts and some epoch was never named, `usable` only when every ref agrees; an empty batch
 * remembers nothing, so it proves nothing. What a caller does with `unknown` is the caller's policy:
 * a cleanup PROCEEDS (refusing would strand every mailbox on a connection that states no
 * UIDVALIDITY, and the custody read-back is the backstop), the passive skip REFUSES (its fallback
 * is one SELECT, and being wrong costs somebody's mail).
 */
export function uidRefsAtEpoch(
  refs: readonly UidRef[], reported: Epoch,
): "usable" | "stale" | "unknown" {
  if (refs.length === 0) return "unknown";
  let unknown = false;
  for (const ref of refs) {
    const verdict = epochVerdict(ref.epoch, reported);
    if (verdict === "stale") return "stale";
    if (verdict === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "usable";
}
