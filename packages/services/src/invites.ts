import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { invites, waitlist } from "@trafficflow/db/cloud";
import { hashToken } from "./auth/crypto.js";
import { normalizeRecipient } from "./mail/port.js";
import { ServiceError } from "./errors.js";

/**
 * The consumable, email-bound, expiring invite. Two functions and a refusal taxonomy, here
 * because BOTH sides need them: `AuthService.register` CONSUMES one inside the account-creating
 * transaction; the operator mint path ISSUES one. Consumption is a SINGLE STATEMENT — `UPDATE …
 * WHERE code_hash AND email AND consumed_at IS NULL AND expires_at > now RETURNING id` — never
 * SELECT-then-check-then-UPDATE: two concurrent presentations both pass and one invite opens two
 * accounts, invisible to any sequential test. The row lock decides and exactly one caller gets a
 * row back. The `email` predicate is IN the same statement: the binding must not be a separate
 * check some later caller can forget.
 */

/**
 * Why an invite was refused — each maps to a different true sentence and remedy, which is why
 * this is a table and not a `Set.has`. `unknown` — no row carries this code, or it is bound to a
 * different address (the same answer, see {@link classifyInviteFailure}). `used` — redeemed
 * already; sign in. `expired` — real, past `expires_at`; ask for a new one. `revoked` — an
 * operator took it back; the wire message is DELIBERATELY the expired one: a code's holder is not
 * always the person it was meant for — revocation is what happens when it is not — and telling
 * them somebody noticed buys nothing. It stays a distinct refusal internally because the
 * operator's logs must distinguish the two.
 */
export type InviteRefusal = "unknown" | "used" | "expired" | "revoked";

export interface InviteConsumed {
  ok: true;
  inviteId: string;
  /** The address the code was bound to — already normalised. */
  email: string;
  /**
   * Does this consumption prove the caller controls `email`? Read off the consumed ROW
   * (`invites.confers_verified`) in the same statement that burned it — register stamps
   * `email_verified_at` only when this is true. TRUE for mailed invites (receipt is the
   * proof); FALSE for invites minted by a user's pairing-token redeem, where the redeemer
   * typed the address and nothing was ever mailed. See the column's doc in the cloud schema.
   */
  confersVerified: boolean;
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
    .returning({ id: invites.id, email: invites.email, confersVerified: invites.confersVerified });

  if (row) return { ok: true, inviteId: row.id, email: row.email, confersVerified: row.confersVerified };
  return { ok: false, refusal: await classifyInviteFailure(tx, codeHash, email, input.now) };
}

/**
 * Why the UPDATE matched nothing — the ONLY place an invite's state is disclosed. The rule:
 * `used` and `expired` are told only to a caller who already proved they hold the bound address.
 * A code bound to someone else, or no code at all, is `unknown` — byte-identical answers — so a
 * stranger holding a leaked code learns nothing about which addresses have invites, and a code
 * holder cannot walk the table. The `email` predicate is applied as an equality on the row's own
 * column rather than re-running the UPDATE's WHERE: one indexed lookup on the unique `code_hash`,
 * no second write.
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
 * Mint an invite for `email` and return the RAW code — the only time it exists in memory on our
 * side. Also stamps `waitlist.invited_at` when the address is on the list. `confersVerified`
 * DEFAULTS TRUE, matching the column: an omitted flag asserts the mailed-invite semantic —
 * redeeming proves receipt. Every production caller states its answer: the pairing-token redeem
 * passes the consumed token row's own discriminator; the operator mint passes FALSE and upgrades
 * through {@link markInviteDelivered} only after the transport reports `sent`. Whatever the
 * source, it must be the caller's OWN record, never anything ITS caller sent: the flag chooses
 * whether an account is born verified.
 */
export async function issueInvite(
  tx: Tx,
  input: {
    email: string; expiresAt: Date; now: Date; issuedBy?: string; note?: string | null;
    confersVerified?: boolean;
  },
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
    // ABSENT means true (every caller that omits it mails, and receipt is the proof), but a
    // PRESENT value confers only when it is exactly the boolean `true`: this flag decides
    // whether an account is born verified, so a malformed value from a JavaScript caller must
    // degrade to "verify by mail later" — the harmless side — never to a conferred mark.
    confersVerified: input.confersVerified === undefined || input.confersVerified === true,
  }).returning({ id: invites.id });

  await tx.update(waitlist)
    .set({ invitedAt: input.now, updatedAt: input.now })
    .where(eq(waitlist.email, email));

  return { code, inviteId: row!.id, email, expiresAt: input.expiresAt };
}

/**
 * Record that this invite's mail actually went out — the PROOF upgrade. The operator mint issues
 * its row NON-conferring and calls this only on a `sent` result: a `send: false` mint, a failed
 * transport and a skipped send all leave the row non-conferring, and such an account proves its
 * address through the ordinary mailed flow. Issue-then-upgrade, never issue-true-then-demote: a
 * crash between the steps lands on the harmless side — a mailed code that happens not to confer,
 * never a conferring row for a code no inbox received. The `consumed_at IS NULL` conjunct keeps
 * it honest: rewriting the flag after consumption would claim a proof that arrived after the
 * account was born.
 */
export async function markInviteDelivered(tx: Tx, inviteId: string): Promise<boolean> {
  const rows = await tx.update(invites)
    .set({ confersVerified: true })
    .where(and(eq(invites.id, inviteId), isNull(invites.consumedAt)))
    .returning({ id: invites.id });
  return rows.length === 1;
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
 * Take back every live invite for `email`. The point is that it is the same statement as the
 * check: one `UPDATE … WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now`, so
 * it cannot revoke a code somebody is redeeming in the same instant and then report success — the
 * row lock decides, exactly as in {@link consumeInvite}. A consumed invite is deliberately NOT
 * touched: `consumed_by_user_id` is the record of which invite opened which account, and revoking
 * after the fact would rewrite history without closing anything. Called on its own (`pnpm invite
 * revoke`) and by `mintInvite --force` — "issue another one" without "cancel the old one" is how
 * a leaked code stays live beside its replacement.
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
 * A human-transcribable invite code: `OHMAIL-XXXX-XXXX-XXXX`. The FORMAT IS THE CODE —
 * `code_hash` is `sha256` of exactly this string, so changing the shape invalidates every
 * outstanding invite (the rename did exactly this; {@link CODE_PREFIXES} is append-only and a
 * shape change is a migration question). Not `generateToken()`: this value is typed by a person,
 * and 43 characters of mixed-case base64url is a transcription-error generator. The alphabet is
 * Crockford-ish: no `I`, `L`, `O`, `U`. Entropy: 12 symbols × 5 bits = 60 bits, unbiased because
 * 256 is an exact multiple of 32. Guessing is not the threat model; transcription is.
 * Normalisation on the way in is `normalizeInviteCode`.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The prefix every code minted from now on carries. */
const MINT_PREFIX = "OHMAIL";

/**
 * Every prefix {@link normalizeInviteCode} recognises — ALL of them, for as long as a code
 * carrying one can be outstanding. `MAILOH` is the pre-rebrand shape: the prefix is INSIDE the
 * hash, so when the rename swapped the mint prefix it silently stopped canonicalising the old
 * shape — a legacy code pasted lower-cased fell through the early return, hashed as raw input,
 * and was refused: a real person locked out mid-signup by a string rename, invisible to the
 * regression test, which mints a code and therefore always tests the CURRENT prefix. The rule: a
 * mint prefix is APPEND-ONLY; one may be dropped only after a full invite TTL has passed with
 * none unconsumed — `pnpm invite list --pending` is the check.
 */
const CODE_PREFIXES = [MINT_PREFIX, "MAILOH"] as const;

export function generateInviteCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${MINT_PREFIX}-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/**
 * Canonicalise a code a human typed or pasted, before it is hashed. Upper-cases, strips
 * everything that is not an alphabet symbol, re-groups — so ` ohmail xxxx-xxxx xxxx `,
 * `OHMAILXXXXXXXXXXXX` and the exact minted string hash to the same value, while a genuinely
 * different code does not. Anything without the shape of one of our codes is returned trimmed and
 * untouched, so the static `inviteCodes` bootstrap path (arbitrary operator strings) keeps
 * working. The PREFIX IS PRESERVED, never rewritten to the current one: it is part of the hashed
 * string, so a `MAILOH-` code must canonicalise back to `MAILOH-…` — see {@link CODE_PREFIXES}.
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
