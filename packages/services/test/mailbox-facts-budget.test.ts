import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  BUDGET, EXPECTED_FACTS, costOf, ctxOf, factsOf, seed74k, sqliteFilingFaults, svc, timed, withoutAccountBound,
  type PlanNode,
} from "./helpers/mailbox-facts-74k.js";
import { outstandingDrift } from "./helpers/mailbox-facts-seed.js";

/**
 * GET /mailboxes AT 74k: the filing facts read the caller's outstanding filings, not their mail.
 * The shell polls the route every 30 s in every open window, and the filing statement visited
 * every message and filing of each mailbox (471,000 `folder_state` rows and 477,428 buffers on the
 * desktop store at this size). Mail 0159 keys a partial index on `folder_state` by the message's
 * account, and the statement reads through it. On both stores of this run (PGlite, SQLite); the
 * real-Postgres twin is `mailbox-facts-budget.pg.test.ts`. Times are printed, never asserted.
 */

interface Client {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  exec: (text: string) => Promise<unknown>;
}
interface Conn { prepare: (text: string) => { all: (...p: unknown[]) => Array<Record<string, unknown>> } }

describe("GET /mailboxes at 74k", () => {
  it("reads the caller's outstanding filings alone, in five statements", async () => {
    const db = await makeTestDb();
    const sqlite = dialect(db).name === "sqlite";
    await seed74k(db, sqlite);
    const ctx = ctxOf(db);

    if (sqlite) {
      // Every statement the list prepares, on the connection that prepared it.
      const node = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } } };
      const proto = node.DatabaseSync.prototype;
      const prepare = proto.prepare;
      const sent: Array<{ conn: Conn; text: string }> = [];
      proto.prepare = function (this: Conn, ...a: unknown[]) { sent.push({ conn: this, text: String(a[0]) }); return prepare.apply(this, a); };
      let rows;
      try { rows = await svc.list(ctx); } finally { proto.prepare = prepare; }
      expect(factsOf(rows)).toEqual(EXPECTED_FACTS);
      expect(sent, "the list read and four facts").toHaveLength(5);
      const plan = (text: string) => sent[0]!.conn.prepare(`explain query plan ${text}`).all().map((r) => String(r.detail));

      const filing = sent.find((s) => s.text.includes('"folder_state"'))!;
      const filingPlan = plan(filing.text);
      expect(filingPlan.filter((l) => /\bfolder_state\b/.test(l)), "the filing statement's reads of folder_state").toHaveLength(3);
      expect(sqliteFilingFaults(filingPlan), filingPlan.join("\n")).toEqual([]);
      // Control: without the caller's bound the same check finds the reads of every account's filings.
      const loose = withoutAccountBound(filing.text, true);
      expect(loose.replaced).toBe(3);
      expect(sqliteFilingFaults(plan(loose.text)).length).toBeGreaterThan(0);

      // The list read itself: the caller's mailboxes by the account index, never every mailbox.
      const listPlan = plan(sent[0]!.text);
      expect(listPlan, listPlan.join("\n")).toEqual(["SEARCH mailboxes USING INDEX mailboxes_account_idx (account_id=?)"]);
    } else {
      const c = (db as unknown as { $client: Client }).$client;
      const sent: Array<{ text: string; params: unknown[] }> = [];
      const query = c.query;
      c.query = (...a) => { sent.push({ text: a[0], params: a[1] ?? [] }); return query.apply(c, a); };
      let rows;
      try { rows = await svc.list(ctx); } finally { c.query = query; }
      expect(factsOf(rows)).toEqual(EXPECTED_FACTS);
      expect(sent, "the list read and four facts").toHaveLength(5);
      const filing = sent.find((s) => s.text.includes('"folder_state"'))!;
      const cost = async (text: string) => {
        const { rows: r } = await c.query(`explain (analyze, buffers, format json) ${text}`, filing.params);
        const v = Object.values(r[0]!)[0];
        return costOf(((typeof v === "string" ? JSON.parse(v) : v) as Array<{ Plan: PlanNode }>)[0]!.Plan);
      };
      // As PGlite ships (sequential scans priced out), and with them priced in as on a server.
      for (const mode of ["default", "on"] as const) {
        if (mode === "on") await c.exec("set enable_seqscan = on");
        try {
          const got = await cost(filing.text);
          const why = `${mode}: ${JSON.stringify(got, null, 1)}`;
          expect(got.buffers, why).toBeLessThanOrEqual(BUDGET.buffers);
          expect(got.folderState, why).toBeLessThanOrEqual(BUDGET.folderState);
          expect(got.messages, why).toBeLessThanOrEqual(BUDGET.messages);
          // Control: without the caller's bound the same statement reads the neighbour's filings.
          const loose = withoutAccountBound(filing.text, false);
          expect(loose.replaced).toBe(3);
          expect((await cost(loose.text)).folderState, `${mode}: the control`).toBeGreaterThan(BUDGET.folderState);
        } finally {
          if (mode === "on") await c.exec("reset enable_seqscan");
        }
      }
    }
    // Every outstanding filing of the seed carries its message's account.
    expect(await outstandingDrift(db)).toBe(0);
    console.log(`mailbox-facts-budget ${dialect(db).name}: list() ${JSON.stringify(await timed(() => svc.list(ctx)))} ms`);
  }, 240_000);
});
