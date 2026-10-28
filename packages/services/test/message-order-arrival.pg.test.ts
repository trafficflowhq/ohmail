import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { messageService, syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";

/**
 * THE ARRIVAL ORDER'S DEEP PAGE IS ONE INDEX RANGE, ON REAL POSTGRES (MSG-ORDER-CURSOR-IS-NOT-INDEX-
 * BOUNDED). The header-date keyset's `OR date IS NULL` arm walked a deep page from the top of the
 * account and threw everything above the cursor away as a filter. The arrival key is non-null, so
 * its keyset is a row comparison the btree takes as its start. Planned from the REAL builders —
 * `MessageService.list` (a view and History) and the snapshot walk — through drizzle's own
 * statements, captured by its logger and EXPLAINed with their own parameters, never a hand-spelled
 * copy: a query and a copy of it drift, and a pin on the copy measures the copy.
 */
const URL = pgTestUrl(import.meta.url);
const PG_UP = await realPgAvailable(URL);
const client = postgres(URL, { max: 3, onnotice: () => {} });
const logged: Array<{ query: string; params: unknown[] }> = [];
const db = brandDialect(drizzle(client, {
  schema, logger: { logQuery: (query, params) => { logged.push({ query, params }); } },
}), "pg");

const ACCOUNT = randomUUID();
const GROWN = 20_000;
const NOW = new Date("2026-09-29T08:00:00.000Z");
const ctx = (): ServiceContext => ({ db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "arrival-plan" });

/** The one statement a read issued that walks the arrival order — the page's own keyset select. */
function pageStatement(from: number): { query: string; params: unknown[] } {
  const hits = logged.slice(from).filter((l) => /"messages"\."arrived_at"/.test(l.query) && /order by/i.test(l.query) && /limit/i.test(l.query));
  expect(hits, "the read issued no arrival-ordered page statement").toHaveLength(1);
  return hits[0]!;
}

async function planOf(s: { query: string; params: unknown[] }): Promise<string> {
  const rows = await client.unsafe(`explain (analyze, costs off, timing off, summary off) ${s.query}`, s.params as never[]);
  return rows.map((r) => Object.values(r)[0] as string).join("\n");
}

/** The index node's own lines: its header and the detail lines under it, up to the next node. */
function indexNode(plan: string): string {
  const lines = plan.split("\n");
  const at = lines.findIndex((l) => l.includes("messages_account_arrival_key_idx"));
  expect(at, `the page did not walk the arrival index:\n${plan}`).toBeGreaterThanOrEqual(0);
  const depth = lines[at]!.search(/\S/);
  const out = [lines[at]!];
  for (const l of lines.slice(at + 1)) {
    if (l.includes("->") || l.search(/\S/) <= depth) break;
    out.push(l);
  }
  return out.join("\n");
}

describe.skipIf(!PG_UP)("the arrival order's deep page is one range of its index", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: "arrival@example.test" }).returning();
    await client.unsafe(`
      insert into messages (account_id, mailbox_id, message_id_header, body_hash, dedup_key, subject, from_address, date, arrived_at, native_locator, snippet, unread)
      select $1::uuid, $2::uuid, 'mid:' || g, md5(g::text), 'arrival:' || g, 's', 'x@example.test',
        case when g % 97 = 0 then null when g % 13 = 0 then timestamptz '2020-01-01' + (g || ' minutes')::interval
             else timestamptz '2026-09-01' - (g || ' minutes')::interval end,
        case when g % 3 = 0 then null else timestamptz '2026-09-01' - (g || ' minutes')::interval end,
        jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g), 'hi', true
      from generate_series(1, ${GROWN}) g`, [ACCOUNT, mb!.id]);
    await client.unsafe(`
      insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
      select id, 'INBOX', 'INBOX', 'us', 'reconciled', false from messages where account_id = $1::uuid`, [ACCOUNT]);
    await client.unsafe("analyze messages");
    await client.unsafe("analyze folder_state");
  }, 120_000);
  afterAll(async () => {
    await client.unsafe("delete from folder_state where message_id in (select id from messages where account_id = $1::uuid)", [ACCOUNT]);
    await client.unsafe("delete from messages where account_id = $1::uuid", [ACCOUNT]);
    await client.unsafe("delete from mailboxes where account_id = $1::uuid", [ACCOUNT]);
    await client.end({ timeout: 5 });
  });

  /** Walk `pages` pages of `limit`, then plan the NEXT page's statement from its real cursor. */
  async function deepPlan(view: "all" | "imbox", pages: number, limit: number): Promise<string> {
    let cursor: string | undefined;
    for (let i = 0; i < pages; i++) {
      const p = await messageService.list(ctx(), { view, limit, ...(cursor ? { cursor } : {}) });
      cursor = p.nextCursor!;
    }
    const from = logged.length;
    await messageService.list(ctx(), { view, limit, cursor });
    return planOf(pageStatement(from));
  }

  it("History (view=all) at depth 10 000: the cursor is the Index Cond, nothing filtered away", async () => {
    const node = indexNode(await deepPlan("all", 100, 100));
    expect(node).toMatch(/Index Cond: .*ROW\(/);
    expect(node, "the deep page threw rows away instead of starting at the cursor").not.toMatch(/Rows Removed by Filter/);
  });

  it("a view list (imbox) at depth 10 000: the same range under the folder join", async () => {
    const node = indexNode(await deepPlan("imbox", 100, 100));
    expect(node).toMatch(/Index Cond: .*ROW\(/);
    expect(node).not.toMatch(/Rows Removed by Filter/);
  });

  it("the snapshot window's deep page: the same range", async () => {
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const p = await syncService.getSnapshot(ctx(), { limit: 200, ...(cursor ? { cursor } : {}) });
      cursor = p.nextCursor!;
    }
    const from = logged.length;
    await syncService.getSnapshot(ctx(), { limit: 200, cursor });
    const node = indexNode(await planOf(pageStatement(from)));
    expect(node).toMatch(/Index Cond: .*ROW\(/);
    expect(node).not.toMatch(/Rows Removed by Filter/);
  });

  /* THE HISTORY RAIL: its per-month probes compare on
     the INDEXED key, so each is a range of the arrival index — in UTC and in the reader's zone. A
     `case` around the key matches no index and scanned the account per month. */
  it.each([["UTC", undefined], ["Europe/Zurich", "Europe/Zurich"]] as const)(
    "the History rail in %s probes each month through the arrival index",
    async (_zone, zone) => {
      const from = logged.length;
      await messageService.timeline(ctx(), zone ? { zone } : {});
      const stmts = logged.slice(from).filter((l) => /from messages n/.test(l.query));
      expect(stmts.length, "the rail issued no per-month probe").toBeGreaterThan(0);
      for (const st of stmts) {
        const plan = await planOf(st);
        expect(plan, `a rail probe does not use the arrival index:\n${plan}`).toContain("messages_account_arrival_key_idx");
      }
    },
  );

  it("CONTROL: without the index the same statement is a sort — the pin can go red", async () => {
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) cursor = (await messageService.list(ctx(), { view: "all", limit: 100, ...(cursor ? { cursor } : {}) })).nextCursor!;
    const from = logged.length;
    await messageService.list(ctx(), { view: "all", limit: 100, cursor });
    const stmt = pageStatement(from);
    // Dropped inside a transaction that is always rolled back: the plan leaves by the thrown value.
    class RolledBack extends Error { constructor(readonly plan: string) { super("rolled back on purpose"); } }
    const plan = await client.begin(async (tx) => {
      await tx.unsafe('drop index "messages_account_arrival_key_idx"');
      const rows = await tx.unsafe(`explain (costs off) ${stmt.query}`, stmt.params as never[]);
      throw new RolledBack(rows.map((r) => Object.values(r)[0] as string).join("\n"));
    }).then(() => "", (e: unknown) => { if (e instanceof RolledBack) return e.plan; throw e; });
    expect(plan, "the control read no plan").not.toBe("");
    expect(plan).not.toContain("messages_account_arrival_key_idx");
    expect(plan, "without the index the page is not a sort").toMatch(/Sort Key/);
  });
});
