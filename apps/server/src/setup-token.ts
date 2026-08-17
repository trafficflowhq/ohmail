import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { pairingTokens, users } from "@trafficflow/db";
import { mintPairingToken, type PairingTokenMinted } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";

/**
 * THE FIRST-RUN SETUP TOKEN — the ONE legitimate ownerless mint (`routes/self-host.ts`,
 * obligation 3): at boot with zero users, mint one invite-grant pairing token labelled
 * "first-run setup" and print the raw value ONCE to stdout. Reading the boot log proves box
 * control (the Vaultwarden pattern), the token's ownerless row is what makes the resulting
 * registration start VERIFIED (`redeemInviteGrant` reads `created_by_user_id IS NULL` off the
 * consumed row), and `/hello` reports `needsSetup: true` until the ceremony completes. No
 * `TF_INVITE_CODES` bootstrap exists in this composition, ever.
 *
 * ── WHY THERE IS AN ADVISORY LOCK, AND WHAT "AT MOST ONE" MEANS ────────────────────────────
 *
 * `mintPairingToken`'s live-token cap deliberately does NOT apply to ownerless mints ("that
 * path is operator code … expected to SUPERSEDE its own previous setup token rather than
 * accumulate them" — pairing.ts), so two boots racing this function would otherwise each mint,
 * and the boot log would show two "the" setup tokens. Two concurrent boots ARE reachable: a
 * compose restart racing a manual `docker start`, or a rolling replace by whatever supervises
 * the containers. So the
 * whole decision — count users, revoke the previous live setup tokens, mint — runs inside one
 * transaction holding `pg_advisory_xact_lock({@link SETUP_TOKEN_LOCK_KEY})`: boots SERIALIZE,
 * the loser runs after the winner's commit and supersedes it, and the invariant the pg race
 * test pins is **at most one LIVE ownerless setup token at any instant** — never two tokens
 * both able to open the first account.
 *
 * Supersede-on-restart is the deliberate direction (not skip-if-one-exists): the raw token is
 * printed exactly once and never stored, so an operator who lost the boot log has ONE remedy —
 * restart the container — and a skip would leave them permanently locked out of a server with
 * zero users. The superseded token is revoked in the same transaction, so the old log line goes
 * dead the moment the new one exists.
 */

/**
 * The advisory-lock key for the first-boot mint. The migration lock is `4207279001`
 * (`MIGRATION_LOCK_KEY`, packages/db/src/migrate.ts) and the worker's leader band starts at
 * `4207270001` + shard; this sits 100 above the migration key, which no other constant reaches
 * — `setup-token.pg.test.ts` asserts the distances so the three can never collide silently.
 */
export const SETUP_TOKEN_LOCK_KEY = 4207279101n;

export const SETUP_TOKEN_LABEL = "first-run setup";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Mint iff users == 0, superseding any earlier live setup token. `null` means "this server has
 * users — nothing to do", which is every boot after the first ceremony completes.
 */
export async function mintFirstRunSetupToken(
  db: Db,
  opts: { now?: () => Date } = {},
): Promise<PairingTokenMinted | null> {
  const now = opts.now ?? ((): Date => new Date());
  return db.transaction(async (tx) => {
    // postgres.js takes bigint at runtime; its published types omit it — migrate.ts's own cast,
    // for migrate.ts's reason: the 64-bit key must stay exact.
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_TOKEN_LOCK_KEY as unknown as number})`);

    const anyUser = await tx.select({ id: users.id }).from(users).limit(1);
    if (anyUser.length > 0) return null;

    // Supersede, never accumulate: every LIVE ownerless invite token dies with this boot's
    // mint, in the same transaction, so exactly one printed token can ever redeem.
    const at = now();
    await tx.update(pairingTokens)
      .set({ revokedAt: at })
      .where(and(
        isNull(pairingTokens.createdByUserId),
        eq(pairingTokens.grant, "invite"),
        isNull(pairingTokens.consumedAt),
        isNull(pairingTokens.revokedAt),
        gt(pairingTokens.expiresAt, at),
      ));

    // The boot context: `userId: null` is what makes this the ownerless mint, and it falls out
    // of the context rather than a special-case flag — pairing.ts designed the seam this way.
    const bootCtx: ServiceContext = {
      db: tx as unknown as ServiceContext["db"],
      accountId: "",
      userId: null,
      now,
      requestId: "boot",
    };
    return mintPairingToken(bootCtx, { grant: "invite", label: SETUP_TOKEN_LABEL });
  });
}

/**
 * The one place the raw token is EVER written out. A fenced, unmistakable block on stdout — the
 * operator's `docker compose logs api` moment — and nothing else ever sees the value: only its
 * sha256 is at rest, and the boot log line above it carries no secret.
 */
export function printSetupToken(minted: PairingTokenMinted, print: (line: string) => void): void {
  print("");
  print("──────────────────────────────────────────────────────────────────────");
  print("  FIRST-RUN SETUP");
  print("");
  print("  No account exists on this server yet. Open the app in a browser and");
  print("  enter this one-time setup token to create the first account:");
  print("");
  print(`      ${minted.token}`);
  print("");
  print(`  It can be used once and expires ${minted.expiresAt.toISOString()}.`);
  print("  Restarting the server prints a fresh token and retires this one.");
  print("──────────────────────────────────────────────────────────────────────");
  print("");
}
