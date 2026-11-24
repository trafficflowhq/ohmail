import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { accounts, users, sessions, devices, refreshTokens } from "@trafficflow/db";
import { loginTokens, authEvents, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService, type Db,
} from "@trafficflow/services";

/**
 * THE DESKTOP APPROVAL, AGAINST REAL POSTGRES — the guarded statements PGlite cannot judge.
 *
 * 1. ONE USE UNDER CONCURRENCY: twelve claims of one confirmed request, each on its own
 *    connection, produce exactly one session; the burn is one `UPDATE … WHERE approved_at IS NOT
 *    NULL AND consumed_at IS NULL … RETURNING`, so the row lock decides.
 * 2. THE KILL COUNTS ONCE: twelve simultaneous wrong verifiers leave `attempts` at five, the row
 *    revoked and ONE refusal audited — the increment is guarded on `revoked_at IS NULL`.
 * 3. The verifier is in no column. Rows are removed after each case; `now` is fixed in the past.
 */
const PG_UP = await realPgAvailable();
const FIXED_NOW = new Date("2026-08-09T12:00:00.000Z");
const app = createApp(apiRoutes);

/** Only the auth service is reached; the rest of `ApiDeps.services` is never read here. */
function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  // A request's container on `db`'s pool, its handle as a host mints a request's.
  return perRequest({
    ...({
      now: () => FIXED_NOW, requestId: `pg-${randomUUID()}`, session: null,
      authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
      services: { auth: makeAuthService(authDeps) },
    } as unknown as Omit<ApiDeps, "db">),
    db,
  });
}

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "utf8").digest("base64url") };
};

/** A fresh client address per call: the fixed clock never rolls the limiter's window. */
const freshIp = (): string => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

const post = (db: Db, path: string, body: unknown, bearer?: string): Promise<Response> =>
  app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-forwarded-for": freshIp(),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  }), depsOn(db));

describe.skipIf(!PG_UP)("the desktop approval against real Postgres", () => {
  const FANOUT = 12;
  let owned: OwnedDb[] = [];
  let dbs: Db[] = [];
  let fixture: Db;
  const made: { userIds: string[]; accountIds: string[]; approvalIds: string[] } = {
    userIds: [], accountIds: [], approvalIds: [],
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = Array.from({ length: FANOUT + 1 }, () => makeOwnedDb(PG_TEST_URL));
    dbs = owned.map((o) => o.db as unknown as Db);
    fixture = dbs[FANOUT]!;
  }, 60_000);

  afterEach(async () => {
    const { userIds, accountIds, approvalIds } = made;
    if (approvalIds.length) await fixture.delete(loginTokens).where(inArray(loginTokens.id, approvalIds));
    if (userIds.length) {
      await fixture.delete(authEvents).where(inArray(authEvents.userId, userIds));
      await fixture.delete(refreshTokens).where(inArray(refreshTokens.userId, userIds));
      await fixture.delete(sessions).where(inArray(sessions.userId, userIds));
      await fixture.delete(devices).where(inArray(devices.userId, userIds));
      await fixture.delete(users).where(inArray(users.id, userIds));
    }
    if (accountIds.length) await fixture.delete(accounts).where(inArray(accounts.id, accountIds));
    made.userIds = []; made.accountIds = []; made.approvalIds = [];
  });

  afterAll(async () => {
    await Promise.all(owned.map((o) => o.close()));
  });

  /** A signed-in, stepped-up browser and a desktop's request it has confirmed. */
  async function confirmed(): Promise<{ userId: string; id: string; verifier: string }> {
    const token = generateToken();
    const [acct] = await fixture.insert(accounts).values({ name: `approval-${randomUUID()}` }).returning();
    const [user] = await fixture.insert(users).values({
      accountId: acct!.id, email: `a-${randomUUID()}@example.com`, displayName: "A", emailVerifiedAt: FIXED_NOW,
    }).returning();
    made.accountIds.push(acct!.id); made.userIds.push(user!.id);
    await fixture.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000), lastTwofaAt: FIXED_NOW,
    });
    const { verifier, challenge } = pkce();
    const asked = await post(fixture, "/auth/desktop-approval", { challenge, kind: "desktop-linux", label: "pg-box" });
    expect(asked.status, await asked.clone().text()).toBe(200);
    const { approvalId } = (await asked.json()) as { approvalId: string };
    made.approvalIds.push(approvalId);
    const ok = await post(fixture, `/auth/desktop-approval/${approvalId}/confirm`, {}, token);
    expect(ok.status, await ok.clone().text()).toBe(200);
    return { userId: user!.id, id: approvalId, verifier };
  }

  it("TWELVE simultaneous claims of one confirmed request produce exactly ONE session", async () => {
    const { userId, id, verifier } = await confirmed();
    const results = await Promise.all(dbs.slice(0, FANOUT).map((db) =>
      post(db, "/auth/desktop-approval/claim", { approvalId: id, verifier, kind: "desktop-linux" })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200), `statuses: ${statuses.join(",")}`).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 200);
    expect(losers.map((r) => r.status)).toEqual(Array(FANOUT - 1).fill(410));
    for (const r of losers) expect(((await r.json()) as { error: { code: string } }).error.code).toBe("approval_used");
    // The database's count: the seeded browser session plus ONE desktop, and ONE named device.
    expect(await fixture.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);
    const devs = await fixture.select().from(devices).where(eq(devices.userId, userId));
    expect(devs.map((d) => d.label)).toEqual(["pg-box"]);
  }, 60_000);

  it("TWELVE simultaneous wrong verifiers stop at five, revoke once, audit once", async () => {
    const { userId, id, verifier } = await confirmed();
    const results = await Promise.all(dbs.slice(0, FANOUT).map((db) =>
      post(db, "/auth/desktop-approval/claim", { approvalId: id, verifier: pkce().verifier })));
    expect(results.map((r) => r.status)).toEqual(Array(FANOUT).fill(400));
    const [row] = await fixture.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.attempts).toBe(5);
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.consumedAt).toBeNull();
    const refused = (await fixture.select().from(authEvents).where(eq(authEvents.userId, userId)))
      .filter((e) => e.event === "desktop_approval_refused");
    expect(refused).toHaveLength(1);
    const late = await post(fixture, "/auth/desktop-approval/claim", { approvalId: id, verifier });
    expect(late.status).toBe(410);
    expect(await fixture.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
  }, 60_000);

  it("the verifier's plaintext appears in NO column of login_tokens", async () => {
    const { id, verifier } = await confirmed();
    const [hit] = await fixture.execute(sql`
      select count(*)::int as n from login_tokens
      where id = ${id}::uuid and login_tokens::text like ${`%${verifier}%`}
    `) as unknown as Array<{ n: number }>;
    expect(hit!.n).toBe(0);
    const [row] = await fixture.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.challengeHash).toBe(createHash("sha256").update(verifier, "utf8").digest("base64url"));
  }, 30_000);
});
