import { describe, it, expect, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users, type AccessLifecycle, type AccessVerdict, bindDb } from "@trafficflow/db";
import {
  runAccountLifecyclePass, ACCOUNT_LIFECYCLE_BUDGET_MS, ERASURE_DUE_PER_RUN,
  type AccountLifecyclePassDeps,
} from "../src/index.js";

/**
 * THE NIGHTLY SWEEP HAS A BUDGET AND A RESUME POINT, AND ERASES NOTHING ITSELF. Enough accounts
 * behind a plane that takes a second per four reads: the sweep stops at its 45 s budget with
 * `next`, the follow-up from `next` covers the rest, and the two together are every account once.
 * A due account is NAMED in `erasureDue` and left alone — the erase door is its own invocation.
 */

const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
type Db = Awaited<ReturnType<typeof makeTestDb>>;

const OPEN: AccessVerdict = { ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
const DUE: AccessLifecycle = {
  state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
  closedAt: new Date(NOW.getTime() - 90 * DAY).toISOString(),
  erasureAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
  erasedAt: null, formerlyPaid: false, lifecycleEpoch: new Date(NOW.getTime() - 200 * DAY).toISOString(),
};

describe("the account-lifecycle sweep's budget", () => {
  let db: Db;
  beforeAll(async () => { db = await makeTestDb(); });

  async function seed(n: number): Promise<string[]> {
    const rows = await db.insert(accounts).values(Array.from({ length: n }, (_, i) => ({ name: `budget-${i}` })))
      .returning({ id: accounts.id });
    await db.insert(users).values(rows.map((r, i) => ({ accountId: r.id, email: `b${i}-${r.id.slice(0, 8)}@budget.test` })));
    return rows.map((r) => r.id).sort();
  }

  /** A plane whose reads cost a quarter second of the pass's clock each — a second per chunk of four. */
  function slowPlane(mine: Set<string>, verdict: (id: string) => AccessVerdict) {
    let clock = 0;
    const read: string[] = [];
    const released: string[] = [];
    const deps: Omit<AccountLifecyclePassDeps, "after"> = {
      port: {
        accessOrFault: async (id) => { clock += 250; if (mine.has(id)) read.push(id); return verdict(id); },
        releaseAccount: async (id) => { released.push(id); return "cancelled"; },
      },
      mail: null, now: () => NOW, clock: () => clock,
    };
    return { deps, read, released };
  }

  it("stops at its budget with next, and the follow-up covers every remaining account once", async () => {
    const ids = await seed(250);
    const mine = new Set(ids);
    const { deps, read } = slowPlane(mine, () => OPEN);
    const first = await runAccountLifecyclePass(bindDb(db, { account: null }), deps);
    expect(first.next, "a sweep over its budget did not stop").not.toBeNull();
    expect(first.accounts).toBeLessThan(250);
    expect(first.accounts, "the budget was not the 45 s one").toBe((ACCOUNT_LIFECYCLE_BUDGET_MS / 1000) * 4);
    const second = await runAccountLifecyclePass(bindDb(db, { account: null }), { ...deps, after: first.next, clock: () => 0 });
    expect(second.next, "the follow-up did not reach the end").toBeNull();
    const seen = read.filter((id) => mine.has(id));
    expect(new Set(seen).size, "an account was read twice across the two sweeps").toBe(seen.length);
    expect([...seen].sort(), "an account was skipped between the sweeps").toEqual(ids);
  });

  it("names a due account for the erase door and erases nothing itself", async () => {
    const [due] = await seed(1);
    const { deps, released } = slowPlane(new Set([due!]), (id) => (id === due
      ? { ok: false, reason: "payment_required", lifecycle: DUE } : OPEN));
    const r = await runAccountLifecyclePass(bindDb(db, { account: null }), { ...deps, clock: () => 0 });
    expect(r.erasureDue, "the due account was not named").toContain(due);
    expect(released, "the sweep stopped a subscription itself").toEqual([]);
    const [row] = await db.select({ erasedAt: accounts.erasedAt }).from(accounts).where(inArray(accounts.id, [due!]));
    expect(row!.erasedAt, "the sweep erased an account inline").toBeNull();
  });

  it("stops after naming a page of due erasures, so its answer stays small", async () => {
    const ids = await seed(ERASURE_DUE_PER_RUN + 12);
    const mine = new Set(ids);
    const { deps } = slowPlane(mine, (id) => (mine.has(id) ? { ok: false, reason: "payment_required", lifecycle: DUE } : OPEN));
    const r = await runAccountLifecyclePass(bindDb(db, { account: null }), { ...deps, clock: () => 0, after: null });
    const named = r.erasureDue.filter((id) => mine.has(id));
    expect(named.length).toBeLessThanOrEqual(ERASURE_DUE_PER_RUN + 3);
    expect(r.next, "a sweep past its due bound did not stop").not.toBeNull();
  });
});
