import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { accounts, pairingTokens, users } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations, MIGRATION_LOCK_KEY } from "@trafficflow/db/admin";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import {
  ensureSetupTokenInvariant, mintFirstRunSetupToken, printSetupToken,
  SETUP_TOKEN_LOCK_KEY, SETUP_TOKEN_LABEL,
} from "../src/setup-token.js";
import { API_CLOCK_LOCK_KEY } from "../src/clock-lock.js";

/**
 * THE FIRST-BOOT MINT RACE, on real Postgres — the server slice's acceptance "two concurrent boots
 * mint at most one live setup token". PGlite structurally cannot host this: the whole subject
 * is two physical connections contending on `pg_advisory_xact_lock`, and one connection
 * serializes everything into a green lie.
 *
 * A THROWAWAY database per run, not the shared accumulator: the invariant under test is
 * "zero users ⇒ mint", and the accumulator has users. CREATE DATABASE on the same :5433
 * server is the worker-test precedent for exactly this need.
 */
const PG_UP = await realPgAvailable();

/* Built and removed by the hooks below, which name the budgets that work costs. */
const box = throwawayDb("server_boot");
const url = (): string => box.url;

let a: OwnedDb;
let b: OwnedDb;

describe.skipIf(!PG_UP)("the first-run setup token mint", () => {
  beforeAll(async () => {
    await box.create((fresh) => runMigrations(fresh));
    a = makeOwnedDb(url());
    b = makeOwnedDb(url());
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await box.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  const liveOwnerless = async (): Promise<Array<{ id: string }>> => {
    const now = new Date();
    return a.db.select({ id: pairingTokens.id }).from(pairingTokens).where(and(
      isNull(pairingTokens.createdByUserId),
      eq(pairingTokens.grant, "invite"),
      isNull(pairingTokens.consumedAt),
      isNull(pairingTokens.revokedAt),
      gt(pairingTokens.expiresAt, now),
    ));
  };

  it("CONCURRENT boots leave at most one live setup token (each may print; one can redeem)", async () => {
    // SIX concurrent boots across two separate pools — real physical connections, so the
    // advisory lock is genuinely contended. Six rather than two so a lucky serialization
    // cannot green a lockless mutant: without the lock the concurrent transactions cannot
    // see each other's uncommitted rows and several tokens survive live.
    const boots = await Promise.all(
      Array.from({ length: 6 }, (_, i) => mintFirstRunSetupToken((i % 2 === 0 ? a : b).db)),
    );
    // Zero users, so EVERY boot mints (each supersedes its predecessors) — none may skip: a
    // skipped boot on a lost log would lock the operator out of an empty server.
    for (const minted of boots) expect(minted).not.toBeNull();
    expect(new Set(boots.map((m) => m!.token)).size).toBe(6);
    expect(boots[0]!.label).toBe(SETUP_TOKEN_LABEL);

    const live = await liveOwnerless();
    expect(live).toHaveLength(1);
  });

  it("a RESTART supersedes: the previous live token is revoked in the same transaction", async () => {
    const before = await liveOwnerless();
    expect(before).toHaveLength(1);
    const reboot = await mintFirstRunSetupToken(a.db);
    expect(reboot).not.toBeNull();
    const after = await liveOwnerless();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before[0]!.id);
  });

  it("with a user present, the boot mints NOTHING — needsSetup is over", async () => {
    // A bare account+user pair so the FK holds; the boot-ceremony pg test drives the real path.
    const [acct] = await a.db.insert(accounts).values({}).returning({ id: accounts.id });
    await a.db.insert(users).values({ accountId: acct!.id, email: "owner@example.com" });
    expect(await mintFirstRunSetupToken(a.db)).toBeNull();
    // …and the boot did not revoke the standing token either: minting nothing means TOUCHING
    // nothing (the mint and the supersede live in one guarded branch).
    expect(await liveOwnerless()).toHaveLength(1);
  });

  it("the INVARIANT revokes a live ownerless token on a server that has users (the restart residue)", async () => {
    // The reachable residue: a restart's mint cannot see an uncommitted first registration, so
    // its token survives the commit. Plant that end state directly, then enforce.
    await a.db.insert(pairingTokens).values({
      createdByUserId: null,
      grant: "invite",
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      label: SETUP_TOKEN_LABEL,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    expect((await liveOwnerless()).length).toBeGreaterThan(0);
    await ensureSetupTokenInvariant(a.db);
    expect(await liveOwnerless()).toHaveLength(0);
  });

  it("…and RE-ARMS setup when the last user leaves while the process is up", async () => {
    // The other direction: /hello must never advertise needsSetup for a ceremony whose token
    // exists nowhere. Empty the server (this database holds the one hand-made user), enforce,
    // and the fresh token both surfaces through onMinted and is the ONE live token.
    await a.db.delete(users);
    const printed: string[] = [];
    await ensureSetupTokenInvariant(a.db, { onMinted: (m) => printed.push(m.token) });
    expect(printed).toHaveLength(1);
    expect(await liveOwnerless()).toHaveLength(1);
    // Idempotent: a second enforcement (the next /hello) neither churns nor re-prints.
    await ensureSetupTokenInvariant(a.db, { onMinted: (m) => printed.push(m.token) });
    expect(printed).toHaveLength(1);
    expect(await liveOwnerless()).toHaveLength(1);
  });

  it("the raw token appears ONCE, in the print block, and never in a log-shaped line", () => {
    const lines: string[] = [];
    const minted = { id: "x", token: "RAW-TOKEN-VALUE", grant: "invite" as const, label: SETUP_TOKEN_LABEL, expiresAt: new Date() };
    printSetupToken(minted, (l) => lines.push(l));
    expect(lines.filter((l) => l.includes("RAW-TOKEN-VALUE"))).toHaveLength(1);
  });

  it("the advisory-lock key collides with neither the migrator's nor the leader band", () => {
    expect(SETUP_TOKEN_LOCK_KEY).not.toBe(MIGRATION_LOCK_KEY);
    // The worker's leader band is 4207270001n + shard (leader-lock.ts); no plausible shard
    // count reaches 9100 above it.
    const LEADER_BAND_START = 4207270001n;
    expect(SETUP_TOKEN_LOCK_KEY - LEADER_BAND_START).toBeGreaterThan(1000n);
    expect(SETUP_TOKEN_LOCK_KEY > MIGRATION_LOCK_KEY).toBe(true);
    // The API clocks' key sits between the leader band and the migrator's, clear of all three.
    expect(API_CLOCK_LOCK_KEY - LEADER_BAND_START).toBeGreaterThan(1000n);
    expect(MIGRATION_LOCK_KEY - API_CLOCK_LOCK_KEY).toBeGreaterThanOrEqual(1000n);
    expect(SETUP_TOKEN_LOCK_KEY - API_CLOCK_LOCK_KEY).toBeGreaterThan(1000n);
  });
});
