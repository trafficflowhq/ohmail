import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * A poll's filing aggregate reads the caller's own rows, however much mail another account on the
 * same store holds. Each read of `messages` and `folder_state` in it is bounded on the first column
 * of the index it uses (the caller's account, the message); a read with no such bound walks every
 * account's rows, on every poll.
 *
 * Joined to the listed mailboxes alone, the planner sized each of them as an average mailbox of
 * the whole table: beside one large mailbox of another account it read all of `folder_state` and
 * walked the account index of `messages` by its second column.
 *
 * Postgres's planner, so PGlite only. Planned with sequential scans priced out, as PGlite ships,
 * so a whole-table read shows as an index scan with no bound. Each table stays under the 30,000
 * rows ANALYZE samples, so the statistics and the plan are the same on every run.
 */

interface Client {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  exec: (text: string) => Promise<unknown>;
}
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}
interface Read { table: string; node: string; index?: string; cond?: string }

const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const MINE = id("100");
const THEIRS = id("200");

/** `n` messages in `mailbox`, each with a filing the server has applied. */
async function filed(c: Client, account: string, mailbox: string, n: number): Promise<void> {
  await c.query(`insert into messages (account_id, mailbox_id, dedup_key, body_hash)
    select $1, $2, 'mid:<' || $3 || '-' || g || '@example.test>', 'plan-' || g from generate_series(1, $4::int) g`,
  [account, mailbox, mailbox.slice(-3), n]);
  await c.query(`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
    select id, 'Archive', 'Archive', 'us', 'reconciled' from messages where mailbox_id = $1`, [mailbox]);
}

async function planOf(c: Client, text: string, params: unknown[]): Promise<PlanNode> {
  await c.exec("set enable_seqscan = off");
  try {
    const { rows } = await c.query(`explain (format json) ${text}`, params);
    const v = Object.values(rows[0]!)[0];
    return ((typeof v === "string" ? JSON.parse(v) : v) as Array<{ Plan: PlanNode }>)[0]!.Plan;
  } finally {
    await c.exec("reset enable_seqscan");
  }
}

/** Each read of `tables` in a plan (by default `messages` and `folder_state`), subplans included. */
function readsOf(node: PlanNode, table?: string, out: Read[] = [], tables: readonly string[] = ["messages", "folder_state"]): Read[] {
  // A bitmap index scan names its index; the bitmap heap scan above it names the table.
  const t = node["Relation Name"] ?? table;
  if (t !== undefined && tables.includes(t) && (node["Node Type"] === "Seq Scan" || node["Index Name"])) {
    out.push({ table: t, node: node["Node Type"], index: node["Index Name"], cond: node["Index Cond"] });
  }
  const bitmap = /^Bitmap( Heap Scan|And|Or)$/.test(node["Node Type"]);
  for (const child of node.Plans ?? []) readsOf(child, bitmap ? t : undefined, out, tables);
  return out;
}

/** The reads not bounded on their index's first column; a sequential scan never is. */
async function unbounded(c: Client, reads: Read[]): Promise<string[]> {
  const { rows } = await c.query(`select ic.relname as index, a.attname as lead from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]`);
  const lead = new Map(rows.map((r) => [r.index as string, r.lead as string | null]));
  return reads
    .filter((r) => {
      const first = r.index ? lead.get(r.index) : null;
      return !(first && r.cond && new RegExp(`\\(${first} [=<>]`).test(r.cond));
    })
    .map((r) => `${r.table}: ${r.node}${r.index ? ` using ${r.index}` : ""}, ${r.cond ?? "no index condition"}`);
}

describe("the poll's filing aggregate beside a larger account", () => {
  it("reads this account's messages and filings by index, never every account's", async () => {
    const db = await makeTestDb();
    const c = (db as unknown as { $client: Client }).$client;
    await db.insert(accounts).values([{ id: MINE, name: "plan-mine" }, { id: THEIRS, name: "plan-theirs" }]);
    await db.insert(mailboxes).values({ id: id("201"), accountId: THEIRS, provider: "imap", address: "theirs@example.test" });
    await filed(c, THEIRS, id("201"), 20_000);
    const mine = [id("101"), id("102"), id("103")];
    for (const mb of mine) {
      await db.insert(mailboxes).values({ id: mb, accountId: MINE, provider: "imap", address: `${mb.slice(-3)}@example.test` });
      await filed(c, MINE, mb, 100);
    }
    await c.exec("analyze mailboxes, messages, folder_state");

    const svc = makeMailboxService({ installId: "install-here", lastOrganizerCycleAt: async () => null });
    const ctx: ServiceContext = {
      db, accountId: MINE, userId: null, now: () => new Date("2026-10-21T10:00:00.000Z"), requestId: "r",
    };
    const sent: Array<{ text: string; params: unknown[] }> = [];
    const query = c.query;
    c.query = (...a) => {
      sent.push({ text: a[0], params: a[1] ?? [] });
      return query.apply(c, a);
    };
    try {
      expect((await svc.list(ctx)).map((m) => m.id)).toEqual(mine);
    } finally {
      c.query = query;
    }
    const filing = sent.filter((s) => s.text.includes('"folder_state"'));
    expect(filing, "the list's statements that read folder_state").toHaveLength(1);

    const reads = readsOf(await planOf(c, filing[0]!.text, filing[0]!.params));
    expect(new Set(reads.map((r) => r.table))).toEqual(new Set(["messages", "folder_state"]));
    expect(await unbounded(c, reads), "reads of every account's rows on each poll").toEqual([]);

    // The list read before it: the caller's mailboxes by the account index (mail 0160), where it
    // walked every mailbox of the store through `mailboxes_id_account_uq` with no condition.
    const listed = readsOf(await planOf(c, sent[0]!.text, sent[0]!.params), undefined, [], ["mailboxes"]);
    expect(listed.map((r) => r.index)).toEqual(["mailboxes_account_idx"]);
    expect(await unbounded(c, listed), "the list read walks every mailbox").toEqual([]);

    // Control: a whole-table read is told apart under the same planning.
    const whole = readsOf(await planOf(c, "select count(*) from folder_state", []));
    expect(await unbounded(c, whole)).toHaveLength(1);
  }, 60_000);
});
