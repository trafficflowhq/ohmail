import { type Tx } from "@trafficflow/db";
import { issueInvite } from "./invites.js";
import { normalizeRecipient } from "./mail/port.js";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { consumePairingToken, pairingInvalid } from "./pairing.js";

/**
 * THE INVITE-GRANT REDEEM — the half of the pairing lifecycle that bridges to the Cloud-half
 * `invites` table, split out of `pairing.ts` in Phase 3 so the rest of that module could
 * ride the `./auth` entry the desktop engine bundles. FULL BARREL ONLY, like `invites.ts`
 * beside it: never on `./auth` (the engine's store has no `invites` table — the desktop-host
 * door refuses the grant instead, `validation_failed`) and never on `./mail/index.ts`.
 * `auth-entry-census.test.ts` pins the boundary.
 *
 * Everything about WHY redemption works the way it does — the atomic burn, the one-sentence
 * refusal, entropy as the defense — is `pairing.ts`'s header; this file only adds the invite
 * bridge on top of that module's `consumePairingToken`.
 */

/** The `asTx`/`inTransaction` pair, `pairing.ts`'s own two lines restated (module-internal there). */
const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
const inTransaction = async <T>(
  ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>,
): Promise<T> =>
  asTx(ctx).transaction(async (tx) => fn({ ...ctx, db: tx as unknown as ServiceContext["db"] }));

/**
 * How long the email-bound invite minted by an invite-grant redeem lives. Deliberately short:
 * the redeem → register round-trip is one page flow, and the pairing token already carried the
 * waiting. A leaked invite code is email-bound, so this is belt to that braces.
 */
export const PAIRING_INVITE_TTL_MS = 15 * 60_000;

export interface InviteGrantRedeemed {
  /** The raw invite code — the client's next move is `POST /auth/register` with it. */
  code: string;
  /** The address the invite is bound to, normalised. */
  email: string;
  /** When the minted INVITE expires ({@link PAIRING_INVITE_TTL_MS}) — not the token, which is spent. */
  expiresAt: Date;
}

/**
 * Redeem an `invite`-grant token: consume it and mint an email-bound `invites` row for the
 * address the redeemer presents, in ONE transaction — if the invite mint fails, the rollback
 * un-burns the token (`consumeInvite`-inside-register's rule, from the other side). The email
 * is validated BEFORE anything is consumed for the same reason.
 *
 * The returned code goes straight into the existing `POST /auth/register`. Whether that
 * registration starts EMAIL-VERIFIED rides on the minted invite's `confers_verified`, and the
 * answer is read off the CONSUMED TOKEN ROW inside this same transaction — never off anything
 * the redeemer sent, because this endpoint is anonymous and a caller-writable flag here would
 * let any token holder mint themselves a verified account for an address they do not control:
 *
 *  · `created_by_user_id IS NULL` — the FIRST-BOOT setup token, mintable only by the
 *    composition root before any session machinery exists (the API mint always has a session
 *    user). Whoever presents it read it off the server's own stdout, and control of the box IS
 *    control of the operator's login identifier on that box — so it CONFERS.
 *  · a user's token — its holder types any address they like, nothing was ever mailed, receipt
 *    proves nothing. The invite registers the account and confers NOTHING; the address is
 *    proven later through the ordinary mailed verification flow, exactly like an open signup.
 *
 * Sworn trade-off, said out loud: the pairing token is NOT email-bound, so its holder can spend
 * it on an address of their choosing and learn from register's invite-path 409 whether that
 * address already has an account here. One bit, costs the whole token, on a server whose
 * operator minted the token — accepted.
 */
export async function redeemInviteGrant(
  ctx: ServiceContext, input: { token: string; email: string },
): Promise<InviteGrantRedeemed> {
  const email = normalizeRecipient(input.email ?? "");
  if (!email) throw new ServiceError("validation_failed", 400, "a valid email address is required");

  return inTransaction(ctx, async (txCtx) => {
    const consumed = await consumePairingToken(txCtx, { token: input.token, grant: "invite" });
    if (!consumed) throw pairingInvalid();
    const now = txCtx.now();
    const invite = await issueInvite(asTx(txCtx), {
      email,
      expiresAt: new Date(now.getTime() + PAIRING_INVITE_TTL_MS),
      now,
      issuedBy: `pairing:${consumed.id}`,
      // THE DISCRIMINATOR, from the burned row's RETURNING and nowhere else — `input` has no
      // such field and must never grow one (see the header). Only the ownerless first-boot
      // token proves address control.
      confersVerified: consumed.createdByUserId === null,
      // NO `note`. The token's label is the CREATOR's own words, and this invite row is keyed by
      // the REDEEMER's email and outlives the creator's account — account erasure cleans
      // `pairing_tokens` but not an invite bound to someone else's address. Copying the label
      // here would leave a fragment of the creator's authored text behind after they are gone.
      // `issued_by = pairing:<id>` already carries every bit of traceability the label provided.
      note: null,
    });
    return { code: invite.code, email: invite.email, expiresAt: invite.expiresAt };
  });
}
