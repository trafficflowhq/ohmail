import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { eq } from "drizzle-orm";
import { UNMETERED_ACCESS, users, type AccessLifecycle, type EntitlementsPort } from "@trafficflow/db";
import { accountLifecycleNotices, authThrottle, creditRefundObligations } from "@trafficflow/db/cloud";
import { throttleKeysFor } from "@trafficflow/services";
import { makeDeps, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * THE NIGHTLY SWEEP'S DOORS (cloud 0040). The sweep takes one keyset position (`?after=`) and
 * answers `next` and `erasureDue`; the erase door takes one account (`?account=`), answers
 * `{skipped}` for one that is not due and never erases on a verdict it did not re-read. Both are
 * the scheduler's shape: 404 unarmed, 401 on a wrong bearer, 400 on anything but a uuid.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });
const SECRET = "s".repeat(32);
const ID = "0a000000-0000-4000-8000-000000000001";
const DAY = 24 * 60 * 60 * 1000;

const get = (path: string, secret: string | null = SECRET): Request => new Request(`http://api.test${path}`, {
  method: "GET", headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

function openPort(reads: string[]): EntitlementsPort {
  return {
    async access() { return UNMETERED_ACCESS; },
    async accessOrFault(id: string) { reads.push(id); return UNMETERED_ACCESS; },
    async spend() { return { verdict: "fault" }; },
    async release(): Promise<"settled"> { return "settled"; },
    async manageLink() { return null; },
    async releaseAccount() { throw new Error("nothing may be released on an open verdict"); },
  } as unknown as EntitlementsPort;
}

async function armed(reads: string[] = []): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return {
    ...deps, alerts: { secret: SECRET, sinks: [] },
    services: { ...deps.services, entitlementsPort: openPort(reads) },
  } as ApiDeps;
}

describe("GET /internal/account-lifecycle/run and /erase", () => {
  it("both are 404 unarmed and 401 on a wrong bearer", async () => {
    const { deps } = await makeDeps();
    for (const path of ["/internal/account-lifecycle/run", `/internal/account-lifecycle/erase?account=${ID}`]) {
      expect((await H(get(path), deps)).status, path).toBe(404);
      expect((await H(get(path, "wrong"), await armed())).status, path).toBe(401);
    }
  });

  it("the sweep answers next and erasureDue, and refuses an after that is not a uuid", async () => {
    const d = await armed();
    const res = await H(get("/internal/account-lifecycle/run"), d);
    expect(res.status).toBe(200);
    const body = await res.json() as { next: unknown; erasureDue: unknown };
    expect(body.next).toBeNull();
    expect(body.erasureDue).toEqual([]);
    expect((await H(get(`/internal/account-lifecycle/run?after=${ID}`), d)).status).toBe(200);
    expect((await H(get("/internal/account-lifecycle/run?after=1%20or%201=1"), d)).status).toBe(400);
  });

  it("the sweep runs the connect reminder log-only unless the host switched it to send, and send only beside its cutoff", async () => {
    const d = await armed();
    const run = async (deps: ApiDeps) =>
      ((await (await H(get("/internal/account-lifecycle/run"), deps)).json()) as { connectReminder: unknown }).connectReminder;
    const since = "2026-10-25T18:00:00Z";
    expect(await run(d)).toEqual({ mode: "log", since: null, owed: 0, owedSince: null });
    expect(await run({ ...d, connectReminderSince: since } as ApiDeps))
      .toEqual({ mode: "log", since: "2026-10-25T18:00:00.000Z", owed: 0, owedSince: 0 });
    expect(await run({ ...d, connectReminder: "send", connectReminderSince: since } as ApiDeps))
      .toEqual({ mode: "send", since: "2026-10-25T18:00:00.000Z", owed: 0, owedSince: null });
    for (const without of [{}, { connectReminderSince: "2026-10-25" }]) {
      expect(await run({ ...d, connectReminder: "send", ...without } as ApiDeps), JSON.stringify(without))
        .toEqual({ mode: "refused", since: null, owed: 0, owedSince: null });
    }
  });

  it("the erase door answers {skipped} for an account that is not due, and 400 without a uuid", async () => {
    const reads: string[] = [];
    const d = await armed(reads);
    const res = await H(get(`/internal/account-lifecycle/erase?account=${ID}`), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not_due" });
    expect((await H(get("/internal/account-lifecycle/erase"), d)).status).toBe(400);
    expect((await H(get("/internal/account-lifecycle/erase?account=nope"), d)).status).toBe(400);
  });

  /**
   * AN ACCOUNT PAST ITS RETENTION, WARNED IN ITS WEEK, through the door itself. Nobody presses
   * delete here, so this door hands the erasure what `DELETE /account` hands it: the keyer that
   * reaches the sign-in throttle's rows for the person's address, and the word that a refund
   * still owed is kept for the drain.
   */
  it("the erase door erases a due account: its people, its sign-in throttle rows, and it keeps a refund still owed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const erasureAt = new Date(FIXED_NOW.getTime() - 2 * DAY);
    const lifecycle: AccessLifecycle = {
      state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
      closedAt: new Date(FIXED_NOW.getTime() - 32 * DAY).toISOString(), erasureAt: erasureAt.toISOString(),
      erasedAt: null, formerlyPaid: false, lifecycleEpoch: new Date(FIXED_NOW.getTime() - 60 * DAY).toISOString(),
    };
    const warnedAt = new Date(erasureAt.getTime() - 7 * DAY);
    await db.insert(accountLifecycleNotices).values({
      accountId: s.accountId, kind: "erasure_week", anchor: erasureAt, sentAt: warnedAt, deliveredAt: warnedAt,
    });
    await db.insert(creditRefundObligations).values({
      accountId: s.accountId, action: "draft", attemptKey: "ak-p", attempt: "at-p", reason: "drafter_failed", meta: { n: 1 },
    });
    const released: string[] = [];
    const d = {
      ...deps, alerts: { secret: SECRET, sinks: [] },
      services: {
        ...deps.services,
        entitlementsPort: {
          ...openPort([]),
          async accessOrFault(id: string) {
            return id === s.accountId ? { ok: false, reason: "payment_required", lifecycle } : UNMETERED_ACCESS;
          },
          async releaseAccount(id: string) { released.push(id); return "cancelled"; },
        },
      },
    } as unknown as ApiDeps;

    const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, s.userId));
    const refused = await H(new Request("http://api.test/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: person!.email, password: "not the password" }),
    }), d);
    expect(refused.status).toBe(401);
    const hash = throttleKeysFor(deps.keyProvider).address(person!.email.trim().toLowerCase());
    const naming = async (): Promise<number> =>
      (await db.select({ key: authThrottle.key }).from(authThrottle)).filter((r) => r.key.includes(hash)).length;
    expect(await naming(), "the refused sign-in wrote no row to erase").toBeGreaterThan(0);

    const res = await H(get(`/internal/account-lifecycle/erase?account=${s.accountId}`), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "erased" });
    expect(released, "the money is stopped once, for this account").toEqual([s.accountId]);
    expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(0);
    expect(await naming(), "a throttle row still names the erased person's address").toBe(0);
    const owed = await db.select().from(creditRefundObligations).where(eq(creditRefundObligations.accountId, s.accountId));
    expect(owed.map((r) => [r.attempt, r.meta]), "the refund still owed is kept, pseudonymised").toEqual([["at-p", null]]);
    // Asked again, the door answers the erasure it already made and stops no money twice.
    const again = await H(get(`/internal/account-lifecycle/erase?account=${s.accountId}`), d);
    expect(await again.json()).toEqual({ outcome: "already_erased" });
    expect(released).toHaveLength(1);
  });
});
