import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, accountStorage, mailboxes, sessions, users } from "@trafficflow/db";
import { alertState, staffAuditEvents, staffRoleGrants, staffSessions, staffUsers } from "@trafficflow/db/cloud";
import type { ApiDeps } from "@trafficflow/api";
import type {
  AlertResolvedPage, EngagementSnapshot, FunnelSnapshot, StaffFeedPage, StaffList, StoragePage,
} from "@trafficflow/services";
import { MAIL_POLICY_ROW_KIND } from "../../db/src/alert-mail-policy.js";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { FIXED_NOW, req, seedSession } from "./helpers.js";
import { H, get, post, seedStaff, staffDeps, type Staff } from "./_staff-fixtures.js";

/**
 * The staff console's cross-account reads: the funnel over a window, the accounts in use, stored
 * bytes per account, the staff audit across accounts, an owner's list of staff logins and the
 * alert keys whose latest episode resolved. Counts, timestamps, ids and closed words only; each
 * route is audited before it answers (`admin-audit-fail-closed.test.ts`) and swept for content
 * (`admin-content-isolation.test.ts`).
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(FIXED_NOW.getTime() - ms);

async function read<T>(deps: ApiDeps, token: string, path: string): Promise<T> {
  const res = await H(get(path, token), deps);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

describe("GET /admin/funnel?from&to — the accounts that signed up inside one window", () => {
  async function world(): Promise<{ deps: ApiDeps; token: string }> {
    const deps = await staffDeps();
    await deps.db.insert(accounts).values([
      { id: A, name: "A", createdAt: new Date("2026-07-01T09:00:00.000Z") },
      { id: B, name: "B", createdAt: new Date("2026-07-08T09:00:00.000Z") },
      { id: C, name: "C", createdAt: new Date("2026-07-09T09:00:00.000Z") },
      { id: D, name: "D", createdAt: new Date("2026-05-01T09:00:00.000Z") },
    ]);
    const verified = new Date("2026-07-10T09:00:00.000Z");
    await deps.db.insert(users).values([
      { accountId: A, email: "a@example.test", emailVerifiedAt: verified },
      { accountId: B, email: "b@example.test", emailVerifiedAt: verified },
      { accountId: C, email: "c@example.test" },
      { accountId: D, email: "d@example.test", emailVerifiedAt: verified },
    ]);
    await deps.db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "box@example.test" });
    return { deps, token: (await seedStaff(deps, { roles: ["support"] })).token };
  }

  it("counts the window's signups, and of those the verified and the connected now, by week", async () => {
    const w = await world();
    const funnel = await read<FunnelSnapshot>(w.deps, w.token, "/admin/funnel?from=2026-07-01&to=2026-07-15");
    expect(funnel.window).toEqual({
      from: "2026-07-01T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z",
      signedUp: 3, verified: 2, connected: 1,
      byWeek: [
        { weekStart: "2026-06-29", signedUp: 1, verified: 1, connected: 1 },
        { weekStart: "2026-07-06", signedUp: 2, verified: 1, connected: 0 },
      ],
    });
    // The all-time half answers as it always has.
    expect(funnel.stages.map((s) => s.count)).toEqual([4, 3, 1]);
  });

  it("answers no window unless both bounds are dates in order, so today's call is unchanged", async () => {
    const w = await world();
    // The last two parse in JavaScript and are no timestamp Postgres takes: dropped, never sent.
    for (const q of [
      "", "?from=2026-07-01", "?from=not-a-date&to=2026-07-15", "?from=2026-07-15&to=2026-07-01",
      "?from=-271821-04-20&to=2026-07-15", "?from=2026-07-01&to=%2B275760-09-13",
    ]) {
      const funnel = await read<FunnelSnapshot>(w.deps, w.token, `/admin/funnel${q}`);
      expect(funnel.window, q).toBeNull();
      expect(funnel.stages[0]!.count, q).toBe(4);
    }
  });

  it("clamps a window longer than 400 days to the 400 days before its end", async () => {
    const w = await world();
    const funnel = await read<FunnelSnapshot>(w.deps, w.token, "/admin/funnel?from=2020-01-01&to=2026-07-15");
    expect(funnel.window).toMatchObject({
      from: "2025-06-10T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z", signedUp: 4, verified: 3, connected: 1,
    });
  });
});

describe("GET /admin/engagement — accounts in use over one, seven and thirty days", () => {
  async function account(deps: ApiDeps, id: string): Promise<string> {
    await deps.db.insert(accounts).values({ id, name: id.slice(0, 4) });
    const [u] = await deps.db.insert(users).values({ accountId: id, email: `${id.slice(0, 4)}@example.test` }).returning();
    return (u as { id: string }).id;
  }
  const session = (accountId: string, userId: string, scope: string, lastSeenAt: Date, revokedAt: Date | null = null) => ({
    accountId, userId, familyId: crypto.randomUUID(), scope, lastSeenAt, revokedAt,
    accessExpiresAt: new Date(FIXED_NOW.getTime() + HOUR), refreshExpiresAt: new Date(FIXED_NOW.getTime() + DAY),
  });

  it("counts each account once, by its full sessions' last use, whether revoked since or not", async () => {
    const deps = await staffDeps();
    const ua = await account(deps, A);
    const ub = await account(deps, B);
    const uc = await account(deps, C);
    const ud = await account(deps, D);
    await deps.db.insert(sessions).values([
      session(A, ua, "full", ago(2 * HOUR)),
      session(A, ua, "full", ago(10 * DAY)),
      // Signed out after use: the use still happened.
      session(B, ub, "full", ago(3 * DAY), ago(2 * DAY)),
      // A sign-up's enrolment session is not use of the product.
      session(C, uc, "enrollment", ago(HOUR)),
      session(D, ud, "full", ago(40 * DAY)),
    ]);
    const staff = await seedStaff(deps, { roles: ["ops"] });
    expect(await read<EngagementSnapshot>(deps, staff.token, "/admin/engagement")).toEqual({
      now: FIXED_NOW.toISOString(), activeAccounts: { d1: 1, d7: 2, d30: 2 },
    });
  });

  it("answers zeros on an empty database", async () => {
    const deps = await staffDeps();
    const staff = await seedStaff(deps, { roles: ["support"] });
    expect((await read<EngagementSnapshot>(deps, staff.token, "/admin/engagement")).activeAccounts)
      .toEqual({ d1: 0, d7: 0, d30: 0 });
  });
});

describe("GET /admin/storage — stored bytes per measured account, keyset by id", () => {
  async function world(): Promise<{ deps: ApiDeps; token: string }> {
    const deps = await staffDeps();
    await deps.db.insert(accounts).values([{ id: A, name: "A" }, { id: B, name: "B" }, { id: C, name: "C" }, { id: D, name: "D" }]);
    await deps.db.insert(accountStorage).values([
      { accountId: C, bytes: 300, updatedAt: ago(3 * HOUR) },
      { accountId: A, bytes: 100, updatedAt: ago(HOUR) },
      { accountId: B, bytes: 200, updatedAt: ago(2 * HOUR) },
    ]);
    return { deps, token: (await seedStaff(deps, { roles: ["support"] })).token };
  }

  it("answers every measured account with the deployment's total, in id order", async () => {
    const w = await world();
    expect(await read<StoragePage>(w.deps, w.token, "/admin/storage")).toEqual({
      now: FIXED_NOW.toISOString(), totalBytes: 600, measuredAccounts: 3,
      rows: [
        { accountId: A, bytes: 100, updatedAt: ago(HOUR).toISOString() },
        { accountId: B, bytes: 200, updatedAt: ago(2 * HOUR).toISOString() },
        { accountId: C, bytes: 300, updatedAt: ago(3 * HOUR).toISOString() },
      ],
      nextCursor: null,
    });
  });

  it("pages by cursor, keeps the total whole on every page, and ignores a cursor that is no id", async () => {
    const w = await world();
    const first = await read<StoragePage>(w.deps, w.token, "/admin/storage?limit=2");
    expect(first.rows.map((r) => r.accountId)).toEqual([A, B]);
    expect(first.nextCursor).toBe(B);
    const second = await read<StoragePage>(w.deps, w.token, `/admin/storage?limit=2&cursor=${first.nextCursor}`);
    expect(second.rows.map((r) => r.accountId)).toEqual([C]);
    expect(second).toMatchObject({ totalBytes: 600, measuredAccounts: 3, nextCursor: null });
    const junk = await read<StoragePage>(w.deps, w.token, "/admin/storage?cursor=not-an-id");
    expect(junk.rows.map((r) => r.accountId)).toEqual([A, B, C]);
  });
});

describe("GET /admin/staff-activity — the staff audit across accounts", () => {
  interface World { deps: ApiDeps; owner: Staff; s1: Staff; s2: Staff }

  async function world(): Promise<World> {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const s1 = await seedStaff(deps, { roles: ["support"] });
    const s2 = await seedStaff(deps, { roles: ["support"] });
    const row = (who: Staff, role: string, action: string, minutes: number, extra: Record<string, unknown> = {}) => ({
      requestId: crypto.randomUUID(), staffUserId: who.staffId, actorLabel: who.email, roles: [role],
      action, outcome: "ok", at: ago(minutes * 60_000), ...extra,
    });
    await deps.db.insert(staffAuditEvents).values([
      row(s1, "support", "write.mailbox.resync", 50, { targetAccountId: A, detail: { changed: true } }),
      row(s2, "support", "staff.signin", 40),
      row(s1, "support", "read.account", 30, { targetAccountId: A }),
      row(owner, "owner", "write.oauth_provider", 20),
      row(s2, "support", "write.mailbox.resync", 10, { targetAccountId: B, outcome: "refused", refusalCode: "role_required" }),
      row(owner, "owner", "assert.external", 5, { detail: { method: "GET", path: "/v1/a", scope: "read", tier: 0, index: 0 } }),
    ]);
    return { deps, owner, s1, s2 };
  }
  const feed =(w: World, who: Staff, q = ""): Promise<StaffFeedPage> =>
    read<StaffFeedPage>(w.deps, who.token, `/admin/staff-activity${q}`);

  it("an owner reads every staff member's actions, newest first, and the reads only when asked", async () => {
    const w = await world();
    const page = await feed(w, w.owner);
    expect(page.scope).toBe("all");
    expect(page.rows.map((r) => [r.staffUserId, r.action])).toEqual([
      [w.s2.staffId, "write.mailbox.resync"], [w.owner.staffId, "write.oauth_provider"],
      [w.s2.staffId, "staff.signin"], [w.s1.staffId, "write.mailbox.resync"],
    ]);
    expect(page.nextCursor).toBeNull();
    const all = await feed(w, w.owner, "?reads=1");
    // An owner's two reads of the feed were each written before they were served, so they are
    // the newest rows (both at the fixed clock).
    expect(all.rows.map((r) => r.action)).toEqual([
      "read.staff_activity", "read.staff_activity", "assert.external", "write.mailbox.resync",
      "write.oauth_provider", "read.account", "staff.signin", "write.mailbox.resync",
    ]);
    expect(all.applied.reads).toBe(true);
  });

  it("support reads its own rows only, and says so", async () => {
    const w = await world();
    const page = await feed(w, w.s1);
    expect(page.scope).toBe("own");
    expect(page.applied.actor).toBe(w.s1.staffId);
    expect(page.rows.map((r) => [r.staffUserId, r.action])).toEqual([[w.s1.staffId, "write.mailbox.resync"]]);
    const withReads = await feed(w, w.s1, `?reads=1&actor=${w.s1.staffId}`);
    expect(withReads.rows.every((r) => r.staffUserId === w.s1.staffId)).toBe(true);
    expect(withReads.rows.map((r) => r.action)).toEqual([
      "read.staff_activity", "read.staff_activity", "read.account", "write.mailbox.resync",
    ]);
    expect(JSON.stringify(withReads)).not.toContain(w.s2.email);
    expect(JSON.stringify(withReads)).not.toContain(w.owner.email);
  });

  it("support naming another staff member is refused, and an owner may name anyone", async () => {
    const w = await world();
    const refused = await H(get(`/admin/staff-activity?actor=${w.s2.staffId}`, w.s1.token), w.deps);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "role_required" } });
    const named = await feed(w, w.owner, `?actor=${w.s2.staffId}`);
    expect(named.rows.map((r) => r.action)).toEqual(["write.mailbox.resync", "staff.signin"]);
    expect(named.rows.every((r) => r.staffUserId === w.s2.staffId)).toBe(true);
  });

  it("filters by account, action, outcome and window, and echoes what it applied", async () => {
    const w = await world();
    expect((await feed(w, w.owner, `?account=${A}`)).rows.map((r) => r.action)).toEqual(["write.mailbox.resync"]);
    // With the reads: the feed's own reads filtered by this account name it as their target.
    const onA = await feed(w, w.owner, `?account=${A}&reads=1`);
    expect(onA.rows.map((r) => r.action)).toEqual([
      "read.staff_activity", "read.staff_activity", "read.account", "write.mailbox.resync",
    ]);
    expect(onA.rows.every((r) => r.targetAccountId === A)).toBe(true);
    // Naming a read action is asking for reads.
    expect((await feed(w, w.owner, "?action=read.account")).rows.map((r) => r.staffUserId)).toEqual([w.s1.staffId]);
    const resync = await feed(w, w.owner, "?action=write.mailbox.resync");
    expect(resync.rows.map((r) => r.staffUserId)).toEqual([w.s2.staffId, w.s1.staffId]);
    expect(resync.applied.action).toBe("write.mailbox.resync");
    const refused = await feed(w, w.owner, "?outcome=refused");
    expect(refused.rows.map((r) => [r.action, r.refusalCode])).toEqual([["write.mailbox.resync", "role_required"]]);
    const window = await feed(w, w.owner, `?from=${ago(45 * 60_000).toISOString()}&to=${ago(15 * 60_000).toISOString()}`);
    expect(window.rows.map((r) => r.action)).toEqual(["write.oauth_provider", "staff.signin"]);
    expect(window.applied).toMatchObject({ from: ago(45 * 60_000).toISOString(), to: ago(15 * 60_000).toISOString() });
    // A filter value outside its closed set is not applied, and the page says it was not.
    const unknown = await feed(w, w.owner, "?action=write.nothing&outcome=maybe&account=not-an-id");
    expect(unknown.applied).toMatchObject({ action: null, outcome: null, account: null });
    expect(unknown.rows).toHaveLength(4);
  });

  it("pages fifty at a time by (at, id), and a page boundary drops nothing", async () => {
    const w = await world();
    await w.deps.db.insert(staffAuditEvents).values(Array.from({ length: 55 }, (_, i) => ({
      requestId: crypto.randomUUID(), staffUserId: w.s2.staffId, actorLabel: w.s2.email, roles: ["support"],
      action: "staff.signin", outcome: "ok", at: ago((60 + i) * 60_000),
    })));
    const first = await feed(w, w.owner);
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await feed(w, w.owner, `?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.rows).toHaveLength(9);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(59);
  });

  it("narrows a planted row's detail to the action's allowlist", async () => {
    const w = await world();
    await w.deps.db.insert(staffAuditEvents).values({
      requestId: crypto.randomUUID(), staffUserId: w.s1.staffId, actorLabel: w.s1.email, roles: ["support"],
      action: "write.mailbox.resync", outcome: "ok", at: ago(60_000), detail: { changed: true, note: "planted free text" },
    });
    const page = await feed(w, w.owner);
    expect(page.rows[0]!.detail).toEqual({ changed: true });
    expect(JSON.stringify(page)).not.toContain("planted free text");
  });
});

describe("POST /admin/staff/list — an owner's list of staff logins", () => {
  const list = (token: string): Request => post("/admin/staff/list", {}, { [STAFF_SESSION_HEADER]: token });

  it("answers each login with its live roles, its newest session and whether a factor is enrolled", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { email: "a-owner@example.test", roles: ["owner"] });
    const support = await seedStaff(deps, { email: "b-support@example.test", roles: ["support", "ops"] });
    const [fresh] = await deps.db.insert(staffUsers).values({ email: "c-new@example.test", passwordHash: "x".repeat(40) }).returning();
    const freshId = (fresh as { id: string }).id;
    await deps.db.insert(staffRoleGrants).values({
      staffUserId: freshId, role: "ops", grantedAt: ago(DAY), revokedAt: ago(HOUR), revokedBy: owner.staffId,
    });
    const res = await H(list(owner.token), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      now: FIXED_NOW.toISOString(),
      staff: [
        { staffId: owner.staffId, email: "a-owner@example.test", roles: ["owner"], lastSignInAt: FIXED_NOW.toISOString(), authenticator: true },
        { staffId: support.staffId, email: "b-support@example.test", roles: ["support", "ops"], lastSignInAt: FIXED_NOW.toISOString(), authenticator: true },
        { staffId: freshId, email: "c-new@example.test", roles: [], lastSignInAt: null, authenticator: false },
      ],
      truncated: false,
    } satisfies StaffList);
  });

  it("carries no password hash, no sealed secret and no session hash", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const text = await (await H(list(owner.token), deps)).text();
    const [row] = await deps.db.select().from(staffUsers);
    const [session] = await deps.db.select().from(staffSessions);
    for (const secret of [row!.passwordHash, row!.totpSecretEnc, session!.tokenHash]) {
      expect(secret && secret.length > 8, "the fixture carries the value it looks for").toBe(true);
      expect(text).not.toContain(secret!);
    }
    expect(text).not.toContain(owner.token);
    expect(text).toContain(owner.email);
  });

  it("is refused without a staff session, with a customer's session, and without the secret", async () => {
    const deps = await staffDeps();
    await seedStaff(deps, { roles: ["owner"] });
    const noSession = await H(post("/admin/staff/list", {}), deps);
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toEqual({ error: { code: "staff_session_required" } });
    const customer = await seedSession(deps.db, { now: FIXED_NOW });
    const crossed = await H(post("/admin/staff/list", {}, { [STAFF_SESSION_HEADER]: customer.token }), deps);
    expect(crossed.status).toBe(401);
    const noSecret = await H(req("POST", "/admin/staff/list", { body: "{}" }), deps);
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("does not exist on a host with no admin surface", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const res = await H(list(owner.token), { ...deps, admin: undefined } as ApiDeps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });
});

describe("GET /admin/alerts/history — each alert key's latest episode, once resolved", () => {
  const resolved = (key: string, kind: string, at: Date, extra: Record<string, unknown> = {}) => ({
    alertKey: key, kind, severity: "critical", cls: "incident", openedAt: new Date(at.getTime() - 2 * HOUR),
    lastSeenAt: new Date(at.getTime() - HOUR), resolvedAt: at, notifyCount: 0, count: 1, ...extra,
  });

  async function world(): Promise<{ deps: ApiDeps; token: string }> {
    const deps = await staffDeps();
    await deps.db.insert(alertState).values([
      resolved("worker_down:0", "worker_down", ago(2 * DAY), { notifiedAt: ago(2 * DAY + HOUR) }),
      resolved("sync_lag", "sync_lag", ago(DAY), { severity: "warning", cls: "signal", count: 4 }),
      resolved("sends_stuck", "sends_stuck", ago(40 * DAY)),
      { alertKey: "pooler_refusals", kind: "pooler_refusals", severity: "critical", openedAt: ago(HOUR), lastSeenAt: ago(60_000), notifyCount: 0 },
      // A policy row is never an alert; this one is planted inside the window to prove the kind is read.
      resolved("mail:digest", MAIL_POLICY_ROW_KIND, ago(HOUR), { severity: "warning", cls: "signal" }),
    ]);
    return { deps, token: (await seedStaff(deps, { roles: ["ops"] })).token };
  }

  it("answers the last 30 days by default, newest resolution first, open keys and policy rows left out", async () => {
    const w = await world();
    expect(await read<AlertResolvedPage>(w.deps, w.token, "/admin/alerts/history")).toEqual({
      now: FIXED_NOW.toISOString(),
      window: { from: ago(30 * DAY).toISOString(), to: FIXED_NOW.toISOString() },
      latestResolved: [
        {
          key: "sync_lag", kind: "sync_lag", severity: "warn", cls: "signal", openedAt: ago(DAY + 2 * HOUR).toISOString(),
          resolvedAt: ago(DAY).toISOString(), lastConfirmedAt: ago(DAY + HOUR).toISOString(), notifiedAt: null, count: 4,
        },
        {
          key: "worker_down:0", kind: "worker_down", severity: "bad", cls: "incident", openedAt: ago(2 * DAY + 2 * HOUR).toISOString(),
          resolvedAt: ago(2 * DAY).toISOString(), lastConfirmedAt: ago(2 * DAY + HOUR).toISOString(),
          notifiedAt: ago(2 * DAY + HOUR).toISOString(), count: 1,
        },
      ],
      truncated: false,
    });
  });

  it("reads a window it is given, clamps one longer than 90 days, and falls back on a malformed one", async () => {
    const w = await world();
    const wider = await read<AlertResolvedPage>(w.deps, w.token, `/admin/alerts/history?from=${ago(50 * DAY).toISOString()}&to=${FIXED_NOW.toISOString()}`);
    expect(wider.latestResolved.map((r) => r.key)).toEqual(["sync_lag", "worker_down:0", "sends_stuck"]);
    const clamped = await read<AlertResolvedPage>(w.deps, w.token, `/admin/alerts/history?from=2020-01-01&to=${FIXED_NOW.toISOString()}`);
    expect(clamped.window).toEqual({ from: ago(90 * DAY).toISOString(), to: FIXED_NOW.toISOString() });
    const junk = await read<AlertResolvedPage>(w.deps, w.token, "/admin/alerts/history?from=yesterday");
    expect(junk.window).toEqual({ from: ago(30 * DAY).toISOString(), to: FIXED_NOW.toISOString() });
    const far = await read<AlertResolvedPage>(w.deps, w.token, "/admin/alerts/history?to=%2B275760-09-13");
    expect(far.window).toEqual({ from: ago(30 * DAY).toISOString(), to: FIXED_NOW.toISOString() });
  });

  it("a key that fired again is open, so it leaves this list for the live board", async () => {
    const w = await world();
    await w.deps.db.update(alertState).set({ resolvedAt: null }).where(eq(alertState.alertKey, "worker_down:0"));
    const page = await read<AlertResolvedPage>(w.deps, w.token, "/admin/alerts/history");
    expect(page.latestResolved.map((r) => r.key)).toEqual(["sync_lag"]);
  });

  it("answers at most 500 keys and says when more resolved inside the window", async () => {
    const deps = await staffDeps();
    await deps.db.insert(alertState).values(Array.from({ length: 501 }, (_, i) =>
      resolved(`api_fault_rate:api:/r${i}`, "api_fault_rate", ago((i + 1) * 60_000))));
    const staff = await seedStaff(deps, { roles: ["support"] });
    const page = await read<AlertResolvedPage>(deps, staff.token, "/admin/alerts/history");
    expect(page.latestResolved).toHaveLength(500);
    expect(page.truncated).toBe(true);
    expect(page.latestResolved[0]!.key).toBe("api_fault_rate:api:/r0");
  });
});
