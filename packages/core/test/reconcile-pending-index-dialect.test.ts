import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { flagState, folderState, mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE RECONCILE QUEUES READ THEIR OWN ACCOUNT'S PENDING ROWS — on both stores. Every cycle asks each
 * mailbox for its due folder and `\Seen` writes, and almost always gets none; without mail 0181's
 * partial indexes each ask read every `folder_state` or `flag_state` row of the store and sorted
 * what passed. The indexes lead with the message's account, which the store keeps on every pending
 * row, so a poll never walks another account's queue, however long it is. The real-Postgres half is
 * `pending-folder-budget.pg.test.ts`.
 */
type Conn = { prepare: (text: string) => { all: (...p: unknown[]) => Array<Record<string, unknown>> } };
type Client = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
interface PlanNode {
  "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; "Actual Rows"?: number;
  "Actual Loops"?: number; "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

const NEIGHBOUR_WAITING = 200;
const ACCOUNT_COLUMN = { folder_state: "account_id", flag_state: "account_id" } as const;

/**
 * Two accounts. Mine waits on five rows: three filings of ours, one the user made in another client
 * and one whose two sides already agree (the queue keeps both shapes). The neighbour's queue is long.
 */
async function seeded() {
  const db = await makeTestDb();
  const ids: Record<string, { mailbox: string; waiting: string[] }> = {};
  for (const name of ["mine", "neighbour"] as const) {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${name}@example.test` }).returning();
    ids[name] = { mailbox: mb!.id, waiting: [] };
    const waiting = name === "mine" ? 5 : NEIGHBOUR_WAITING;
    for (let chunk = 0; chunk < 3; chunk++) {
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: randomUUID(), accountId, mailboxId: mb!.id, dedupKey: `d:${randomUUID()}`, bodyHash: "h",
        fromAddress: "a@example.test", nativeLocator: { folder: "INBOX", ref: `1:${chunk * 200 + i + 1}` },
      }));
      await db.insert(messages).values(rows);
      const pending = (i: number) => chunk === 0 && i < waiting;
      const lastSetBy = (i: number) => (name === "mine" && i === 3 ? "external" : "us");
      const agrees = (i: number) => !pending(i) || (name === "mine" && i === 4);
      await db.insert(folderState).values(rows.map((r, i) => ({
        messageId: r.id, accountId: r.accountId, desiredFolder: "INBOX", observedFolder: agrees(i) ? "INBOX" : "ohmail/Screener",
        lastSetBy: lastSetBy(i), reconcileStatus: pending(i) ? "pending" : "reconciled",
      })));
      await db.insert(flagState).values(rows.map((r, i) => ({
        messageId: r.id, accountId: r.accountId, desiredSeen: true, observedSeen: agrees(i), lastSetBy: lastSetBy(i),
        reconcileStatus: pending(i) ? "pending" : "reconciled",
      })));
      if (chunk === 0) ids[name]!.waiting.push(...rows.filter((_r, i) => pending(i)).map((r) => r.id));
    }
  }
  return { db, ids, repo: new DrizzleRepo(db as never) };
}

/** The one read of `table` in a plan: its index, its condition, and the rows it visited. */
function readOf(node: PlanNode, table: string): { index?: string; cond?: string; visited: number } | undefined {
  if (node["Relation Name"] === table) {
    const visited = ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)
      + (node["Rows Removed by Index Recheck"] ?? 0)) * (node["Actual Loops"] ?? 1);
    // A bitmap heap scan names its index on the bitmap index scan below it.
    const ix = node["Index Name"] ? node : node.Plans?.find((p) => p["Index Name"]);
    return { index: ix?.["Index Name"], cond: ix?.["Index Cond"], visited };
  }
  for (const c of node.Plans ?? []) {
    const r = readOf(c, table);
    if (r) return r;
  }
  return undefined;
}

/** Run `call`, then the plan of the one statement it sent that reads `table`: its lines, and on Postgres its read. */
async function planOf(db: Awaited<ReturnType<typeof makeTestDb>>, table: string, call: () => Promise<unknown>) {
  if (dialect(db).name === "sqlite") {
    const proto = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } } }).DatabaseSync.prototype;
    const prepare = proto.prepare;
    const sent: Array<{ conn: Conn; text: string }> = [];
    proto.prepare = function (this: Conn, ...a: unknown[]) { sent.push({ conn: this, text: String(a[0]) }); return prepare.apply(this, a); };
    try { await call(); } finally { proto.prepare = prepare; }
    const s = sent.find((x) => x.text.includes(`from "${table}"`))!;
    return { lines: s.conn.prepare(`explain query plan ${s.text}`).all().map((r) => String(r.detail)), read: undefined };
  }
  const c = (db as unknown as { $client: Client }).$client;
  const query = c.query;
  const sent: Array<{ text: string; params: unknown[] }> = [];
  c.query = (...a) => { sent.push({ text: a[0], params: a[1] ?? [] }); return query.apply(c, a); };
  try { await call(); } finally { c.query = query; }
  const s = sent.find((x) => x.text.includes(`from "${table}"`))!;
  const { rows } = await c.query(`explain ${s.text}`, s.params);
  const analysed = await c.query(`explain (analyze, format json) ${s.text}`, s.params);
  const v = Object.values(analysed.rows[0]!)[0];
  const top = ((typeof v === "string" ? JSON.parse(v) : v) as Array<{ Plan: PlanNode }>)[0]!.Plan;
  return { lines: rows.map((r) => String(Object.values(r)[0])), read: readOf(top, table) };
}

describe("the reconcile queues ride their pending partial indexes, one account at a time", () => {
  it.each([
    ["folder_state", "listPendingFolderStates"],
    ["flag_state", "listPendingFlagStates"],
  ] as const)("the %s poll reads its own account's pending rows, never every row, every message or every account's queue", async (table, read) => {
    const { db, ids, repo } = await seeded();
    let got: string[] = [];
    const { lines, read: pg } = await planOf(db, table, async () => {
      got = (await repo[read](ids["mine"]!.mailbox, 11)).map((r) => r.messageId);
    });
    const plan = lines.join("\n");
    // Every waiting row of the mailbox, the external one and the agreeing one included.
    expect(got.sort()).toEqual([...ids["mine"]!.waiting].sort());
    expect(plan).toContain(`${table}_pending_queue_idx`);
    // Not the table, nor the table by message (the mailbox's messages first), nor a sort on the device.
    const other = new RegExp(`Seq Scan on ${table}\\b|${table}_message_id_unique|SCAN ${table}\\b|sqlite_autoindex_${table}|TEMP B-TREE`);
    expect(plan, plan).not.toMatch(other);
    const col = ACCOUNT_COLUMN[table];
    if (pg) {
      // Entered at the account, and the neighbour's long queue never visited.
      expect(pg.index, plan).toBe(`${table}_pending_queue_idx`);
      expect(pg.cond ?? "", plan).toMatch(new RegExp(`^\\(${col} = `));
      expect(pg.visited, plan).toBeLessThanOrEqual(ids["mine"]!.waiting.length);
    } else {
      expect(lines, plan).toContain(`SEARCH ${table} USING INDEX ${table}_pending_queue_idx (${col}=?)`);
    }
    // The neighbour's own poll still answers its whole queue.
    expect(await repo[read](ids["neighbour"]!.mailbox, 500)).toHaveLength(NEIGHBOUR_WAITING);
  });
});
