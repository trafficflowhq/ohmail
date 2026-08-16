import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { invites, waitlist } from "@trafficflow/db/cloud";
import { hashToken } from "./auth/crypto.js";
import { normalizeRecipient } from "./mail/port.js";
import { ServiceError } from "./errors.js";

/**
 * The consumable, email-bound, expiring invite.
 *
 * Two functions and a refusal taxonomy. They live here rather than inside `AuthService`
 * because BOTH sides need them and the two sides are in different processes' worth of
 * concerns: `AuthService.register` CONSUMES one inside the transaction that creates the
 * account, and the operator mint path (`WaitlistService.mintInvite`, driven by
 * `invite-cli.ts`) ISSUES one and hands it to the invite mail.
 *
 * ── THE ONE THING THAT MATTERS ABOUT CONSUMPTION ────────────────────────────────────
 *
 * It is a SINGLE STATEMENT:
 *
 *   UPDATE invites SET consumed_at = $now, consumed_by_user_id = …
 *    WHERE code_hash = $1 AND email = $2 AND consumed_at IS NULL AND expires_at > $now
 *    RETURNING id
 *
 * Not SELECT-then-check-then-UPDATE. That shape is a read-modify-write, and it is the
 * exact defect `consumeEmailVerification` was fixed for (see that method's
 * doc): two concurrent presentations of one code both read `consumed_at IS NULL`, both
 * pass, and both proceed — one invite, two accounts, and a sequential test can never see
 * it. Here the row lock decides the race and exactly one caller gets a row back.
 *
 * The `email` predicate is IN the same statement for the same reason it is in the schema:
 * the binding must not be a separate check some later caller can forget.
 */

/**
 * Why an invite was refused. Each maps to a different true sentence and a different
 * remedy — which is the entire reason this table exists instead of a `Set.has`.
 *
 *  · `unknown`  — no invite row carries this code (or it is bound to a different address:
 *                 see {@link classifyInviteFailure} for why those are the same answer).
 *  · `used`     — it was redeemed already. Remedy: sign in.
 *  · `expired`  — it was real and is past `expires_at`. Remedy: ask for a new one.
 *  · `revoked`  — an operator took it back. Remedy: ask for a new one, same as `expired`,
 *                 and the wire message is DELIBERATELY the expired one. A code's holder is
 *                 not always the person it was meant for — revocation is what happens when
 *                 it is not — so "this was cancelled" tells whoever is holding it that
 *                 somebody noticed, and telling them that buys nothing. It is a distinct
 *                 refusal internally because the operator's logs must distinguish the two.
 */
export type InviteRefusal = "unknown" | "used" | "expired" | "revoked";

export interface InviteConsumed {
  ok: true;
  inviteId: string;
  /** The address the code was bound to — already normalised. */
  email: string;
}

export interface InviteRefused {
  ok: false;
  refusal: InviteRefusal;
}

export type InviteOutcome = InviteConsumed | InviteRefused;

/** The wire mapping. Distinct codes, because the UI has to say three different things. */
const REFUSAL_HTTP: Record<InviteRefusal, { code: string; status: number; message: string }> = {
  unknown: {
    code: "invite_invalid", status: 403,
    message:
      "That invite code is not valid for this email address. Check the code and the address " +
      "against your invite mail — the code only works for the address it was sent to.",
  },
  used: {
    code: "invite_used", status: 409,
    message:
      "This invite has already been used. If that was you, sign in instead; " +
      "if it was not, reply to your invite mail and we will look into it.",
  },
  expired: {
    code: "invite_expired", status: 403,
    message: "This invite has expired. Reply to your invite mail and we will send a fresh one.",
  },
  // BYTE-IDENTICAL TO `expired`, on purpose. See {@link InviteRefusal}: the remedy is the
  // same and the distinction is only ours to know.
  revoked: {
    code: "invite_expired", status: 403,
    message: "This invite has expired. Reply to your invite mail and we will send a fresh one.",
  },
};

/** Refusal → the typed `ServiceError` the error envelope renders. */
export function inviteError(refusal: InviteRefusal): ServiceError {
  const { code, status, message } = REFUSAL_HTTP[refusal];
  return new ServiceError(code, status, message, { reason: refusal });
}

/**
 * Consume the invite for `code` + `email`, atomically. `ok: false` classifies the failure.
 *
 * MUST run inside the transaction that creates the account. If registration then fails —
 * the address is already registered, a constraint fires — the rollback un-burns the invite,
 * which is the difference between "try again" and "your one invite is gone".
 */
export async function consumeInvite(
  tx: Tx,
  input: { code: string; email: string; now: Date; userId?: string | null },
): Promise<InviteOutcome> {
  const code = normalizeInviteCode(input.code);
  const email = normalizeRecipient(input.email);
  if (code.length === 0 || !email) return { ok: false, refusal: "unknown" };

  const codeHash = hashToken(code);
  const [row] = await tx.update(invites)
    .set({ consumedAt: input.now, consumedByUserId: input.userId ?? null })
    .where(and(
      eq(invites.codeHash, codeHash),
      eq(invites.email, email),
      isNull(invites.consumedAt),
      // Revocation belongs IN this statement, not in a check beside it — same argument as
      // the `email` predicate above, and as `consumed_at`: a condition an operator's remedy
      // depends on must not be something a future caller can forget to apply.
      isNull(invites.revokedAt),
      gt(invites.expiresAt, input.now),
    ))
    .returning({ id: invites.id, email: invites.email });

  if (row) return { ok: true, inviteId: row.id, email: row.email };
  return { ok: false, refusal: await classifyInviteFailure(tx, codeHash, email, input.now) };
}

/**
 * Why the UPDATE matched nothing — the ONLY place an invite's state is disclosed.
 *
 * The rule is: **`used` and `expired` are told only to a caller who already proved they
 * hold the bound address.** A code bound to someone else, or no code at all, is `unknown`
 * — byte-identical answers — so a stranger holding a leaked code learns nothing about
 * which addresses have invites, and a code holder cannot walk the table.
 *
 * (The `email` predicate is applied here as an equality on the row's own column rather
 * than re-running the UPDATE's WHERE, so this is one indexed lookup on the unique
 * `code_hash` and no second write.)
 */
async function classifyInviteFailure(
  tx: Tx, codeHash: string, email: string, now: Date,
): Promise<InviteRefusal> {
  const [row] = await tx.select({
    email: invites.email, consumedAt: invites.consumedAt, expiresAt: invites.expiresAt,
    revokedAt: invites.revokedAt,
  }).from(invites).where(eq(invites.codeHash, codeHash)).limit(1);

  if (!row) return "unknown";
  if (row.email !== email) return "unknown";
  if (row.consumedAt !== null) return "used";
  // Ahead of `expired` because a revoked invite that has ALSO run out is still, to the
  // operator reading the log, a revocation. The wire answer is the same either way.
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  // The row is live, bound and unconsumed, yet the UPDATE matched nothing: another
  // transaction took it between the two statements. That IS `used`, and reporting it as
  // anything else would tell one of two racing redeemers that nothing happened.
  return "used";
}

/**
 * Mint an invite for `email` and return the RAW code (the only time it exists in memory
 * on our side). `codeLength` is the token generator's, not a parameter — see `crypto.ts`.
 *
 * Also stamps `waitlist.invited_at` when the address is on the list, so "who is still
 * waiting" stays one query and nobody is invited twice by accident.
 */
export async function issueInvite(
  tx: Tx,
  input: { email: string; expiresAt: Date; now: Date; issuedBy?: string; note?: string | null },
): Promise<{ code: string; inviteId: string; email: string; expiresAt: Date }> {
  const email = normalizeRecipient(input.email);
  if (!email) throw new ServiceError("validation_failed", 400, "a valid email address is required");
  if (input.expiresAt.getTime() <= input.now.getTime()) {
    throw new ServiceError("validation_failed", 400, "the invite expiry must be in the future");
  }

  const code = generateInviteCode();
  const [row] = await tx.insert(invites).values({
    codeHash: hashToken(code),
    email,
    issuedBy: input.issuedBy ?? "operator",
    note: input.note ?? null,
    expiresAt: input.expiresAt,
  }).returning({ id: invites.id });

  await tx.update(waitlist)
    .set({ invitedAt: input.now, updatedAt: input.now })
    .where(eq(waitlist.email, email));

  return { code, inviteId: row!.id, email, expiresAt: input.expiresAt };
}

/**
 * Live (unconsumed, unexpired) invites for an address — what the mint path checks before
 * issuing a second one, so an operator running the script twice does not put two working
 * codes in one inbox.
 */
export async function liveInvitesFor(
  tx: Tx, email: string, now: Date,
): Promise<Array<{ id: string; expiresAt: Date }>> {
  const normalized = normalizeRecipient(email);
  if (!normalized) return [];
  return tx.select({ id: invites.id, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(
      eq(invites.email, normalized),
      isNull(invites.consumedAt),
      isNull(invites.revokedAt),
      gt(invites.expiresAt, now),
    ))
    .orderBy(desc(invites.createdAt));
}

/**
 * Take back every live invite for `email`. Returns how many were revoked.
 *
 * THE POINT OF THIS FUNCTION is that it is the same statement as the check: one
 * `UPDATE … WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now`, so it
 * cannot revoke a code somebody is redeeming in the same instant and then report success —
 * the row lock decides, exactly as it does in {@link consumeInvite}. A consumed invite is
 * deliberately NOT touched: `consumed_by_user_id` is the record of which invite opened which
 * account, and revoking after the fact would rewrite history without closing anything.
 *
 * Called two ways: on its own (`pnpm invite revoke --email …`), and by `mintInvite` when
 * `--force` is used — because "issue another one" without "and cancel the old one" is how a
 * leaked code stays live for another fortnight next to its replacement.
 */
export async function revokeInvitesFor(
  tx: Tx,
  input: { email: string; now: Date; revokedBy?: string; reason?: string | null },
): Promise<number> {
  const email = normalizeRecipient(input.email);
  if (!email) return 0;
  const rows = await tx.update(invites)
    .set({
      revokedAt: input.now,
      revokedBy: input.revokedBy ?? "operator",
      revokedReason: input.reason ?? null,
    })
    .where(and(
      eq(invites.email, email),
      isNull(invites.consumedAt),
      isNull(invites.revokedAt),
      gt(invites.expiresAt, input.now),
    ))
    .returning({ id: invites.id });
  return rows.length;
}

/**
 * A human-transcribable invite code: `OHMAIL-XXXX-XXXX-XXXX`.
 *
 * The FORMAT IS THE CODE — `code_hash` is `sha256` of exactly this string, so changing
 * the shape invalidates every outstanding invite. That is not a hypothetical: the
 * `mailoh → ohmail` rename did exactly this, which is why {@link CODE_PREFIXES} is now an
 * append-only list rather than a literal, and why a shape change is a migration question.
 *
 * Why not `generateToken()`, which every other credential here uses: this value is read
 * off a screen (or out of a mail) and typed into a form by a person. 43 characters of
 * mixed-case base64url containing both `-` and `_` is a transcription-error generator and
 * cannot be read aloud. The alphabet below is Crockford-ish — no `I`, `L`, `O` or `U`, so
 * `1`/`I` and `0`/`O` cannot be confused, and no accidental words.
 *
 * Entropy: 12 symbols × 5 bits = **60 bits**, and the draw is unbiased because 256 is an
 * exact multiple of 32 — every byte maps to exactly eight alphabet positions. Against a
 * `UNIQUE` code column behind a rate-limited register endpoint, guessing is not a threat
 * model; transcription is, which is what the format optimises for.
 *
 * Normalisation on the way IN is `normalizeInviteCode` — a user pasting
 * `ohmail xxxx xxxx xxxx` must not be told their code is invalid.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The prefix every code minted from now on carries. */
const MINT_PREFIX = "OHMAIL";

/**
 * Every prefix {@link normalizeInviteCode} recognises — and it must recognise ALL of them
 * forever, or at least for as long as a code carrying one can still be outstanding.
 *
 * `MAILOH` is the pre-rebrand shape — the product was renamed once. It is here because
 * `code_hash` is `sha256` of the canonical string, so the prefix is INSIDE the hash: a
 * code minted as `MAILOH-…` hashes to a value only the string `MAILOH-…` reproduces. When
 * the rename swapped the mint prefix it also, silently, made this function stop
 * canonicalising the old shape — a legacy code pasted lower-cased or space-separated (the
 * two inputs this function exists to accept) fell through the early return, hashed as raw
 * user input, matched nothing, and was refused as `invite_invalid` with a message telling
 * its holder the code was not for their address. That is a real person locked out
 * mid-signup by a string rename, and no test could see it: the regression test mints a
 * code and therefore always tests the CURRENT prefix.
 *
 * The rule this encodes: **a mint prefix is append-only.** Adding one is a one-line change
 * here; removing one invalidates every outstanding code carrying it, so a prefix may only
 * be dropped after a full invite TTL (14 days) has passed with none unconsumed —
 * `pnpm invite list --pending` is the check.
 */
const CODE_PREFIXES = [MINT_PREFIX, "MAILOH"] as const;

export function generateInviteCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${MINT_PREFIX}-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/**
 * Canonicalise a code a human typed or pasted before it is hashed.
 *
 * Upper-cases, strips everything that is not an alphabet symbol, and re-groups. So
 * `  ohmail xxxx-xxxx xxxx `, `OHMAILXXXXXXXXXXXX` and the exact minted string all hash
 * to the same value, while a genuinely different code still does not. Anything that does
 * not have the shape of one of our codes is returned trimmed and untouched, so the static
 * `inviteCodes` bootstrap path (arbitrary operator strings) keeps working unchanged.
 *
 * The PREFIX IS PRESERVED, never rewritten to the current one: it is part of the hashed
 * string, so a `MAILOH-` code must canonicalise back to `MAILOH-…`. See {@link CODE_PREFIXES}.
 */
export function normalizeInviteCode(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  const upper = value.toUpperCase();
  const prefix = CODE_PREFIXES.find((p) => upper.startsWith(p));
  if (!prefix) return value;
  const body = upper.slice(prefix.length).replace(new RegExp(`[^${ALPHABET}]`, "g"), "");
  if (body.length !== 12) return value;
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/**
 * Delete invites that expired more than `olderThanMs` ago (default 90 days).
 *
 * Consumed rows are KEPT: `consumed_by_user_id` is how "which invite opened this account"
 * is answered, and that question outlives the invite. Housekeeping only — nothing depends
 * on it for correctness. Runs from the same maintenance path as
 * `MailService.pruneRateLimitWindows`.
 */
export async function pruneExpiredInvites(
  tx: Tx, now: Date, olderThanMs = 90 * 24 * 60 * 60_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const deleted = await tx.delete(invites)
    .where(and(isNull(invites.consumedAt), sql`${invites.expiresAt} < ${cutoff.toISOString()}::timestamptz`))
    .returning({ id: invites.id });
  return deleted.length;
}
