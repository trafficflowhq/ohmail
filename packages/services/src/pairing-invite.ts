import { type Tx } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { issueInvite } from "./invites.js";
import { normalizeRecipient } from "./mail/port.js";
import { runInTransaction, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { consumePairingToken, pairingInvalid } from "./pairing.js";

/**
 * THE INVITE-GRANT REDEEM — the half of the pairing lifecycle that bridges to the Cloud-half
 * `invites` table, split out of `pairing.ts` so the rest of that module could ride the `./auth`
 * entry the desktop engine bundles. FULL BARREL ONLY, like `invites.ts` beside it: never on
 * `./auth` (the engine's store has no `invites` table — the desktop-host door refuses the grant,
 * `validation_failed`) and never on `./mail/index.ts`. `auth-entry-census.test.ts` pins the
 * boundary. The why of redemption — the atomic burn, the one-sentence refusal, entropy as the
 * defense — is `pairing.ts`'s header; this file only adds the invite bridge on top of
 * `consumePairingToken`.
 */

/** `asTx` only — the transaction wrapper is `runInTransaction` in `context.ts`, shared so that a
 *  credential report made inside one cannot be released before the commit. There were three
 *  copies of it here and only one of them buffered. */
const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

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
 * presented address, in ONE transaction — a failed mint un-burns the token; the email is
 * validated first. The code goes into `POST /auth/register`. Whether registration starts
 * EMAIL-VERIFIED rides on `confers_verified`, read off the CONSUMED TOKEN ROW, never off caller
 * input — the endpoint is anonymous. `created_by_user_id IS NULL` is the first-boot setup token,
 * read off the server's own stdout: control of the box is control of the operator's login, so it
 * CONFERS. A user's token confers NOTHING — nothing was mailed. Trade-off: a holder learns from
 * register's 409 whether an address has an account; one bit, costs the token.
 */
export async function redeemInviteGrant(
  ctx: ServiceContext, input: { token: string; email: string },
): Promise<InviteGrantRedeemed> {
  const email = normalizeRecipient(input.email ?? "");
  if (!email) throw new ServiceError("validation_failed", 400, "a valid email address is required");

  return runInTransaction(ctx, async (txCtx) => {
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
