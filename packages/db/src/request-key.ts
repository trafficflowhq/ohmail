import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { accountSettings } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PER-ACCOUNT REQUEST KEY — what makes a reader's decision PROVABLE (mail 0090, 0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ohmail/_meta` is an ordinary IMAP folder and a request record is an ordinary message, so the
 * organizer's drain reads input that ANY process with APPEND rights on the mailbox could have
 * written: a shared-folder ACL, a sieve `fileinto`, a leaked device credential, any mail client
 * the person ever signed into. Applying such a record writes a `promoted` rule, a `contacts`
 * whitelist (a permanent Screener bypass) and a mark-read pushed to the server — indistinguishable
 * in the product from the account owner's own press. Nothing in the WIRE FORMAT can tell the two
 * apart, because a forger writes the wire format too.
 *
 * A shared secret can. This module owns that secret: 32 bytes from `randomBytes`, held on
 * `account_settings.request_key` (the mail half, so both doors carry the column), handed only to
 * an install that has proved it holds a session for the account, and used to HMAC the fields of
 * every request record. See `@trafficflow/core/adapters/organizer-lease#signRequest`.
 *
 * ── MINTED ON FIRST NEED, NEVER AT SIGNUP ───────────────────────────────────────────────────
 *
 * A key is a BEARER CREDENTIAL: whoever holds it can make this account's organizer apply screener
 * decisions. So it is created by the first process that actually needs one — an organizer about
 * to advertise the `requests` capability, or a reader about to sign a decision — and never
 * backfilled across the fleet. An account that only ever runs one install never grows a key, and
 * therefore has nothing to leak.
 *
 * ── THE ABSENT KEY IS A SUPPORTED STATE, NOT AN ERROR ───────────────────────────────────────
 *
 * NULL means "this account has no request channel". An organizer holding no key advertises no
 * `requests` capability, so a reader is refused honestly at the door rather than queueing a
 * decision nobody can verify. Every caller here must treat `null` as that answer and never as a
 * reason to fall back to an unsigned record — that fallback IS the vulnerability this file exists
 * to close.
 */

/** 32 bytes, base64url — 43 characters, which `account_settings_request_key_len` closes. */
export const REQUEST_KEY_BYTES = 32;

/** The length the column's CHECK enforces, restated so a test can assert the two agree. */
export const REQUEST_KEY_ENCODED_LENGTH = 43;

/**
 * A fresh key. Exported for the rotation callers and for tests; NOT for a caller that wants "a
 * key for this account" — that is {@link readOrMintRequestKey}, which is race-safe and idempotent.
 */
export function generateRequestKey(): string {
  return randomBytes(REQUEST_KEY_BYTES).toString("base64url");
}

/**
 * THE KEY THIS ACCOUNT ALREADY HAS, or `null`. A PLAIN read and never a mint — for the callers
 * that must not create a channel merely by asking whether one exists (the claim writer's
 * capability decision is the one that matters: an organizer advertises `requests` because it
 * HOLDS a key, not because asking gave it one).
 */
export async function readRequestKey(tx: Tx, accountId: string): Promise<string | null> {
  const [row] = await tx.select({ requestKey: accountSettings.requestKey })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .limit(1);
  return row?.requestKey ?? null;
}

/**
 * THE KEY, MINTING ONE IF THIS ACCOUNT HAS NONE — the call a door makes when it is about to hand
 * a key to an install that just proved it holds a session.
 *
 * ── WHY THE WRITE IS A `coalesce` AND NOT AN `isNull` GUARD ─────────────────────────────────
 *
 * Two installs can ask in the same instant — a desktop pressing "Organize here" while the hosted
 * reader's own cycle signs a decision — and they must end up with the SAME key or every record
 * one of them writes is refused by the other. `setWhere: isNull(...)` (the shape
 * `screening_baseline_at` uses one module over) would make the loser's `DO UPDATE` match no row,
 * and `RETURNING` would then hand it nothing while a perfectly good key sat in the column.
 *
 * `coalesce(request_key, <fresh>)` is the version that cannot lose: the row is always updated, so
 * `RETURNING` always answers, and the answer is the EXISTING key whenever there is one. Postgres
 * serializes the two `INSERT … ON CONFLICT` statements on the primary key, so the second sees the
 * first's committed value. The fresh key the loser generated is simply discarded, unused and
 * unlogged.
 *
 * The read comes first so the common case — every call after the first — is a plain SELECT that
 * never touches `updated_at`. The upsert runs once in an account's life.
 */
export async function readOrMintRequestKey(tx: Tx, accountId: string, now: Date): Promise<string> {
  const existing = await readRequestKey(tx, accountId);
  if (existing !== null) return existing;

  const fresh = generateRequestKey();
  const [row] = await tx.insert(accountSettings)
    .values({ accountId, requestKey: fresh, updatedAt: now })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        requestKey: sql`coalesce(${accountSettings.requestKey}, ${fresh})`,
        updatedAt: now,
      },
    })
    .returning({ requestKey: accountSettings.requestKey });
  // The column is NULL-able, so the type says `string | null`; the statement above cannot produce
  // NULL (the inserted value and both `coalesce` arms are non-null). Falling back to `fresh`
  // rather than asserting keeps a driver surprise from becoming a crash on a path that is
  // otherwise total.
  return row?.requestKey ?? fresh;
}

/**
 * ROTATE — a password change and a consent reset both land here.
 *
 * Rotation is an OVERWRITE, and its consequence is deliberate: every record signed with the old
 * key stops verifying, is refused `unauthenticated` by the organizer, and the reader that wrote it
 * expires the row on its own cycle and can re-decide. That is the correct behaviour for the two
 * events that trigger it — a password change means a credential may have been compromised, and a
 * consent reset means the person is clearing this account's organizing state.
 *
 * Writes NOTHING when the account has no key, and the `IS NOT NULL` in the predicate is the whole
 * of that guarantee: rotating an absent key would MINT one, turning a password change into the
 * creation of a bearer credential for an account that never asked for a request channel. It is an
 * `UPDATE … WHERE` rather than an upsert for exactly this reason — an upsert has no way to say
 * "only if there is already something here".
 *
 * Returns whether a key was actually replaced, so a caller can log a rotation without a second
 * read — and so a test can tell "rotated" from "there was nothing to rotate".
 */
export async function rotateRequestKey(tx: Tx, accountId: string, now: Date): Promise<boolean> {
  const rows = await tx.update(accountSettings)
    .set({ requestKey: generateRequestKey(), requestKeyRotatedAt: now, updatedAt: now })
    .where(and(
      eq(accountSettings.accountId, accountId),
      isNotNull(accountSettings.requestKey),
    ))
    .returning({ accountId: accountSettings.accountId });
  return rows.length > 0;
}

/**
 * CLEAR — the key is removed and NOT replaced, so the account's request channel goes back to its
 * resting state (no key ⇒ no capability ⇒ readers refused honestly at the door).
 *
 * Separate from {@link rotateRequestKey} because the two answer different questions. A rotation
 * says "the channel continues under a new secret"; this says "there is no channel". Erasure and
 * an account that has stopped using a second install want this one; a password change wants the
 * other.
 */
export async function clearRequestKey(tx: Tx, accountId: string, now: Date): Promise<void> {
  await tx.update(accountSettings)
    .set({ requestKey: null, requestKeyRotatedAt: now, updatedAt: now })
    .where(eq(accountSettings.accountId, accountId));
}
