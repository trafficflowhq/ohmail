import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { ServiceError, type ServiceContext } from "@trafficflow/services";
import { searchFor } from "../src/composition-passes.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * A SUPERSEDED SEARCH STOPS AT ITS NEXT CHECK POINT, through the local door's own service
 * (`searchFor("local")`): the estimate and the summary take a turn at the first line of their
 * transaction, and before the typo tier and the indexing read; the page only checks. No answer
 * asks the planner for an estimate. Statements are recorded as `slow/search-budget-local.test.ts`
 * records them. Watched red: the first-line turn removed.
 */
const N = 300;
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));

let dir = "";
let o: OpenLocalDb;
let accountId = "";
const textOf = (st: SQL): string => (o.db as unknown as { dialect: { sqlToQuery(s: SQL): { sql: string } } }).dialect.sqlToQuery(st).sql;

/** Every statement the service sends, `BEGIN` marking where its transaction opened. */
function recording(target: any, seen: string[]): any {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop === "execute") return (st: SQL) => { seen.push(textOf(st)); return t.execute(st); };
      if (prop === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) => t.transaction((tx: unknown) => { seen.push("BEGIN"); return fn(recording(tx, seen)); });
      }
      return Reflect.get(t, prop, recv);
    },
  });
}

interface Run { seen: string[]; turns: number; checks: number; cutAt: number | null }

/** A hook that supersedes the request at its `at`-th turn (`null`: never); `pre`: superseded already. */
function hooked(at: number | null, pre = false): { run: Run; hook: { check(): void; turn(): Promise<void> } } {
  const run: Run = { seen: [], turns: 0, checks: 0, cutAt: null };
  let superseded = pre;
  const check = (): void => { if (superseded) throw new ServiceError("search_superseded", 409, "a newer search replaced this one"); };
  return {
    run,
    hook: {
      check: () => { run.checks++; check(); },
      turn: async () => {
        await new Promise<void>((r) => setImmediate(r));
        run.turns++;
        if (run.turns === at) { superseded = true; run.cutAt = run.seen.length; }
        check();
      },
    },
  };
}

const ctx = (seen: string[], hook?: { check(): void; turn(): Promise<void> }): ServiceContext =>
  ({
    db: recording(o.db, seen), accountId, userId: null, now: () => new Date("2026-10-20T12:00:00Z"), requestId: "supersede",
    ...(hook ? { searchSupersede: hook } : {}),
  }) as ServiceContext;

async function refused(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "the superseded request answered").toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe("search_superseded");
  expect((err as ServiceError).httpStatus).toBe(409);
  return err as ServiceError;
}

describe("a superseded search stops at its next check point", () => {
  beforeAll(async () => {
    dir = await freshDataDir("ohmail-search-supersede-service-");
    o = await openLocalDb(dir);
    accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('supersede') returning id`))[0].id;
    const mb = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'supersede@mail.example') returning id`))[0].id;
    await o.db.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator, to_addresses, cc_addresses)
      select ${accountId}::uuid, ${mb}::uuid, 'h', 'supersede:' || g, 'harbour note ' || g, 'sender' || (g % 7) || '@dom.example',
        timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g), jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g),
        '[]'::jsonb, '[]'::jsonb
      from generate_series(1, ${N}) g`);
    await o.db.execute(sql`insert into message_bodies (message_id, text) select m.id, 'harbour letter' from messages m where m.account_id = ${accountId}::uuid`);
    await o.db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${accountId}::uuid`);
    const built = await searchIndexBackfillPass({ db: o.db as unknown as Tx, accountId, rounds: 100, batch: 1_000 });
    expect(built.marked).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await o?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("CONTROL: no hook and a hook that never supersedes send the same statements, and the estimate is cut", async () => {
    const svc = searchFor("local");
    for (const parts of ["estimate", "summary", "page"] as const) {
      const bare: string[] = [];
      const plain = await svc.search(ctx(bare), { q: "harbour", parts, limit: 50 });
      const { run, hook } = hooked(null);
      const out = await svc.search(ctx(run.seen, hook), { q: "harbour", parts, limit: 50 });
      expect(run.seen, parts).toEqual(bare);
      expect(out.total, parts).toBe(plain.total);
      if (parts === "estimate") expect(out.totalExact, "a cut estimate").toBe(false);
      if (parts === "summary") expect(out.total).toBe(N);
      if (parts === "page") expect(run.turns, "a page never takes a turn").toBe(0);
      else expect(run.turns).toBeGreaterThanOrEqual(2);
    }
  });

  it("superseded at the first turn: the estimate and the summary send nothing after BEGIN", async () => {
    const svc = searchFor("local");
    for (const parts of ["estimate", "summary"] as const) {
      const { run, hook } = hooked(1);
      await refused(svc.search(ctx(run.seen, hook), { q: "harbour", parts, limit: 50 }));
      const begin = run.seen.indexOf("BEGIN");
      expect(begin, `${parts} opened its transaction`).toBeGreaterThanOrEqual(0);
      expect(run.seen.slice(begin + 1), `${parts} statements after BEGIN`).toEqual([]);
    }
  });

  it("superseded at the second turn: no typo tier, no indexing read", async () => {
    const svc = searchFor("local");
    // The typo tier runs only for a word with no exact match.
    for (const [q, parts] of [["harbuor", "estimate"], ["harbuor", "summary"]] as const) {
      const control = hooked(null);
      await svc.search(ctx(control.run.seen, control.hook), { q, parts, limit: 50 });
      const { run, hook } = hooked(2);
      await refused(svc.search(ctx(run.seen, hook), { q, parts, limit: 50 }));
      expect(run.cutAt).not.toBeNull();
      expect(run.seen.slice(run.cutAt!), `${q} ${parts}: statements after the second turn`).toEqual([]);
      expect(control.run.seen.length, `${q} ${parts}: the control went further`).toBeGreaterThan(run.cutAt!);
    }
  });

  it("a cut estimate asks the planner nothing: its second turn is its last, and nothing follows it", async () => {
    const svc = searchFor("local");
    const { run, hook } = hooked(null);
    const out = await svc.search(ctx(run.seen, hook), { q: "harbour", parts: "estimate", limit: 50 });
    expect(out.totalExact).toBe(false);
    expect(run.turns).toBe(2);
    expect(run.seen.some((s) => /^\s*explain/i.test(s)), "no estimate reads the planner").toBe(false);
    const cut = hooked(2);
    await refused(svc.search(ctx(cut.run.seen, cut.hook), { q: "harbour", parts: "estimate", limit: 50 }));
    expect(cut.run.seen.slice(cut.run.cutAt!)).toEqual([]);
    expect(cut.run.seen).toEqual(run.seen);
  });

  it("a page only checks: superseded on arrival it sends nothing, otherwise it takes no turn", async () => {
    const svc = searchFor("local");
    const pre = hooked(null, true);
    await refused(svc.search(ctx(pre.run.seen, pre.hook), { q: "harbour", parts: "page", limit: 50 }));
    expect(pre.run.seen).toEqual([]);
    const live = hooked(1);
    const page = await svc.search(ctx(live.run.seen, live.hook), { q: "harbour", parts: "page", limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(live.run.turns).toBe(0);
    expect(live.run.checks).toBeGreaterThanOrEqual(2);
  });
});
