import { and, count, eq, gt, isNull, isNotNull, desc, type SQL } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { pairingTokens } from "@trafficflow/db";
import { generateToken, hashToken } from "./auth/crypto.js";
import type { ServiceContext } from "./context.js";
import type { OAuthTokens } from "./auth/types.js";
import { ServiceError } from "./errors.js";

/**
 * THE PAIRING-TOKEN LIFECYCLE — mint, list, revoke, redeem — for the ceremonies where an
 * account (or a fresh server) hands a stranger-shaped credential across a QR code, a chat
 * message or a boot log:
 *
 *  · **`invite` grant** — the standalone server's first-account setup token and the family
 *    invite. Redeeming consumes the token and mints an EMAIL-BOUND `invites` row for the
 *    address the redeemer presents; the client then runs the existing `POST /auth/register`.
 *    No mailer is ever needed — the pairing token took the invite's delivery leg over the
 *    operator's own channel — and THAT is the property this bridge buys: registration, not
 *    verification. Whether the account starts VERIFIED is decided by the consumed token's own
 *    record (see {@link redeemInviteGrant}): the first-boot OWNERLESS token confers it, a
 *    user-minted token does not, because its holder typed an address nothing was mailed to.
 *  · **`device-pair` grant** — QR device pairing. Redeeming consumes the token and mints a
 *    device-labelled session + refresh family FOR THE TOKEN'S CREATOR, on the desktop-handoff
 *    claim model (`AuthService.claimDesktopLink`): the token is the credential, the response
 *    is the bearer pair, and `GET /devices` / `DELETE /devices/:id` are what make the offer
 *    safe — the paired device is visible and revocable from day one.
 *
 * ── THE ONE THING THAT MATTERS ABOUT REDEMPTION ─────────────────────────────────────────────
 *
 * It is ONE statement (the `consumeInvite` / `claimDesktopLink` discipline):
 *
 *   UPDATE pairing_tokens SET consumed_at = $now
 *    WHERE token_hash = $1 AND "grant" = $2
 *      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $now
 *    RETURNING id, "grant", label, created_by_user_id
 *
 * Never SELECT-then-check-then-UPDATE: two concurrent presentations of one token would both
 * read `consumed_at IS NULL`, both pass, and both proceed — one token, two sessions — and no
 * sequential test (and no PGlite test: one connection) can ever see it. The row lock decides,
 * and exactly one presenter gets a row back. `pairing.pg.test.ts` races this on real Postgres.
 *
 * The GRANT is a conjunct of the same statement, exactly as the PKCE binding is a conjunct of
 * the desktop claim's: a device-pair token presented to the invite arm (or vice versa) matches
 * NO row, is NOT burned, and gets the same refusal as an unknown token. Checking the grant
 * after consuming would let a mismatched presentation destroy a token it could not spend.
 *
 * ── ENTROPY IS THE DEFENSE ON REDEEM — DELIBERATELY NO LOCKOUT TABLE ────────────────────────
 *
 * `POST /pair/redeem` is public and anonymous. The raw token is `generateToken()` — 32 random
 * bytes, 256 bits, base64url — single-use, TTL-bounded, and matched against a UNIQUE hash
 * column. That search space is not walkable at any request rate a server survives, and a
 * lockout keyed on anything an anonymous caller chooses is a denial-of-service lever
 * (`claimDesktopLink`'s own reasoning, applied one step further: this table does not even take
 * the per-IP slot claim, because on a self-host box behind an arbitrary proxy there is no
 * trustworthy client identity to key it on, and the credential's entropy needs no help).
 *
 * ── ONE SENTENCE FOR EVERY WAY REDEEM CAN FAIL ──────────────────────────────────────────────
 *
 * Unknown, expired, revoked, already consumed, the wrong grant, and the loser of a race all
 * get {@link pairingInvalid}. Unlike an invite — whose holder proved they hold the bound
 * address, and so may be told `used` vs `expired` — a pairing token binds to nothing, so any
 * classification would disclose token state to whoever holds a leaked one. The remedy is
 * identical in every case: ask the minter for a fresh token.
 *
 * ── WHY THESE ARE FUNCTIONS OVER A `ServiceContext`, NOT A CLASS ────────────────────────────
 *
 * The same shape as `invites.ts`, and for the same reason: two very different callers need the
 * mint — the API route (session + step-up) and the standalone server's composition root at
 * first boot, which mints one invite-grant token with NO user before any session machinery
 * exists (`mintPairingToken(bootCtx, { grant: "invite", label: "first-run setup" })` with
 * `bootCtx.userId === null`). The creator is read from `ctx.userId`, so the boot mint's
 * ownerless row falls out of the context rather than out of a special-case flag.
 *
 * ── WHERE THIS MODULE MAY BE EXPORTED FROM, AND WHERE ITS INVITE ARM MAY NOT ─────────────
 *
 * Since Phase 3 this module reaches ONLY the shared half — `pairing_tokens` is mail-half
 * (mail 0059) and the device-pair redeem's session mint arrives through a port — so it rides
 * the `./auth` entry the desktop engine bundles. The INVITE-grant redeem is the half that
 * bridges to the Cloud-half `invites` table, and it therefore lives in `pairing-invite.ts`,
 * which stays FULL BARREL ONLY: never on `./auth`, never on `./mail/index.ts`. The
 * `auth-entry-census.test.ts` walk pins both facts.
 */

export type PairingGrant = "invite" | "device-pair";

/** Runtime whitelist behind the type, for JavaScript callers and wire input. */
const GRANTS: ReadonlySet<string> = new Set<PairingGrant>(["invite", "device-pair"]);

/**
 * TTL bounds per grant, in milliseconds. Deliberately different orders of magnitude:
 *
 *  · `invite` defaults to 7 days (cap 30) — a first-boot setup token has to survive until the
 *    operator reads the boot log, and a family invite until its recipient gets around to it.
 *    The token is single-use and the invite it mints is itself email-bound and short-lived.
 *  · `device-pair` defaults to 5 minutes (cap 15) — a QR pairing is an in-the-moment ceremony,
 *    and the bound is load-bearing for more than tidiness: the mint is step-up-gated, so a
 *    short TTL keeps the redeem near the factor assertion that authorized it. The session the
 *    redeem mints still starts with NO step-up standing of its own (see
 *    {@link PairedDeviceSessionMinter}), so the cap bounds exposure, not privilege.
 *
 * A caller asking for more than the cap (or less than the floor) is REFUSED, never clamped: a
 * clamp hides the caller's bug and ships a credential with a lifetime nobody chose.
 */
export const PAIRING_TTL_BOUNDS: Record<PairingGrant, { defaultMs: number; minMs: number; maxMs: number }> = {
  invite: { defaultMs: 7 * 24 * 60 * 60_000, minMs: 60_000, maxMs: 30 * 24 * 60 * 60_000 },
  "device-pair": { defaultMs: 5 * 60_000, minMs: 60_000, maxMs: 15 * 60_000 },
};

/** The minter's words, shown in lists and stamped onto a paired device row. Bounded, not clamped. */
export const PAIRING_LABEL_MAX = 100;

/**
 * At most this many LIVE (unconsumed, unrevoked, unexpired) tokens per creator. The mint is
 * authenticated and step-up-gated, so this is a growth bound rather than an abuse gate: unlike
 * `issueDesktopLink`, which supersedes because at most one handoff code may exist, several live
 * pairing tokens are legitimate (a family invite pending beside a device pair). The bound keys
 * on the CREATOR, so it does not apply to the composition root's ownerless first-boot mint —
 * that path is operator code, not an API caller, and the boot is expected to supersede its own
 * previous setup token rather than accumulate them.
 */
export const PAIRING_LIVE_TOKENS_MAX = 20;

/**
 * How long the email-bound invite minted by an invite-grant redeem lives. Deliberately short:
 * the redeem → register round-trip is one page flow, and the pairing token already carried the
 * waiting. A leaked invite code is email-bound, so this is belt to that braces.
 */
export const PAIRING_INVITE_TTL_MS = 15 * 60_000;

/** The one refusal every failed redeem gets. See the header for why it is one sentence. */
export function pairingInvalid(): ServiceError {
  return new ServiceError(
    "pairing_invalid", 400,
    "That pairing token is not valid. Ask whoever minted it for a fresh one.",
  );
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

const inTransaction = async <T>(
  ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>,
): Promise<T> =>
  asTx(ctx).transaction(async (tx) => fn({ ...ctx, db: tx as unknown as ServiceContext["db"] }));

export interface PairingTokenMinted {
  id: string;
  /** The RAW token. This is the only time it exists on our side; only its sha256 is stored. */
  token: string;
  grant: PairingGrant;
  label: string;
  expiresAt: Date;
}

/**
 * Mint one pairing token and return the raw value ONCE. The creator is `ctx.userId` — the
 * route's session user, or `null` from the standalone server's first-boot mint (invite grant
 * only; a device-pair token without a creator would mint a session for nobody and is refused
 * here rather than discovered unredeemable later).
 */
export async function mintPairingToken(
  ctx: ServiceContext,
  input: { grant: PairingGrant; label?: string | null; ttlSeconds?: number },
): Promise<PairingTokenMinted> {
  const grant = input.grant;
  if (typeof grant !== "string" || !GRANTS.has(grant)) {
    throw new ServiceError("validation_failed", 400, 'grant must be "invite" or "device-pair"');
  }
  const createdByUserId = ctx.userId ?? null;
  if (grant === "device-pair" && createdByUserId === null) {
    throw new ServiceError(
      "validation_failed", 400,
      "a device-pair token needs a signed-in creator: its redeem mints a session for that user",
    );
  }

  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length > PAIRING_LABEL_MAX) {
    throw new ServiceError("validation_failed", 400, `label must be at most ${PAIRING_LABEL_MAX} characters`);
  }

  const bounds = PAIRING_TTL_BOUNDS[grant];
  let ttlMs = bounds.defaultMs;
  if (input.ttlSeconds !== undefined) {
    const s = input.ttlSeconds;
    if (typeof s !== "number" || !Number.isFinite(s) || !Number.isInteger(s)) {
      throw new ServiceError("validation_failed", 400, "ttlSeconds must be an integer number of seconds");
    }
    ttlMs = s * 1000;
    if (ttlMs < bounds.minMs || ttlMs > bounds.maxMs) {
      throw new ServiceError(
        "validation_failed", 400,
        `ttlSeconds for a ${grant} token must be between ${bounds.minMs / 1000} and ${bounds.maxMs / 1000}`,
      );
    }
  }

  const now = ctx.now();
  const tx = asTx(ctx);

  // The growth bound. A soft read (READ COMMITTED lets two concurrent mints both see cap-1),
  // which is the register capacity valve's own documented posture: the number is a rough limit
  // on an authenticated, step-up-gated surface, not a security boundary, and a serialized
  // counter row would put a write lock on every mint to enforce it exactly.
  if (createdByUserId !== null) {
    const [live] = await tx.select({ n: count() }).from(pairingTokens).where(and(
      eq(pairingTokens.createdByUserId, createdByUserId),
      isNull(pairingTokens.consumedAt),
      isNull(pairingTokens.revokedAt),
      gt(pairingTokens.expiresAt, now),
    ));
    if ((live?.n ?? 0) >= PAIRING_LIVE_TOKENS_MAX) {
      throw new ServiceError(
        "pairing_mint_limit", 409,
        `you already have ${PAIRING_LIVE_TOKENS_MAX} unredeemed pairing tokens — revoke one first`,
      );
    }
  }

  const token = generateToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const [row] = await tx.insert(pairingTokens).values({
    createdByUserId,
    grant,
    tokenHash: hashToken(token),
    label,
    expiresAt,
  }).returning({ id: pairingTokens.id });

  return { id: row!.id, token, grant, label, expiresAt };
}

export type PairingTokenStatus = "live" | "consumed" | "revoked" | "expired";

export interface PairingTokenListed {
  id: string;
  grant: PairingGrant;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  status: PairingTokenStatus;
}

/**
 * The caller's OWN mints, newest first — never anyone else's (account isolation is absolute on
 * a multi-user server, and this table deliberately has no account column to widen the read
 * over), and never the hash: the projection names its columns instead of selecting the row.
 * First-boot tokens (creator NULL) are listable by nobody here; their record is the boot log.
 */
export async function listPairingTokens(ctx: ServiceContext): Promise<PairingTokenListed[]> {
  const userId = requireUser(ctx);
  const now = ctx.now();
  const rows = await asTx(ctx).select({
    id: pairingTokens.id,
    grant: pairingTokens.grant,
    label: pairingTokens.label,
    createdAt: pairingTokens.createdAt,
    expiresAt: pairingTokens.expiresAt,
    consumedAt: pairingTokens.consumedAt,
    revokedAt: pairingTokens.revokedAt,
  }).from(pairingTokens)
    .where(eq(pairingTokens.createdByUserId, userId))
    .orderBy(desc(pairingTokens.createdAt))
    // Newest hundred: the live set is capped at PAIRING_LIVE_TOKENS_MAX, so everything past
    // this bound is spent/expired history. Reaping that history is maintenance's job (the
    // `pruneExpiredInvites` path), named as a follow-up rather than half-wired here.
    .limit(100);

  return rows.map((r) => ({
    ...r,
    grant: r.grant as PairingGrant,
    // Consumed wins over revoked wins over expired: a consumed token DID something, which is
    // the fact its minter most needs to see; a revoked one was taken back deliberately.
    status: r.consumedAt !== null ? "consumed"
      : r.revokedAt !== null ? "revoked"
        : r.expiresAt.getTime() <= now.getTime() ? "expired"
          : "live",
  }));
}

/**
 * Take back one LIVE token of the caller's own. One statement, `revokeInvitesFor`'s exactly:
 * the conditions are IN the UPDATE, so it cannot revoke a token somebody is redeeming in the
 * same instant and then report success — the row lock decides. `false` means "no live token of
 * yours has this id": already consumed, already revoked, expired, somebody else's, or unknown —
 * all one answer, because the caller's own `GET /pair` already tells them which.
 */
export async function revokePairingToken(ctx: ServiceContext, id: string): Promise<boolean> {
  const userId = requireUser(ctx);
  const now = ctx.now();
  // The exact uuid shape, checked BEFORE the query: `id` arrives from the URL, and a value the
  // uuid column cannot cast (Postgres 22P02) would surface as a 500 where the answer is the
  // same "no live token of yours" every other miss gets.
  if (typeof id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const rows = await asTx(ctx).update(pairingTokens)
    .set({ revokedAt: now })
    .where(and(
      eq(pairingTokens.id, id),
      eq(pairingTokens.createdByUserId, userId),
      isNull(pairingTokens.consumedAt),
      isNull(pairingTokens.revokedAt),
      gt(pairingTokens.expiresAt, now),
    ))
    .returning({ id: pairingTokens.id });
  return rows.length === 1;
}

export interface PairingConsumed {
  id: string;
  grant: PairingGrant;
  label: string;
  createdByUserId: string | null;
}

/**
 * The atomic burn — the single statement the module header froze. `null` means "no live token
 * of this grant matches", with every cause deliberately indistinguishable. Exported for the
 * redeem flows below and for the race test; API callers go through those flows.
 *
 * For `device-pair` the WHERE also requires a creator (`created_by_user_id IS NOT NULL`):
 * {@link mintPairingToken} refuses to create the ownerless kind, but a row planted by hand must
 * refuse WITHOUT being burned rather than consume and then fail to mint a session for nobody.
 */
export async function consumePairingToken(
  ctx: ServiceContext, input: { token: string; grant: PairingGrant },
): Promise<PairingConsumed | null> {
  const raw = typeof input.token === "string" ? input.token.trim() : "";
  // Bounded before it reaches sha256, `claimDesktopLink`'s reason: this value arrives from an
  // anonymous caller and an unbounded body is free work. A real token is 43 characters.
  if (raw.length === 0 || raw.length > 512) return null;
  if (!GRANTS.has(input.grant)) return null;
  const now = ctx.now();

  const conditions: SQL[] = [
    eq(pairingTokens.tokenHash, hashToken(raw)),
    eq(pairingTokens.grant, input.grant),
    isNull(pairingTokens.consumedAt),
    isNull(pairingTokens.revokedAt),
    gt(pairingTokens.expiresAt, now),
  ];
  if (input.grant === "device-pair") conditions.push(isNotNull(pairingTokens.createdByUserId));

  const [row] = await asTx(ctx).update(pairingTokens)
    .set({ consumedAt: now })
    .where(and(...conditions))
    .returning({
      id: pairingTokens.id,
      grant: pairingTokens.grant,
      label: pairingTokens.label,
      createdByUserId: pairingTokens.createdByUserId,
    });
  if (!row) return null;
  return { ...row, grant: row.grant as PairingGrant };
}

/**
 * The one thing the device-pair redeem needs from the auth service, as a port: the session
 * mint. `AuthService.establishPairedDevice` is the implementation — the same `establish`
 * machinery behind `claimDesktopLink`, never hand-rolled here — and taking it as a parameter
 * keeps this module free of the auth service's construction graph.
 */
export interface PairedDeviceSessionMinter {
  establishPairedDevice(
    ctx: ServiceContext, b: { userId: string; label: string; kind: "web" | "macos" },
  ): Promise<{ tokens: OAuthTokens }>;
}

/**
 * Redeem a `device-pair` token: consume it and mint a device-labelled session + refresh family
 * for the token's CREATOR — pairing signs a new device into the minter's own account, which is
 * why the mint demanded a session and step-up. One transaction, so a mint failure un-burns the
 * token (stricter than the desktop claim, which accepts a burned code on a crash; a pairing
 * token may have crossed a room on paper, so it is not re-mintable with one click).
 *
 * The response is the bearer pair and nothing else — `claimDesktopLink`'s shape exactly, and
 * for its reasons: a Set-Cookie would turn a token shown on a screen into a browser session.
 *
 * ── `kind` — WHAT the redeemer is, declared by the redeemer, for the DEVICE ROW only ────────
 *
 * The device row used to be stamped `macos` unconditionally — a wire wart from the desktop-link
 * tail this redeem was modelled on, and a lie once a phone BROWSER became the ordinary redeemer
 * (Phase 3's QR flow): the device list said a Mac was paired when a browser was. The redeemer
 * now declares itself; ABSENT means `"web"`, the QR flow's ordinary case. A PRESENT value
 * outside the closed set refuses `validation_failed` rather than clamping, and it refuses
 * BEFORE the burn: a malformed declaration is the caller's bug, and it must not cost them the
 * single-use token.
 *
 * What the declaration deliberately does NOT reach is the session's LIFETIME: it is anonymous
 * wire input, so the paired mint pins the bearer surface itself (`establishPairedDevice` —
 * its header carries the whole argument, including why a "stricter" web window would be a
 * pretence one rotation deep).
 */
export async function redeemDevicePair(
  ctx: ServiceContext, auth: PairedDeviceSessionMinter, input: { token: string; kind?: "web" | "macos" },
): Promise<{ tokens: OAuthTokens }> {
  const kind = input.kind === undefined ? "web" : input.kind;
  if (kind !== "web" && kind !== "macos") {
    throw new ServiceError("validation_failed", 400, 'device kind must be "web" or "macos"');
  }
  return inTransaction(ctx, async (txCtx) => {
    const consumed = await consumePairingToken(txCtx, { token: input.token, grant: "device-pair" });
    if (!consumed || consumed.createdByUserId === null) throw pairingInvalid();
    return auth.establishPairedDevice(txCtx, {
      userId: consumed.createdByUserId,
      label: consumed.label.length > 0 ? consumed.label : "Paired device",
      kind,
    });
  });
}

function requireUser(ctx: ServiceContext): string {
  if (!ctx.userId) throw new ServiceError("unauthorized", 401, "authentication required");
  return ctx.userId;
}
