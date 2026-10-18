import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, accountSettings, users, type AccessVerdict, type EntitlementsPort } from "@trafficflow/db";
import { accountLifecycleNotices, staffSessions } from "@trafficflow/db/cloud";
import type { StaffRole } from "@trafficflow/services";
import type { ApiDeps } from "@trafficflow/api";
import { makeDeps, FIXED_NOW } from "./helpers.js";
import { ADMIN, H, post, seedStaff, auditRowsFor } from "./_staff-fixtures.js";

/**
 * `POST /admin/accounts/:id/billing-link` — staff mail an account's owner a link to the app's
 * billing page. Driven through the route table: roles, the step-up, the cap of three per account
 * per day, the claim and its audit row, and what each failure leaves behind.
 */

const DAY = 24 * 60 * 60 * 1000;
const OWNER = "owner@acme.example";

function meteredPort(): EntitlementsPort {
  const verdict: AccessVerdict = {
    ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
  };
  const access = async (): Promise<AccessVerdict> => verdict;
  return {
    access, accessOrFault: access,
    spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
    release: async () => "settled" as const,
    manageLink: async () => ({ url: "https://plane.ohmail.app/manage?token=t" }),
    releaseAccount: async () => "none",
  };
}

interface WorldOpts { roles?: StaffRole[]; locale?: "en" | "de"; mailer?: boolean; billingPage?: boolean; users?: boolean }

async function world(o: WorldOpts = {}) {
  const made = await makeDeps();
  const services = {
    ...made.deps.services,
    ...(o.mailer === false ? {} : { customerMail: made.mail }),
    ...(o.billingPage === false ? {} : { entitlementsPort: meteredPort() }),
  };
  const deps = { ...made.deps, admin: ADMIN, services } as ApiDeps;
  const [account] = await deps.db.insert(accounts).values({ name: "Acme Ltd" }).returning();
  const accountId = (account as { id: string }).id;
  let ownerId: string | null = null;
  if (o.users !== false) {
    // The OLDEST login is the account's owner, as the roster reads it; the second is never mailed.
    const [owner] = await deps.db.insert(users)
      .values({ accountId, email: OWNER, createdAt: new Date(FIXED_NOW.getTime() - 2 * DAY) }).returning();
    ownerId = (owner as { id: string }).id;
    await deps.db.insert(users)
      .values({ accountId, email: "second@acme.example", createdAt: new Date(FIXED_NOW.getTime() - DAY) });
  }
  if (o.locale) await deps.db.insert(accountSettings).values({ accountId, locale: o.locale });
  const staff = await seedStaff(deps, { roles: o.roles ?? ["support"] });
  const send = (body: Record<string, unknown> = {}, id = accountId): Promise<Response> =>
    H(post(`/admin/accounts/${id}/billing-link`, { sessionToken: staff.token, reasonCode: "customer_request", ...body }), deps);
  const notices = () => deps.db.select().from(accountLifecycleNotices)
    .where(and(eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "billing_link")));
  const mails = () => made.mailer.ofTemplate("billing_link");
  return { made, deps, accountId, ownerId, staff, send, notices, mails };
}

const code = (body: unknown): string | undefined => (body as { error?: { code?: string } }).error?.code;
/** Outcome and refusal code per row, sorted: rows written in one instant have no order by `at`. */
const outcomes = async (deps: ApiDeps, staffId: string): Promise<string[]> =>
  (await auditRowsFor(deps, staffId)).map((r) => `${r.outcome} ${r.refusalCode ?? "-"}`).sort();

describe("the billing link reaches the oldest login, once, and says so", () => {
  it("support sends one mail to the oldest login, in the account's language, and the answer names its row", async () => {
    const w = await world({ locale: "de" });
    const res = await w.send({ ticketRef: "T-1042" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true, action: "write.billing_link", accountId: w.accountId, sent: true,
      sendsToday: 1, limit: 3, actor: w.staff.email, at: FIXED_NOW.toISOString(),
    });
    const [send, ...more] = w.mails();
    expect(more).toEqual([]);
    expect(send!.to).toBe(OWNER);
    expect(send!.data).toEqual({ locale: "de", billingUrl: "http://localhost:3001/account/manage", supportEmail: "support@ohmail.app" });

    const [notice, ...others] = await w.notices();
    expect(others).toEqual([]);
    expect(new Date(notice!.anchor).getTime()).toBe(FIXED_NOW.getTime());

    const [row, ...rest] = await auditRowsFor(w.deps, w.staff.staffId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      action: "write.billing_link", outcome: "ok", targetAccountId: w.accountId, targetUserId: w.ownerId,
      reasonCode: "customer_request", ticketRef: "T-1042", detail: { sendsToday: 1 },
    });
    expect(body.audit).toEqual({ id: row!.id, at: new Date(row!.at).toISOString() });
    expect(res.headers.get("x-request-id")).toBe(row!.requestId);
    // The customer's address is the envelope's alone: not in the answer, not on the row.
    expect(JSON.stringify(body)).not.toContain(OWNER);
    expect(JSON.stringify(row)).not.toContain(OWNER);
  });

  it("an account with no language set is mailed in English", async () => {
    const w = await world();
    expect((await w.send()).status).toBe(200);
    expect(w.mails()[0]!.data.locale).toBe("en");
  });

  it.each([["billing"], ["owner"]] as const)("%s may send it too", async (role) => {
    const w = await world({ roles: [role] });
    expect((await w.send()).status).toBe(200);
    expect(w.mails()).toHaveLength(1);
  });

  it("ops may not: refused, recorded, nothing claimed or sent", async () => {
    const w = await world({ roles: ["ops"] });
    const res = await w.send();
    expect(res.status).toBe(403);
    expect(code(await res.json())).toBe("role_required");
    expect((await auditRowsFor(w.deps, w.staff.staffId)).map((r) => [r.action, r.outcome, r.refusalCode]))
      .toEqual([["write.billing_link", "refused", "role_required"]]);
    expect(await w.notices()).toEqual([]);
    expect(w.mails()).toEqual([]);
  });

  it("a session whose second factor is older than the window is refused before anything runs", async () => {
    const w = await world();
    await w.deps.db.update(staffSessions).set({ lastTwofaAt: new Date(FIXED_NOW.getTime() - DAY) })
      .where(eq(staffSessions.id, w.staff.sessionId));
    const res = await w.send();
    expect(res.status).toBe(403);
    expect(code(await res.json())).toBe("step_up_required");
    expect(await auditRowsFor(w.deps, w.staff.staffId)).toEqual([]);
    expect(await w.notices()).toEqual([]);
    expect(w.mails()).toEqual([]);
  });
});

describe("three per account in any 24 hours", () => {
  it("the fourth is refused rate_limited, recorded, and sends nothing; the answer says when the next may go", async () => {
    const w = await world();
    for (let i = 0; i < 3; i += 1) {
      expect((await w.send()).status, `send ${i + 1}`).toBe(200);
      w.made.clock.advance(60_000);
    }
    const fourth = await w.send();
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({
      error: { code: "rate_limited" }, retryAt: new Date(FIXED_NOW.getTime() + DAY).toISOString(),
    });
    expect(w.mails()).toHaveLength(3);
    expect(await w.notices()).toHaveLength(3);
    const rows = await auditRowsFor(w.deps, w.staff.staffId);
    expect(rows.map((r) => [r.outcome, r.refusalCode ?? null])).toEqual([
      ["ok", null], ["ok", null], ["ok", null], ["refused", "rate_limited"],
    ]);
    expect(rows.map((r) => (r.detail as { sendsToday?: number } | null)?.sendsToday ?? null)).toEqual([1, 2, 3, null]);
  });

  it("three presses in the same instant are three claims, and the fourth is still refused", async () => {
    // A coarse clock must not merge claims on the (account, kind, anchor) key.
    const w = await world();
    for (let i = 0; i < 3; i += 1) expect((await w.send()).status).toBe(200);
    expect((await w.send()).status).toBe(429);
    expect(await w.notices()).toHaveLength(3);
  });

  it("claims older than a day leave the window, and other kinds and other accounts never count", async () => {
    const w = await world();
    const other = await w.deps.db.insert(accounts).values({ name: "Other" }).returning();
    const otherId = (other[0] as { id: string }).id;
    const old = (ms: number) => new Date(FIXED_NOW.getTime() - DAY - ms);
    await w.deps.db.insert(accountLifecycleNotices).values([
      { accountId: w.accountId, kind: "billing_link", anchor: old(1) },
      { accountId: w.accountId, kind: "billing_link", anchor: old(2) },
      { accountId: w.accountId, kind: "billing_link", anchor: old(3) },
      { accountId: w.accountId, kind: "closed", anchor: FIXED_NOW },
      { accountId: otherId, kind: "billing_link", anchor: FIXED_NOW },
      { accountId: otherId, kind: "billing_link", anchor: new Date(FIXED_NOW.getTime() - 1) },
      { accountId: otherId, kind: "billing_link", anchor: new Date(FIXED_NOW.getTime() - 2) },
    ]);
    const res = await w.send();
    expect(res.status).toBe(200);
    expect((await res.json() as { sendsToday: number }).sendsToday).toBe(1);
  });
});

describe("what is refused before a claim, and recorded", () => {
  it("an unknown, erased or login-less account is a 404 that sends nothing; a malformed id never arrives", async () => {
    const w = await world();
    const cases: Array<[string, string]> = [];
    const unknown = await w.send({}, "6e5d4c3b-2a19-4088-8776-655443322110");
    cases.push(["unknown", `${unknown.status} ${code(await unknown.json())}`]);
    // The app's edge answers a path id that is not a uuid, before any handler or audit.
    const malformed = await w.send({}, "not-a-uuid");
    cases.push(["malformed", `${malformed.status} ${code(await malformed.json())}`]);
    await w.deps.db.update(accounts).set({ erasedAt: FIXED_NOW }).where(eq(accounts.id, w.accountId));
    const erased = await w.send();
    cases.push(["erased", `${erased.status} ${code(await erased.json())}`]);
    expect(cases).toEqual([
      ["unknown", "404 account_not_found"], ["malformed", "400 validation_failed"], ["erased", "404 account_erased"],
    ]);
    expect(await outcomes(w.deps, w.staff.staffId)).toEqual(["refused account_erased", "refused account_not_found"]);
    expect(w.mails()).toEqual([]);

    const bare = await world({ users: false });
    const none = await bare.send();
    expect(none.status).toBe(404);
    expect(code(await none.json())).toBe("no_login");
    expect(await bare.notices()).toEqual([]);
  });

  it("a missing or unknown reason, or a malformed ticket, is a 400 before anything is read", async () => {
    const w = await world();
    const answers: string[] = [];
    for (const body of [{ reasonCode: undefined }, { reasonCode: "because" }, { ticketRef: "has spaces" }, { ticketRef: "x".repeat(65) }]) {
      const res = await w.send(body);
      answers.push(`${res.status} ${code(await res.json())}`);
    }
    expect(answers).toEqual(["400 reason_required", "400 reason_required", "400 bad_ticket", "400 bad_ticket"]);
    expect(await auditRowsFor(w.deps, w.staff.staffId)).toEqual([]);
    expect(w.mails()).toEqual([]);
  });

  it("a deployment with no customer mailer refuses mailer_unconfigured and claims nothing", async () => {
    const w = await world({ mailer: false });
    const res = await w.send();
    expect(res.status).toBe(503);
    expect(code(await res.json())).toBe("mailer_unconfigured");
    expect((await auditRowsFor(w.deps, w.staff.staffId)).map((r) => [r.outcome, r.refusalCode]))
      .toEqual([["failed", "mailer_unconfigured"]]);
    expect(await w.notices()).toEqual([]);
  });

  it("a deployment with no billing page refuses no_billing_page and claims nothing", async () => {
    const w = await world({ billingPage: false });
    const res = await w.send();
    expect(res.status).toBe(404);
    expect(code(await res.json())).toBe("no_billing_page");
    expect((await auditRowsFor(w.deps, w.staff.staffId)).map((r) => [r.outcome, r.refusalCode]))
      .toEqual([["refused", "no_billing_page"]]);
    expect(await w.notices()).toEqual([]);
    expect(w.mails()).toEqual([]);
  });
});

describe("after the claim: what the mailer's answer leaves behind", () => {
  it("a transport failure keeps the claim (a mail may have left) and records the failure", async () => {
    const w = await world();
    w.made.mailer.failNext();
    const res = await w.send();
    expect(res.status).toBe(502);
    expect(code(await res.json())).toBe("mail_failed");
    expect(await w.notices()).toHaveLength(1);
    expect(await outcomes(w.deps, w.staff.staffId)).toEqual(["failed mail_failed", "ok -"]);
  });

  it("a mailer that throws instead of answering is a transport failure: the claim stays", async () => {
    const w = await world();
    const throwing = {
      sendLifecycleNotice: async () => ({ status: "sent" as const }),
      sendBillingLink: async (): Promise<never> => { throw new Error("transport exploded"); },
    };
    const deps = { ...w.deps, services: { ...w.deps.services, customerMail: throwing } } as ApiDeps;
    const res = await H(post(`/admin/accounts/${w.accountId}/billing-link`, { sessionToken: w.staff.token, reasonCode: "incident" }), deps);
    expect(res.status).toBe(502);
    expect(code(await res.json())).toBe("mail_failed");
    expect(await w.notices()).toHaveLength(1);
    expect(await outcomes(w.deps, w.staff.staffId)).toEqual(["failed mail_failed", "ok -"]);
  });

  it("a send the mailer declined hands the claim back, so it does not spend the day's three", async () => {
    const w = await world();
    w.made.mailer.skipNext("mailer_disabled");
    const res = await w.send();
    expect(res.status).toBe(503);
    expect(code(await res.json())).toBe("mailer_unconfigured");
    expect(await w.notices()).toEqual([]);
    expect(await outcomes(w.deps, w.staff.staffId)).toEqual(["failed mailer_unconfigured", "ok -"]);
  });
});
