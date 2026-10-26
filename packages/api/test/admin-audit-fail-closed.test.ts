import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, auditLog, mailboxes, users, type AccessVerdict, type EntitlementsPort } from "@trafficflow/db";
import { accountLifecycleNotices, staffAuditEvents, STAFF_ROLES } from "@trafficflow/db/cloud";
import { checkedDetail, StaffAuditDetailError, type AdminDb, type StaffActivityPage, type StaffRole } from "@trafficflow/services";
import type { ApiDeps } from "@trafficflow/api";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { FIXED_NOW, makeDeps } from "./helpers.js";
import {
  ADMIN, H, get, post, seedStaff, staffDeps, auditRows, auditRowsFor, failingInsertInto,
} from "./_staff-fixtures.js";

/**
 * AUDIT BEFORE SERVE (cloud 0047). Every staff read writes its `staff_audit_events` row on the
 * runtime connection before the read runs; a failed insert is `503 audit_failed` and the read
 * never runs. The mailbox write inserts its row inside the effect's transaction, so a failed
 * insert rolls the release back. The request id is echoed so both trails can be joined.
 */

const ACCOUNT_ID = "5b0c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

const READS: ReadonlyArray<readonly [string, string]> = [
  ["/admin/overview", "read.overview"],
  ["/admin/accounts", "read.roster"],
  [`/admin/accounts?ids=${ACCOUNT_ID}`, "read.roster"],
  [`/admin/accounts/${ACCOUNT_ID}`, "read.account"],
  [`/admin/accounts/${ACCOUNT_ID}/staff-activity`, "read.account.activity"],
  ["/admin/search?q=acme", "read.search"],
  ["/admin/sync-roster", "read.sync_roster"],
  ["/admin/funnel", "read.funnel"],
  ["/admin/funnel?from=2026-07-01&to=2026-07-15", "read.funnel"],
  ["/admin/worker", "read.worker"],
  ["/admin/actions", "read.actions"],
  ["/admin/engagement", "read.engagement"],
  ["/admin/storage", "read.storage"],
  ["/admin/staff-activity", "read.staff_activity"],
  ["/admin/alerts/history", "read.alerts_history"],
  ["/admin/connect-attempts", "read.connect_attempts"],
  [`/admin/connect-attempts?account=${ACCOUNT_ID}`, "read.connect_attempts"],
];

async function world(): Promise<{ deps: ApiDeps; staff: Awaited<ReturnType<typeof seedStaff>> }> {
  const deps = await staffDeps();
  await deps.db.insert(accounts).values({ id: ACCOUNT_ID, name: "Acme Ltd" });
  return { deps, staff: await seedStaff(deps, { roles: ["support"] }) };
}

describe("every staff read is recorded before it is served", () => {
  it.each(READS)("%s writes one %s row, and the response names its request id", async (path, action) => {
    const { deps, staff } = await world();
    const res = await H(get(path, staff.token), deps);
    expect(res.status, path).toBe(200);
    const rows = await auditRowsFor(deps, staff.staffId);
    expect(rows.map((r) => r.action)).toEqual([action]);
    const [row] = rows;
    expect(row!.outcome).toBe("ok");
    expect(row!.actorLabel).toBe(staff.email);
    expect(row!.roles).toEqual(["support"]);
    expect(row!.staffSessionId).toBe(staff.sessionId);
    expect(res.headers.get("x-request-id")).toBe(row!.requestId);
  });

  it("names the target account on an account read, and never the search term", async () => {
    const { deps, staff } = await world();
    await H(get(`/admin/accounts/${ACCOUNT_ID}`, staff.token), deps);
    await H(get("/admin/search?q=Needle-In-The-Log", staff.token), deps);
    const rows = await auditRowsFor(deps, staff.staffId);
    expect(rows.find((r) => r.action === "read.account")!.targetAccountId).toBe(ACCOUNT_ID);
    const search = rows.find((r) => r.action === "read.search")!;
    expect(search.queryHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("needle-in-the-log");
  });

  it("the connect-attempt read names a named account as its target, and its detail is the window's length", async () => {
    const { deps, staff } = await world();
    await H(get(`/admin/connect-attempts?account=${ACCOUNT_ID}`, staff.token), deps);
    await H(get("/admin/connect-attempts?from=2026-07-20T12:00:00Z&to=2026-07-27T12:00:00Z", staff.token), deps);
    const rows = await auditRowsFor(deps, staff.staffId);
    expect(rows.map((r) => [r.targetAccountId, r.detail]).sort()).toEqual([
      [ACCOUNT_ID, { windowDays: 30, account: true }], [null, { windowDays: 7, account: false }],
    ].sort());
  });

  it("keeps a caller's uuid request id and replaces anything else", async () => {
    const { deps, staff } = await world();
    const rid = "0f0e0d0c-0b0a-4098-8765-432101234567";
    const kept = await H(get("/admin/funnel", staff.token, { "x-request-id": rid }), deps);
    expect(kept.headers.get("x-request-id")).toBe(rid);
    const replaced = await H(get("/admin/funnel", staff.token, { "x-request-id": "not-a-uuid<script>" }), deps);
    expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.headers.get("x-request-id")).not.toContain("script");
    const ids = (await auditRowsFor(deps, staff.staffId)).map((r) => r.requestId);
    expect(ids).toContain(rid);
    expect(ids).toContain(replaced.headers.get("x-request-id"));
  });

  it.each(READS)("%s answers 503 audit_failed with no payload when the row cannot be written", async (path) => {
    const { deps, staff } = await world();
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    let reads = 0;
    const d = {
      ...deps, db: broken.db,
      adminDb: () => { reads += 1; return Promise.resolve(deps.db as unknown as AdminDb); },
    } as ApiDeps;
    const res = await H(get(path, staff.token), d);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: { code: "audit_failed" } }));
    expect(broken.faults.count, "the fault was reached").toBe(1);
    expect(reads, "the read ran although nothing recorded it").toBe(0);
    expect(await auditRows(deps)).toEqual([]);
  });

  it("refuses a staff member who holds no role, and records the refusal", async () => {
    const deps = await staffDeps();
    const nobody = await seedStaff(deps, { roles: [] });
    const res = await H(get("/admin/overview", nobody.token), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "role_required" } });
    const [row] = await auditRowsFor(deps, nobody.staffId);
    expect(row).toMatchObject({ action: "read.overview", outcome: "refused", refusalCode: "role_required" });
  });

  it("a refusal whose row cannot be written answers audit_failed, never a 403 with no row", async () => {
    const deps = await staffDeps();
    const nobody = await seedStaff(deps, { roles: [] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await H(get("/admin/overview", nobody.token), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
    expect(broken.faults.count).toBe(1);
  });
});

describe("the staff list (owner only) and the feed's own-rows rule are recorded before they answer", () => {
  const list = (token: string): Request => post("/admin/staff/list", {}, { [STAFF_SESSION_HEADER]: token });

  it("an owner's list writes one read.staff_list row, and the response names its request id", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const res = await H(list(owner.token), deps);
    expect(res.status).toBe(200);
    const [row, ...rest] = await auditRowsFor(deps, owner.staffId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ action: "read.staff_list", outcome: "ok", staffSessionId: owner.sessionId });
    expect(res.headers.get("x-request-id")).toBe(row!.requestId);
  });

  it.each(STAFF_ROLES.filter((r) => r !== "owner").map((r) => [r] as const))("%s is refused the list, and the refusal is recorded", async (role) => {
    const deps = await staffDeps();
    const s = await seedStaff(deps, { roles: [role] });
    const res = await H(list(s.token), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "role_required" } });
    expect((await auditRowsFor(deps, s.staffId)).map((r) => [r.action, r.outcome, r.refusalCode]))
      .toEqual([["read.staff_list", "refused", "role_required"]]);
  });

  it("the list answers 503 audit_failed and is never read when its row cannot be written", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    let reads = 0;
    const d = {
      ...deps, db: broken.db,
      adminDb: () => { reads += 1; return Promise.resolve(deps.db as unknown as AdminDb); },
    } as ApiDeps;
    const res = await H(list(owner.token), d);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: { code: "audit_failed" } }));
    expect(broken.faults.count).toBe(1);
    expect(reads, "the list ran although nothing recorded it").toBe(0);
  });

  it("support naming another staff member on the feed is refused, recorded, and fails closed", async () => {
    const deps = await staffDeps();
    const support = await seedStaff(deps, { roles: ["support"] });
    const other = await seedStaff(deps, { roles: ["support"] });
    const res = await H(get(`/admin/staff-activity?actor=${other.staffId}`, support.token), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "role_required" } });
    expect((await auditRowsFor(deps, support.staffId)).map((r) => [r.action, r.outcome, r.refusalCode]))
      .toEqual([["read.staff_activity", "refused", "role_required"]]);
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const blind = await H(get(`/admin/staff-activity?actor=${other.staffId}`, support.token), { ...deps, db: broken.db } as ApiDeps);
    expect(blind.status).toBe(503);
    expect(await blind.json()).toEqual({ error: { code: "audit_failed" } });
  });
});

describe("the mailbox write records inside its own transaction", () => {
  const NOTE = "provider outage cleared, release the backoff";
  async function parked(): Promise<{ deps: ApiDeps; staff: Awaited<ReturnType<typeof seedStaff>>; mailboxId: string; retryAfter: Date }> {
    const deps = await staffDeps();
    await deps.db.insert(accounts).values({ id: ACCOUNT_ID, name: "Acme Ltd" });
    const retryAfter = new Date(FIXED_NOW.getTime() + 900_000);
    const [mb] = await deps.db.insert(mailboxes).values({
      accountId: ACCOUNT_ID, provider: "imap", address: "parked@example.test",
      status: "error", errorCode: "auth", retryCount: 4, retryAfter,
    }).returning();
    return { deps, staff: await seedStaff(deps, { roles: ["ops"] }), mailboxId: (mb as { id: string }).id, retryAfter };
  }
  const resync = (token: string, mailboxId: string): Request =>
    post("/admin/mailboxes/resync", { sessionToken: token, mailboxId, note: NOTE });

  it("a release writes an ok row with the account and mailbox, beside its audit_log row", async () => {
    const { deps, staff, mailboxId } = await parked();
    const res = await H(resync(staff.token, mailboxId), deps);
    expect(res.status).toBe(200);
    const [row] = await auditRowsFor(deps, staff.staffId);
    expect(row).toMatchObject({
      action: "write.mailbox.resync", outcome: "ok", targetAccountId: ACCOUNT_ID, targetMailboxId: mailboxId,
      detail: { changed: true },
    });
    // The note stays in `audit_log.payload` alone.
    expect(JSON.stringify(row)).not.toContain(NOTE);
  });

  it("a mailbox that was not parked writes a no_change row", async () => {
    const { deps, staff, mailboxId } = await parked();
    await H(resync(staff.token, mailboxId), deps);
    await H(resync(staff.token, mailboxId), deps);
    const outcomes = (await auditRowsFor(deps, staff.staffId)).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["no_change", "ok"]);
  });

  it("a failed insert rolls the release back: the backoff stays and no audit_log row exists", async () => {
    const { deps, staff, mailboxId, retryAfter } = await parked();
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await H(resync(staff.token, mailboxId), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(broken.faults.count, "the fault was reached through the transaction").toBe(1);
    const [mb] = await deps.db.select({ retryAfter: mailboxes.retryAfter }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(new Date(mb!.retryAfter as unknown as string).getTime()).toBe(retryAfter.getTime());
    expect(await deps.db.select().from(auditLog).where(eq(auditLog.accountId, ACCOUNT_ID))).toEqual([]);
  });

  it.each([
    ["a role refusal", ["billing"], true],
    ["a mailbox that does not exist", ["ops"], false],
  ] as const)("%s whose row cannot be written answers audit_failed", async (_label, roles, real) => {
    const { deps, mailboxId } = await parked();
    const s = await seedStaff(deps, { roles });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const target = real ? mailboxId : "6e5d4c3b-2a19-4088-8776-655443322110";
    const res = await H(resync(s.token, target), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
    expect(broken.faults.count).toBe(1);
  });

  it("billing does not operate mailboxes: refused, recorded, nothing released", async () => {
    const { deps, mailboxId, retryAfter } = await parked();
    const billing = await seedStaff(deps, { roles: ["billing"] });
    const res = await H(resync(billing.token, mailboxId), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "role_required" } });
    const [row] = await auditRowsFor(deps, billing.staffId);
    expect(row).toMatchObject({ action: "write.mailbox.resync", outcome: "refused", refusalCode: "role_required" });
    const [mb] = await deps.db.select({ retryAfter: mailboxes.retryAfter }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(new Date(mb!.retryAfter as unknown as string).getTime()).toBe(retryAfter.getTime());
  });
});

describe("detail is a closed allowlist on both sides", () => {
  it("the writer throws on a key outside the action's list, or a value of the wrong shape", () => {
    expect(() => checkedDetail("read.roster", { filter: "all", page: 2 })).not.toThrow();
    expect(() => checkedDetail("read.roster", { note: "free text" })).toThrow(StaffAuditDetailError);
    expect(() => checkedDetail("read.roster", { filter: "everything" })).toThrow(StaffAuditDetailError);
    expect(() => checkedDetail("assert.external", { method: "GET", path: "/v1/a@b" })).toThrow(StaffAuditDetailError);
    expect(() => checkedDetail("read.search", { q: "a term" })).toThrow(StaffAuditDetailError);
  });

  it("a row planted by any other writer renders only what the list admits", async () => {
    const { deps, staff } = await world();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    await deps.db.insert(staffAuditEvents).values({
      requestId: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", staffUserId: staff.staffId, actorLabel: staff.email,
      roles: ["support"], action: "write.mailbox.resync", targetAccountId: ACCOUNT_ID, outcome: "ok",
      detail: { changed: true, note: "planted free text", changedTwice: "yes" },
    });
    const res = await H(get(`/admin/accounts/${ACCOUNT_ID}/staff-activity`, owner.token), deps);
    const body = (await res.json()) as StaffActivityPage;
    const planted = body.actions.find((e) => e.requestId === "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d")!;
    expect(planted.detail).toEqual({ changed: true });
    expect(JSON.stringify(body)).not.toContain("planted free text");
  });
});

describe("the staff identity routes record their refusals fail-closed, and a sign-out never waits", () => {
  it("a failed sign-in whose row cannot be written answers audit_failed", async () => {
    const deps = await staffDeps();
    const s = await seedStaff(deps, { roles: ["support"] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await H(post("/admin/staff/session", { email: s.email, password: "wrong password entirely" }), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
    expect(broken.faults.count).toBe(1);
  });

  it("a failed step-up whose row cannot be written answers audit_failed", async () => {
    const deps = await staffDeps();
    const s = await seedStaff(deps, { roles: ["support"] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await H(post("/admin/staff/step-up", { token: s.token, code: "000000" }), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
  });

  it("a refused roles change whose row cannot be written answers audit_failed", async () => {
    const deps = await staffDeps();
    const s = await seedStaff(deps, { roles: ["support"] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await H(post("/admin/staff/roles", { sessionToken: s.token, op: "grant", role: "owner", staffEmail: s.email }), { ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
  });

  it("a sign-out revokes even when its row cannot be written — removing access never waits", async () => {
    const deps = await staffDeps();
    const s = await seedStaff(deps, { roles: ["support"] });
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const out = await H(post("/admin/staff/sign-out", { token: s.token }), { ...deps, db: broken.db } as ApiDeps);
    expect(out.status).toBe(200);
    expect(broken.faults.count).toBe(1);
    const who = await H(post("/admin/staff/whoami", { token: s.token }), deps);
    expect(who.status).toBe(401);
  });
});

describe("the billing link is recorded before it mails, and every refusal is recorded", () => {
  const OPEN: AccessVerdict = { ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
  const port: EntitlementsPort = {
    access: async () => OPEN, accessOrFault: async () => OPEN,
    spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
    release: async () => "settled" as const, manageLink: async () => null, releaseAccount: async () => "none",
  };
  async function linked(roles: StaffRole[] = ["support"]) {
    const made = await makeDeps();
    const deps = {
      ...made.deps, admin: ADMIN,
      services: { ...made.deps.services, customerMail: made.mail, entitlementsPort: port },
    } as ApiDeps;
    await deps.db.insert(accounts).values({ id: ACCOUNT_ID, name: "Acme Ltd" });
    await deps.db.insert(users).values({ accountId: ACCOUNT_ID, email: "owner@acme.example" });
    const staff = await seedStaff(deps, { roles });
    const send = (d: ApiDeps): Promise<Response> =>
      H(post(`/admin/accounts/${ACCOUNT_ID}/billing-link`, { sessionToken: staff.token, reasonCode: "customer_request" }), d);
    return { deps, mailer: made.mailer, send };
  }
  const claims = (deps: ApiDeps) => deps.db.select().from(accountLifecycleNotices).where(eq(accountLifecycleNotices.accountId, ACCOUNT_ID));

  it("a claim whose row cannot be written sends nothing and leaves no claim behind", async () => {
    const { deps, mailer, send } = await linked();
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await send({ ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
    expect(broken.faults.count, "the fault was reached inside the claim").toBe(1);
    expect(await claims(deps), "the claim rolled back with its row").toEqual([]);
    expect(mailer.ofTemplate("billing_link")).toEqual([]);
  });

  it.each([
    ["a role refusal", ["ops"] as StaffRole[], 0],
    ["the cap's refusal", ["support"] as StaffRole[], 3],
  ] as const)("%s whose row cannot be written answers audit_failed", async (_label, roles, seeded) => {
    const { deps, mailer, send } = await linked([...roles]);
    for (let i = 0; i < seeded; i += 1) {
      await deps.db.insert(accountLifecycleNotices).values({ accountId: ACCOUNT_ID, kind: "billing_link", anchor: new Date(FIXED_NOW.getTime() - i - 1) });
    }
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const res = await send({ ...deps, db: broken.db } as ApiDeps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "audit_failed" } });
    expect(broken.faults.count).toBe(1);
    expect(mailer.ofTemplate("billing_link")).toEqual([]);
  });
});

describe("the Entra registration routes are audited and gated to ops and owner", () => {
  it("records the read, refuses support, and a refusal with no row answers audit_failed", async () => {
    const deps = await staffDeps();
    const ops = await seedStaff(deps, { roles: ["ops"] });
    const support = await seedStaff(deps, { roles: ["support"] });
    expect((await H(post("/admin/oauth/microsoft", { sessionToken: ops.token }), deps)).status).toBe(200);
    expect((await auditRowsFor(deps, ops.staffId)).map((r) => [r.action, r.outcome])).toEqual([["read.oauth_provider", "ok"]]);
    const refused = await H(post("/admin/oauth/microsoft", { sessionToken: support.token }), deps);
    expect(refused.status).toBe(403);
    expect((await auditRowsFor(deps, support.staffId)).map((r) => [r.action, r.outcome, r.refusalCode]))
      .toEqual([["read.oauth_provider", "refused", "role_required"]]);
    const broken = failingInsertInto(deps.db, staffAuditEvents);
    const blind = await H(post("/admin/oauth/microsoft", { sessionToken: support.token }), { ...deps, db: broken.db } as ApiDeps);
    expect(blind.status).toBe(503);
    expect(await blind.json()).toEqual({ error: { code: "audit_failed" } });
  });
});
