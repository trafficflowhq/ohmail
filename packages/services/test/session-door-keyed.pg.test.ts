import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bindDb, sessions, users } from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, flightsOf, keyEquals, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { AuthService, generateToken, hashToken, makeTestAuthDeps, resolveSession } from "@trafficflow/services";

/**
 * THE TWO LOOK-UPS A REQUEST MAKES BEFORE ITS ACCOUNT IS KNOWN, ON THE WIRE. The session's look-up
 * and the erased-bearer look-up each ride one flight of their own that names no account and
 * carries the presented token's digest as its key: the one thing the request has proven it holds.
 * Read off the bytes a pool of one wrote. The token itself is written nowhere.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("the look-ups before sign-in are keyed by the token's digest (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const token = generateToken();
  const now = new Date();
  let accountId = "";

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    const [acct] = await pool.insert(accounts).values({ name: `sdk-${randomUUID().slice(0, 8)}` }).returning();
    accountId = acct!.id;
    const [user] = await pool.insert(users).values({
      accountId, email: `sdk-${randomUUID()}@keyed.example`, displayName: "K", emailVerifiedAt: now,
    }).returning();
    await pool.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
    });
  }, 120_000);

  afterAll(async () => {
    if (accountId !== "") {
      await pool.delete(sessions).where(eq(sessions.accountId, accountId));
      await pool.delete(users).where(eq(users.accountId, accountId));
      await pool.delete(accounts).where(eq(accounts.id, accountId));
    }
    await closePooledDbs();
  });

  /** What `run` wrote: its flights, and every byte of its statements' text and parameters. */
  const written = async <T,>(run: () => Promise<T>) => {
    wire.start();
    const value = await run();
    const r = wire.read();
    return { value, flights: flightsOf(r), bytes: Buffer.concat([...r.texts, ...r.binds]) };
  };

  for (const [name, handle] of [
    ["the pool's own handle", () => pool],
    ["the request's handle as its host minted it", () => bindDb(pool, { account: null })],
  ] as const) {
    it(`the session's look-up on ${name}: one flight of its own, no account, the digest as its key, one burst`, async () => {
      const { value, flights, bytes } = await written(() => resolveSession(handle(), token, now));
      expect(value?.accountId).toBe(accountId);
      expect(flights).toHaveLength(1);
      const [flight] = flights;
      expect(flight).toMatchObject({ door: "lone", account: null, keyed: true, bursts: 1, closed: "commit" });
      expect(flight!.statements).toHaveLength(1);
      expect(flight!.statements[0]).toContain('"sessions"');
      expect(keyEquals(flight!, hashToken(token))).toBe(true);
      // The key is the digest, never the token: the token is in no statement and no parameter.
      expect(keyEquals(flight!, token)).toBe(false);
      expect(bytes.includes(token)).toBe(false);
    });
  }

  it("a token no session answers rides its own digest and reads no row", async () => {
    const stranger = generateToken();
    const { value, flights } = await written(() => resolveSession(pool, stranger, now));
    expect(value).toBeNull();
    expect(flights.map((f) => [f.door, f.account, f.keyed])).toEqual([["lone", null, true]]);
    expect(keyEquals(flights[0]!, hashToken(stranger))).toBe(true);
    expect(keyEquals(flights[0]!, hashToken(token))).toBe(false);
  });

  it("the erased-bearer look-up: one flight of its own, no account, the digest as its key", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { value, flights, bytes } = await written(() => svc.bearerOfErasedAccount(bindDb(pool, { account: null }), token, now));
    expect(value).toBeNull();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ door: "lone", account: null, keyed: true, bursts: 1 });
    expect(flights[0]!.statements).toHaveLength(1);
    expect(flights[0]!.statements[0]).toContain('"erased_bearers"');
    expect(keyEquals(flights[0]!, hashToken(token))).toBe(true);
    expect(bytes.includes(token)).toBe(false);
  });

  it("neither look-up runs on a handle that names an account already", async () => {
    const bound = bindDb(pool, { account: accountId });
    const svc = new AuthService(makeTestAuthDeps());
    const { flights } = await written(async () => {
      await expect(resolveSession(bound, token, now)).rejects.toMatchObject({ code: "binding_refused" });
      await expect(svc.bearerOfErasedAccount(bound, token, now)).rejects.toMatchObject({ code: "binding_refused" });
    });
    expect(flights).toEqual([]);
  });
});
