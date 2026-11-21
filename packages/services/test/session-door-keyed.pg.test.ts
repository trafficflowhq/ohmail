import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bindDb, sessions, users } from "@trafficflow/db";
import { closePooledDbs, makeOwnedDb, makePooledDb, readLock, type OwnedDb } from "@trafficflow/db/cloud";
import {
  flightsOf, keyEquals, MIGRATOR_ROLE, ownServersAvailable, recordPgWire, startLockGround, type LockGround,
} from "@trafficflow/db/testing";
import { AuthService, generateToken, hashToken, makeTestAuthDeps, resolveSession } from "@trafficflow/services";

const wire = recordPgWire();
const own = ownServersAvailable("packages/services/test/session-door-keyed.pg.test.ts");
const database = "ground";
const svc = new AuthService(makeTestAuthDeps());
const now = new Date();

interface Person {
  accountId: string;
  userId: string;
}

describe.skipIf(!own)("the look-ups before sign-in are keyed by the token's digest (real Postgres)", () => {
  let ground: LockGround;
  let pool: ReturnType<typeof makePooledDb>;
  let migrator: OwnedDb;
  let verified: Person;
  let unverified: Person;
  let active: { bearer: string; sessionId: string };

  beforeAll(async () => {
    ground = await startLockGround(17, "session_door", database);
    await ground.setup(database);
    await ground.makeRoles(database);
    await ground.setup(database, MIGRATOR_ROLE, { lock: "apply" });
    const login = ground.connectAs(database, "ohmail_api");
    try {
      const lock = await readLock(login, { role: "ohmail_api" });
      expect(lock.verdict).toBe("locked");
      expect(lock.role.bypass).toBe(false);
    } finally {
      await login.end();
    }
    pool = makePooledDb(ground.urlAs(database, "ohmail_api"), { max: 1 });
    migrator = makeOwnedDb(ground.urlAs(database, MIGRATOR_ROLE));
    verified = await person(now);
    unverified = await person(null);
    active = await sessionFor(verified);
    // Open the API connection before measuring so its driver setup is outside the reading.
    await pool.select({ id: sessions.id }).from(sessions).limit(1);
  }, 120_000);

  afterAll(async () => {
    await closePooledDbs();
    await migrator?.close();
    ground?.stop();
  });

  async function person(emailVerifiedAt: Date | null): Promise<Person> {
    const [account] = await migrator.db.insert(accounts).values({ name: "Test account" }).returning({ id: accounts.id });
    const [user] = await migrator.db.insert(users).values({
      accountId: account!.id, email: `fixture-${randomUUID()}@example.invalid`, displayName: "Test user", emailVerifiedAt,
    }).returning({ id: users.id });
    return { accountId: account!.id, userId: user!.id };
  }

  async function sessionFor(owner: Person, changes: { revokedAt?: Date; accessExpiresAt?: Date } = {}) {
    const bearer = generateToken();
    const [row] = await migrator.db.insert(sessions).values({
      ...owner, familyId: randomUUID(), accessTokenHash: hashToken(bearer),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
      ...changes,
    }).returning({ id: sessions.id });
    return { bearer, sessionId: row!.id };
  }

  const resolve = (bearer: string) => resolveSession(bindDb(pool, { account: null }), bearer, now);

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
      resolveSession(pool, active.bearer, now)],
    ["the request's handle as its host minted it", () => resolve(active.bearer)],
  ] as const) {
    it(`the session look-up on ${name} reads only the session named by the digest`, async () => {
      const { value, flights, bytes } = await written(lookUp);
      expect(flights).toHaveLength(1);
      const [flight] = flights;
      expect(flight).toMatchObject({ door: "lone", account: null, keyed: true, bursts: 1 });
      expect(flight!.statements).toHaveLength(1);
      expect(flight!.statements[0]).toContain('"sessions"');
      expect(flight!.statements[0]).not.toContain('"users"');
      expect(keyEquals(flight!, hashToken(active.bearer))).toBe(true);
      expect(keyEquals(flight!, active.bearer)).toBe(false);
      expect(bytes.includes(active.bearer)).toBe(false);
      expect(value).toMatchObject({ ...verified, sessionId: active.sessionId });
    });
  }

  it("a token no session answers rides its own digest and reads no row", async () => {
    const stranger = generateToken();
    const { value, flights, bytes } = await written(() => resolve(stranger));
    expect(value).toBeNull();
    expect(flights.map((f) => [f.door, f.account, f.keyed])).toEqual([["lone", null, true]]);
    expect(keyEquals(flights[0]!, hashToken(stranger))).toBe(true);
    expect(keyEquals(flights[0]!, hashToken(active.bearer))).toBe(false);
    expect(bytes.includes(stranger)).toBe(false);
  });

  it.each([
    ["a revoked", { revokedAt: now }],
    ["an expired", { accessExpiresAt: now }],
  ] as const)("refuses %s session even when the digest still names its row", async (_state, changes) => {
    const { bearer } = await sessionFor(verified, changes);
    expect(await resolve(bearer)).toBeNull();
  });

  it("a replacement session works and the superseded bearer is refused", async () => {
    const previous = await sessionFor(verified);
    expect((await resolve(previous.bearer))?.sessionId).toBe(previous.sessionId);
    const { tokens } = await svc.establishPairedDevice({
      ...verified, db: bindDb(pool, { account: verified.accountId }),
      now: () => now, requestId: randomUUID(), supersedes: previous.bearer,
    }, { userId: verified.userId, label: "Replacement", kind: "mobile-android" });
    expect((await resolve(tokens.accessToken))?.accountId).toBe(verified.accountId);
    expect(await resolve(previous.bearer)).toBeNull();
  });

  it("the PostgreSQL account lock confines a resolved bearer to its own account", async () => {
    const other = await sessionFor(unverified);
    expect((await resolve(other.bearer))?.sessionId).toBe(other.sessionId);
    const found = await resolve(active.bearer);
    const scoped = bindDb(pool, { account: found!.accountId });
    const rows = await scoped.select({ id: sessions.id }).from(sessions);
    expect(rows).toContainEqual({ id: active.sessionId });
    expect(rows).not.toContainEqual({ id: other.sessionId });
  });

  it("the erased-bearer look-up: one flight of its own, no account, the digest as its key", async () => {
    const { bearer } = active;
    const { value, flights, bytes } = await written(() => svc.bearerOfErasedAccount(bindDb(pool, { account: null }), bearer, now));
    expect(value).toBeNull();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ door: "lone", account: null, keyed: true, bursts: 1 });
    expect(flights[0]!.statements).toHaveLength(1);
    expect(flights[0]!.statements[0]).toContain('"erased_bearers"');
    expect(keyEquals(flights[0]!, hashToken(bearer))).toBe(true);
    expect(bytes.includes(bearer)).toBe(false);
  });

  it("neither look-up runs on a handle that names an account already", async () => {
    const bound = bindDb(pool, { account: verified.accountId });
    const { flights } = await written(async () => {
      // @ts-expect-error — an account's handle is refused by the type too; the case is the refusal at run time
      await expect(resolveSession(bound, active.bearer, now)).rejects.toMatchObject({ code: "binding_refused" });
      // @ts-expect-error — the same for the erased-bearer look-up
      await expect(svc.bearerOfErasedAccount(bound, active.bearer, now)).rejects.toMatchObject({ code: "binding_refused" });
    });
    expect(flights).toEqual([]);
  });
});
