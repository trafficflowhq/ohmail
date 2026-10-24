import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { accounts, accountStorage, devices, mailboxes, sessions, users } from "@trafficflow/db";
import { accountLifecycleNotices, authEvents, creditRefundObligations } from "@trafficflow/db/cloud";
import type { ApiDeps } from "@trafficflow/api";
import {
  WORKER_ROSTER_INTERVAL_SECONDS,
  type AccountBatch, type AccountDetailV2, type StaffActivityPage, type StaffRole, type SyncRosterPage,
} from "@trafficflow/services";
import { FIXED_NOW } from "./helpers.js";
import { H, get, post, seedStaff, staffDeps } from "./_staff-fixtures.js";

/**
 * The open facts another program joins against (cloud 0047): the sync roster, the batch by id
 * and the account page. Every figure here is a count, a timestamp, an id or a closed-set word.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const at = (minutes: number): Date => new Date(FIXED_NOW.getTime() + minutes * 60_000);

async function world(roles: readonly StaffRole[] = ["support"]): Promise<{ deps: ApiDeps; token: string }> {
  const deps = await staffDeps();
  await deps.db.insert(accounts).values([
    { id: A, name: "Acme", createdAt: at(-100) },
    { id: B, name: "Beta", createdAt: at(-90), erasedAt: at(-5) },
    { id: C, name: "Gamma", createdAt: at(-80) },
  ]);
  const [user] = await deps.db.insert(users).values({
    accountId: A, email: "owner@acme.example", createdAt: at(-100), emailVerifiedAt: at(-70),
  }).returning();
  await deps.db.insert(users).values({ accountId: A, email: "second@acme.example", createdAt: at(-50) });
  await deps.db.insert(mailboxes).values([
    { accountId: A, provider: "imap", address: "a1@acme.example", status: "connected", lastSyncAt: at(-3),
      syncBlockedReason: "account_closed", syncBlockedSince: at(-40), createdAt: at(-95) },
    { accountId: A, provider: "imap", address: "a2@acme.example", status: "connected", lastSyncAt: at(-1),
      organizerRole: "reader", organizerReleasedAt: at(-30), organizeConsentedAt: at(-60) },
    // Held by somebody: released once, but a holder is renewing — not a mailbox with no holder.
    { accountId: A, provider: "imap", address: "a3@acme.example", status: "connected",
      organizerRole: "reader", organizerReleasedAt: at(-20), organizerState: "held" },
    { accountId: A, provider: "imap", address: "a4@acme.example", status: "disabled" },
  ]);
  await deps.db.insert(accountLifecycleNotices).values([
    { accountId: A, kind: "closed", anchor: at(-45), sentAt: at(-44) },
    { accountId: A, kind: "reopened", anchor: at(-10), sentAt: at(-9) },
  ]);
  const userId = (user as { id: string }).id;
  const [device] = await deps.db.insert(devices).values({ accountId: A, userId, kind: "desktop-linux", label: "never shown" }).returning();
  await deps.db.insert(devices).values({ accountId: A, userId, kind: "a kind nobody wrote" });
  const session = (scope: string, revokedAt: Date | null) => ({
    accountId: A, userId, deviceId: (device as { id: string }).id, familyId: crypto.randomUUID(), scope,
    accessExpiresAt: at(60), refreshExpiresAt: at(600), revokedAt, lastSeenAt: at(-2),
  });
  await deps.db.insert(sessions).values([session("full", null), session("full", null), session("enrollment", null), session("full", at(-60))]);
  await deps.db.insert(authEvents).values([
    { accountId: A, userId, event: "login", at: at(-2) },
    { accountId: A, userId, event: "an event nobody wrote", at: at(-1) },
  ]);
  await deps.db.insert(accountStorage).values({ accountId: A, bytes: 4096, updatedAt: at(-7) });
  await deps.db.insert(creditRefundObligations).values([
    { accountId: A, action: "draft", attemptKey: "k1", attempt: "a1", reason: "drafter_failed", tries: 3, lastFault: "timeout", owedAt: at(-70) },
    { accountId: A, action: "draft", attemptKey: "k2", attempt: "a2", reason: "drafter_failed", tries: 1, lastFault: "Not A Fault Word!", owedAt: at(-20) },
    { accountId: A, action: "draft", attemptKey: "k3", attempt: "a3", reason: "drafter_failed", tries: 9, settledAt: at(-1) },
  ]);
  const staff = await seedStaff(deps, { roles });
  return { deps, token: staff.token };
}

async function read<T>(w: { deps: ApiDeps; token: string }, path: string): Promise<T> {
  const res = await H(get(path, w.token), w.deps);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

describe("GET /admin/sync-roster", () => {
  it("answers each account's mailbox facts, keyset-paged by id", async () => {
    const w = await world();
    const page = await read<SyncRosterPage>(w, "/admin/sync-roster");
    expect(page.rows.map((r) => r.accountId)).toEqual([A, B, C]);
    expect(page.nextCursor).toBeNull();
    expect(page.rows[0]).toEqual({
      accountId: A, mailboxes: 4, disabled: 1, blockedAccountClosed: 1, oldestBlockedSince: at(-40).toISOString(),
      releasedNoHolder: 1, oldestReleasedAt: at(-30).toISOString(), lastSyncMax: at(-1).toISOString(),
      lastClosedNoticeAnchor: at(-45).toISOString(), lastReopenedNoticeAnchor: at(-10).toISOString(), erasedAt: null,
      createdAt: at(-100).toISOString(), emailVerifiedAt: at(-70).toISOString(), firstMailboxAt: at(-95).toISOString(),
    });
    expect(page.rows[1]).toMatchObject({
      accountId: B, mailboxes: 0, releasedNoHolder: 0, erasedAt: at(-5).toISOString(),
      createdAt: at(-90).toISOString(), emailVerifiedAt: null, firstMailboxAt: null,
    });
  });

  it("names when the account first had a verified login and its oldest mailbox, not the newest", async () => {
    const w = await world();
    // A third login verified later moves nothing: the earliest verification is the account's.
    await w.deps.db.insert(users).values({ accountId: A, email: "third@acme.example", createdAt: at(-40), emailVerifiedAt: at(-30) });
    const page = await read<SyncRosterPage>(w, "/admin/sync-roster");
    expect(page.rows[0]).toMatchObject({ emailVerifiedAt: at(-70).toISOString(), firstMailboxAt: at(-95).toISOString() });
    expect(page.rows[2]).toMatchObject({ accountId: C, emailVerifiedAt: null, firstMailboxAt: null });
  });

  it("pages by cursor and ends on a short page", async () => {
    const w = await world();
    const first = await read<SyncRosterPage>(w, "/admin/sync-roster?limit=2");
    expect(first.rows.map((r) => r.accountId)).toEqual([A, B]);
    expect(first.nextCursor).toBe(B);
    const second = await read<SyncRosterPage>(w, `/admin/sync-roster?limit=2&cursor=${first.nextCursor}`);
    expect(second.rows.map((r) => r.accountId)).toEqual([C]);
    expect(second.nextCursor).toBeNull();
  });

  it("states the worker's roster interval, and it is the worker's own", async () => {
    const w = await world();
    expect((await read<SyncRosterPage>(w, "/admin/sync-roster")).workerRosterIntervalSeconds).toBe(WORKER_ROSTER_INTERVAL_SECONDS);
    const src = readFileSync(fileURLToPath(new URL("../../../apps/worker/src/config.ts", import.meta.url)), "utf8");
    const m = /export const DEFAULT_ROSTER_INTERVAL_MS = ([\d_]+);/.exec(src);
    expect(m, "the worker's constant parsed").not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, "")) / 1000).toBe(WORKER_ROSTER_INTERVAL_SECONDS);
  });
});

describe("GET /admin/accounts?ids=", () => {
  it("answers the ids in the order asked and names the unknown ones", async () => {
    const w = await world();
    const unknown = "44444444-4444-4444-8444-444444444444";
    const batch = await read<AccountBatch>(w, `/admin/accounts?ids=${C},${unknown},${A},not-an-id`);
    expect(batch.rows.map((r) => r.id)).toEqual([C, A]);
    expect(batch.unknownIds).toEqual([unknown, "not-an-id"]);
  });

  it("masks owner addresses for ops, in the batch and in the roster page", async () => {
    const w = await world(["ops"]);
    const batch = await read<AccountBatch>(w, `/admin/accounts?ids=${A}`);
    expect(batch.rows[0]!.ownerEmail).toBe("•••@acme.example");
    const page = await read<{ accounts: Array<{ id: string; ownerEmail: string }> }>(w, "/admin/accounts");
    expect(page.accounts.find((a) => a.id === A)!.ownerEmail).toBe("•••@acme.example");
  });
});

describe("GET /admin/accounts/:id — the account page", () => {
  it("carries the organizer, notice, device, session, auth, storage and debt facts", async () => {
    const w = await world();
    const d = await read<AccountDetailV2>(w, `/admin/accounts/${A}`);
    expect(d.account).toMatchObject({ id: A, ownerEmail: "owner@acme.example", erasedAt: null });
    expect(d.users.map((u) => u.email)).toEqual(["owner@acme.example", "second@acme.example"]);
    expect(d.users.every((u) => u.lastLoginAt === null)).toBe(true);
    const a2 = d.mailboxes.find((m) => m.address === "a2@acme.example")!;
    expect(a2).toMatchObject({
      organizerRole: "reader", organizerReleasedAt: at(-30).toISOString(), consentOnRecord: true, organizerState: null,
    });
    expect(d.mailboxes.find((m) => m.address === "a1@acme.example")!.consentOnRecord).toBe(false);
    expect(d.lifecycleNotices.map((n) => n.kind)).toEqual(["reopened", "closed"]);
    // Never checked and nothing emptied: the facts say so rather than inventing a reading.
    expect(d.storage).toEqual({
      bytes: 4096, updatedAt: at(-7).toISOString(), checkedAt: null, drift: null,
      emptiedForSpace: 0, firstEmptiedAt: null, lastEmptiedAt: null, keptFrom: null, withheldOnArrival: 0,
    });
    expect(d.devices.map((x) => x.kind).sort()).toEqual(["desktop-linux", "other"]);
    expect(d.sessions).toEqual({ active: { full: 2, enrollment: 1 }, revoked30d: 1, lastSeenAt: at(-2).toISOString() });
    expect(d.authEvents.map((e) => e.event)).toEqual(["other", "login"]);
    expect(d.owedReversals).toEqual({ count: 2, oldestOwedAt: at(-70).toISOString(), tries: 3, lastFault: "timeout" });
    expect(JSON.stringify(d)).not.toContain("never shown");
  });

  it("says what the storage counter knows: emptied for space, since when, kept from, arrivals, and its last check", async () => {
    const w = await world();
    await w.deps.db.update(accountStorage).set({
      bytes: 3_000_000_000, huskedForSpace: 4_321, firstHuskedAt: at(-60 * 24 * 3), lastHuskedAt: at(-30),
      keptFrom: "2026-05-01", withheldOnArrival: 12, recountedAt: at(-20), recountDrift: 1_250,
    }).where(eq(accountStorage.accountId, A));
    const d = await read<AccountDetailV2>(w, `/admin/accounts/${A}`);
    expect(d.storage).toEqual({
      bytes: 3_000_000_000, updatedAt: at(-7).toISOString(), checkedAt: at(-20).toISOString(), drift: 1_250,
      emptiedForSpace: 4_321, firstEmptiedAt: at(-60 * 24 * 3).toISOString(), lastEmptiedAt: at(-30).toISOString(),
      keptFrom: "2026-05", withheldOnArrival: 12,
    });
    // An account with no counter row has no storage block at all.
    expect((await read<AccountDetailV2>(w, `/admin/accounts/${C}`)).storage).toBeNull();
  });

  it("masks every login address for ops", async () => {
    const w = await world(["ops"]);
    const d = await read<AccountDetailV2>(w, `/admin/accounts/${A}`);
    expect(d.account.ownerEmail).toBe("•••@acme.example");
    expect(d.users.map((u) => u.email)).toEqual(["•••@acme.example", "•••@acme.example"]);
    expect(JSON.stringify(d)).not.toContain("owner@acme");
  });

  it("names a fault word it does not know as other", async () => {
    const w = await world();
    await w.deps.db.insert(creditRefundObligations).values(
      { accountId: C, action: "draft", attemptKey: "k", attempt: "a", reason: "drafter_failed", tries: 5, lastFault: "Not A Fault Word!" },
    );
    const d = await read<AccountDetailV2>(w, `/admin/accounts/${C}`);
    expect(d.owedReversals).toMatchObject({ count: 1, tries: 5, lastFault: "other" });
  });

  it("lists the staff actions on the account and keeps the views for the account holder", async () => {
    const w = await world(["support"]);
    const owner = await seedStaff(w.deps, { roles: ["owner"] });
    const [mb] = await w.deps.db.insert(mailboxes).values({
      accountId: A, provider: "imap", address: "parked@acme.example", retryAfter: at(15),
    }).returning();
    const released = await H(post("/admin/mailboxes/resync", {
      sessionToken: w.token, mailboxId: (mb as { id: string }).id, note: "release after the outage",
    }), w.deps);
    expect(released.status).toBe(200);
    await read(w, `/admin/accounts/${A}`);

    const page = await read<AccountDetailV2>(w, `/admin/accounts/${A}`);
    expect(page.staffActions.map((e) => e.action)).toEqual(["write.mailbox.resync"]);
    const support = await read<StaffActivityPage>(w, `/admin/accounts/${A}/staff-activity`);
    expect(support.actions.map((e) => e.action)).toEqual(["write.mailbox.resync"]);
    expect(support.views).toBeUndefined();
    const asOwner = await read<StaffActivityPage>({ deps: w.deps, token: owner.token }, `/admin/accounts/${A}/staff-activity`);
    expect(asOwner.views!.length).toBeGreaterThanOrEqual(3);
    expect(asOwner.views!.every((e) => e.action.startsWith("read."))).toBe(true);
  });
});
