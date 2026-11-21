import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bindDb, sessions, users } from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, flightsOf, keyEquals, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { AuthService, generateToken, hashToken, makeTestAuthDeps, resolveSession } from "@trafficflow/services";

/**
 * The session door names only the presented digest for its session read, then names
 * just the returned account for the user read in the same transaction. The erased
 * bearer door still reads a single digest in a lone flight. The raw token is never sent.
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

  for (const [name, lookUp] of [
    // The pool's own handle no longer compiles here; what it does at run time is held all the same.
    ["the pool's own handle", () =>
      // @ts-expect-error — a plain handle is refused by the type; the case is the look-up at run time
      resolveSession(pool, token, now)],
    ["the request's handle as its host minted it", () => resolveSession(bindDb(pool, { account: null }), token, now)],
  ] as const) {
    it(`the session look-up on ${name} scopes the user read to the account it resolved`, async () => {
      const { value, flights, bytes } = await written(lookUp);
      expect(value?.accountId).toBe(accountId);
      expect(flights).toHaveLength(2);
      const [flight, userRead] = flights;
      expect(flight).toMatchObject({ door: "read", account: null, keyed: true, closed: null });
      expect(flight!.statements).toHaveLength(1);
      expect(flight!.statements[0]).toContain('"sessions"');
      expect(flight!.statements[0]).not.toContain('"users"');
      expect(keyEquals(flight!, hashToken(token))).toBe(true);
      expect(userRead).toMatchObject({ door: "read", account: accountId, keyed: false, continues: true, closed: "commit" });
      expect(userRead!.statements).toHaveLength(1);
      expect(userRead!.statements[0]).toContain('"users"');
      // The key is the digest, never the token: the token is in no statement and no parameter.
      expect(keyEquals(flight!, token)).toBe(false);
      expect(bytes.includes(token)).toBe(false);
    });
  }

  it("a token no session answers rides its own digest and reads no row", async () => {
    const stranger = generateToken();
    const { value, flights } = await written(() => resolveSession(bindDb(pool, { account: null }), stranger, now));
    expect(value).toBeNull();
    expect(flights.map((f) => [f.door, f.account, f.keyed])).toEqual([["read", null, true]]);
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
      // @ts-expect-error — an account's handle is refused by the type too; the case is the refusal at run time
      await expect(resolveSession(bound, token, now)).rejects.toMatchObject({ code: "binding_refused" });
      // @ts-expect-error — the same for the erased-bearer look-up
      await expect(svc.bearerOfErasedAccount(bound, token, now)).rejects.toMatchObject({ code: "binding_refused" });
    });
    expect(flights).toEqual([]);
  });
});
