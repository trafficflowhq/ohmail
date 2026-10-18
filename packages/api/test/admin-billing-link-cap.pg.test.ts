import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { accounts, users, type AccessVerdict, type EntitlementsPort } from "@trafficflow/db";
import {
  accountLifecycleNotices, makeOwnedDb, staffAuditEvents, staffRoleGrants, staffSessions, staffUsers, type OwnedDb,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import {
  generateToken, hashToken, makeMailService, makeTestAuthDeps, SpyMailer, type Db,
} from "@trafficflow/services";

/**
 * THE BILLING-LINK CAP UNDER CONCURRENCY, which PGlite (one connection) cannot interleave. Six
 * presses for one account race on six connections, a millisecond apart, while a barrier holds
 * every notice INSERT, so each press has counted before any has written. The claim takes the
 * account row FOR NO KEY UPDATE first, so the counts happen one after another: three claims,
 * three mails, three refusals. Watched red: with the fence at `share`, five of six were mailed.
 */
const PG_UP = await realPgAvailable();

const SECRET = "admin-secret-for-tests-abcdefghij-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const app = createApp(apiRoutes);
const PRESSES = 6;

const OPEN: AccessVerdict = { ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
const port: EntitlementsPort = {
  access: async () => OPEN, accessOrFault: async () => OPEN,
  spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
  release: async () => "settled" as const, manageLink: async () => null, releaseAccount: async () => "none",
};

describe.skipIf(!PG_UP)("the billing-link cap against real Postgres", () => {
  const owned: OwnedDb[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    for (let i = 0; i <= PRESSES; i += 1) owned.push(makeOwnedDb(PG_TEST_URL));
  }, 60_000);

  afterAll(async () => {
    for (const o of owned) await o.close();
  });

  it("six simultaneous presses: three claims, three mails, three refused rate_limited", async () => {
    const now = new Date("2026-10-18T09:00:00.000Z");
    const db0 = owned[0]!.db as unknown as Db;
    const accountId = randomUUID();
    const owner = `owner+${randomUUID()}@race.example`;
    await db0.insert(accounts).values({ id: accountId, name: "Race Ltd" });
    await db0.insert(users).values({ accountId, email: owner });
    const [staff] = await db0.insert(staffUsers).values({ email: `support+${randomUUID()}@ohmail.app`, passwordHash: "unused" }).returning();
    const staffId = (staff as { id: string }).id;
    await db0.insert(staffRoleGrants).values({ staffUserId: staffId, role: "support" });
    const token = generateToken(32);
    await db0.insert(staffSessions).values({
      staffUserId: staffId, tokenHash: hashToken(token), createdAt: now, lastTwofaAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });

    const mailer = new SpyMailer();
    const mail = makeMailService({
      mailer, config: { appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000", supportEmail: "support@ohmail.app" },
    });
    const authDeps = makeTestAuthDeps({});
    // Each press its own instant, as a real clock gives them: a shared one would collide on the
    // (account, kind, anchor) key and hide a broken count behind a primary-key refusal.
    const depsOn = (db: Db, at: Date): ApiDeps => ({
      db, now: () => at, requestId: `pg-${randomUUID()}`, session: null, idempotency: null,
      authConfig: authDeps.config, keyProvider: authDeps.keyProvider, admin: ADMIN,
      services: { customerMail: mail, entitlementsPort: port },
    }) as unknown as ApiDeps;
    const press = (db: Db, i: number): Promise<Response> => app.handle(new Request(`http://localhost/admin/accounts/${accountId}/billing-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionToken: token, reasonCode: "customer_request" }),
    }), depsOn(db, new Date(now.getTime() + i)));

    // The barrier: SHARE on the notices table lets every press read and blocks every INSERT.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const barrier = db0.transaction(async (tx) => {
      await tx.execute(sql`lock table account_lifecycle_notices in share mode`);
      locked();
      await held;
    });
    await ready;
    const inFlight = owned.slice(1).map((o, i) => press(o.db as unknown as Db, i));
    await new Promise((r) => setTimeout(r, 800));
    release();
    await barrier;
    const answers = await Promise.all(inFlight);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
    const claims = await db0.select().from(accountLifecycleNotices)
      .where(and(eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "billing_link")));
    expect(claims).toHaveLength(3);
    expect(mailer.ofTemplate("billing_link").map((s) => s.to)).toEqual([owner, owner, owner]);
    const rows = await db0.select({ outcome: staffAuditEvents.outcome, refusalCode: staffAuditEvents.refusalCode })
      .from(staffAuditEvents).where(eq(staffAuditEvents.staffUserId, staffId));
    expect(rows.map((r) => `${r.outcome} ${r.refusalCode ?? "-"}`).sort())
      .toEqual(["ok -", "ok -", "ok -", "refused rate_limited", "refused rate_limited", "refused rate_limited"]);
  }, 60_000);
});
