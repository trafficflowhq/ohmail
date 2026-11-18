import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { makeOwnedDb, type OwnedDb, staffUsers, staffSessions, staffRoleGrants } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import {
  scryptHasher, totpNow, newTotpSecret, makeTestAuthDeps, generateToken, hashToken, type Db,
} from "@trafficflow/services";

/**
 * THE LAST OWNER, UNDER A REAL RACE (cloud 0047). Two owners revoke each other at once. Both
 * pass the role check before either commits — a barrier on `transaction` holds each request
 * until both have arrived — so only the in-transaction re-read, under the lock on the live owner
 * rows, can stop the second. One revoke lands, the other is refused, one owner remains.
 * PGlite cannot interleave two connections; this is the test that can.
 */
const PG_UP = await realPgAvailable();

const SECRET = "admin-console-internal-secret-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const app = createApp(apiRoutes);
const NOW = new Date("2026-09-28T12:00:00.000Z");
const authDeps = makeTestAuthDeps({});

/** A request's container on `db`'s pool, its handle as a host mints a request's. */
const depsOn = (db: Db): ApiDeps => perRequest({
  ...({
    now: () => NOW, requestId: randomUUID(), session: null,
    authConfig: authDeps.config, keyProvider: authDeps.keyProvider, admin: ADMIN,
  } as unknown as Omit<ApiDeps, "db">),
  db,
});

describe.skipIf(!PG_UP)("two owners revoking each other", () => {
  let ownedA: OwnedDb;
  let ownedB: OwnedDb;
  let seedDb: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    ownedA = makeOwnedDb(PG_TEST_URL);
    ownedB = makeOwnedDb(PG_TEST_URL);
    seedDb = ownedA.db as unknown as Db;
  }, 60_000);

  // The staff rows stay: the audit rows they own are append-only, and every read here is scoped to
  // this file's own ids.
  afterAll(async () => {
    await ownedA?.close();
    await ownedB?.close();
  });

  async function owner(): Promise<{ id: string; email: string; token: string; secret: string }> {
    const email = `owner+${randomUUID()}@example.test`;
    const secret = newTotpSecret();
    const sealed = await authDeps.keyProvider.encrypt(secret);
    const [row] = await seedDb.insert(staffUsers).values({
      email, passwordHash: await scryptHasher.hash("staff-console-sign-in-password"),
      totpSecretEnc: sealed.ciphertext, totpKeyVersion: sealed.keyVersion, totpActivated: true,
    }).returning();
    const id = (row as { id: string }).id;
    await seedDb.insert(staffRoleGrants).values({ staffUserId: id, role: "owner", grantedAt: NOW });
    const token = generateToken(32);
    await seedDb.insert(staffSessions).values({
      staffUserId: id, tokenHash: hashToken(token), createdAt: NOW, lastTwofaAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    return { id, email, token, secret };
  }

  const revoke = (by: Awaited<ReturnType<typeof owner>>, target: string, db: Db): Promise<Response> =>
    app.handle(new Request("http://localhost/admin/staff/roles", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-forwarded-for": `198.18.0.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ sessionToken: by.token, totp: totpNow(by.secret, NOW), op: "revoke", role: "owner", staffEmail: target }),
    }), { ...depsOn(db), session: null, idempotency: null } as ApiDeps);

  it("one revoke lands, the other is refused, and an owner remains", async () => {
    const a = await owner();
    const b = await owner();
    // One barrier across both connections: each request waits at `transaction` for the other. It
    // sits on each pool's own handle, the one the binder knows: the staff door's handle the route
    // binds over it opens its transaction through it.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const meet = (pool: OwnedDb["db"]): (() => void) => {
      // What stands there is the factory's own `transaction`, an own property that stamps every
      // transaction it opens: it is put back as it was, never deleted.
      const stood = Object.getOwnPropertyDescriptor(pool, "transaction");
      const transaction = pool.transaction;
      Object.defineProperty(pool, "transaction", {
        configurable: true,
        value: async function (this: unknown, fn: Parameters<typeof transaction>[0], cfg?: Parameters<typeof transaction>[1]) {
          arrived += 1;
          if (arrived >= 2) release();
          await both;
          return transaction.call(this as typeof pool, fn, cfg);
        },
      });
      return () => {
        if (stood) Object.defineProperty(pool, "transaction", stood);
        else Reflect.deleteProperty(pool, "transaction");
      };
    };
    const partA = meet(ownedA.db);
    const partB = meet(ownedB.db);
    let ra: Response;
    let rb: Response;
    try {
      [ra, rb] = await Promise.all([
        revoke(a, b.email, ownedA.db as unknown as Db),
        revoke(b, a.email, ownedB.db as unknown as Db),
      ]);
    } finally {
      partA();
      partB();
    }
    expect(arrived, "both requests reached the transaction before either committed").toBe(2);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 403]);
    const refused = ra.status === 403 ? ra : rb;
    expect(await refused.json()).toEqual({ error: { code: "role_required" } });
    const live = await seedDb.select({ id: staffRoleGrants.staffUserId }).from(staffRoleGrants)
      .where(and(eq(staffRoleGrants.role, "owner"), isNull(staffRoleGrants.revokedAt), inArray(staffRoleGrants.staffUserId, [a.id, b.id])));
    expect(live, "exactly one of the two is still an owner").toHaveLength(1);
  });
});
