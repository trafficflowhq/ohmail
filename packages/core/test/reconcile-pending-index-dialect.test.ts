import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { flagState, folderState, mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE RECONCILE QUEUES READ THEIR PENDING ROWS, NOT THE WHOLE TABLE — on both stores. Every cycle
 * asks each mailbox for its due folder and `\Seen` writes, and almost always gets none; without
 * mail 0181's partial indexes each ask read every `folder_state` or `flag_state` row of the store
 * and sorted what passed. The real-Postgres half is `pending-folder-budget.pg.test.ts`.
 */
type Conn = { prepare: (text: string) => { all: (...p: unknown[]) => Array<Record<string, unknown>> } };
type Client = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

async function seeded() {
  const db = await makeTestDb();
  const ids: Record<string, string[]> = {};
  for (const name of ["mine", "neighbour"]) {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${name}@example.test` }).returning();
    ids[name] = [mb!.id];
    for (let chunk = 0; chunk < 3; chunk++) {
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: randomUUID(), accountId, mailboxId: mb!.id, dedupKey: `d:${randomUUID()}`, bodyHash: "h",
        fromAddress: "a@example.test", nativeLocator: { folder: "INBOX", ref: `1:${chunk * 200 + i + 1}` },
      }));
      await db.insert(messages).values(rows);
      // Settled rows, but for the first three of the first chunk: those wait for the server.
      const pending = (i: number) => (chunk === 0 && i < 3 ? "pending" : "reconciled");
      await db.insert(folderState).values(rows.map((r, i) => ({
        messageId: r.id, desiredFolder: "INBOX", observedFolder: pending(i) === "pending" ? "ohmail/Screener" : "INBOX",
        lastSetBy: "us", reconcileStatus: pending(i),
      })));
      await db.insert(flagState).values(rows.map((r, i) => ({
        messageId: r.id, desiredSeen: true, observedSeen: pending(i) !== "pending", lastSetBy: "us", reconcileStatus: pending(i),
      })));
      if (chunk === 0) ids[name]!.push(...rows.slice(0, 3).map((r) => r.id));
    }
  }
  return { db, ids, repo: new DrizzleRepo(db as never) };
}

/** Run `call`, then the plan of the one statement it sent that reads `table`. */
async function planOf(db: Awaited<ReturnType<typeof makeTestDb>>, table: string, call: () => Promise<unknown>): Promise<string[]> {
  if (dialect(db).name === "sqlite") {
    const proto = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } } }).DatabaseSync.prototype;
    const prepare = proto.prepare;
    const sent: Array<{ conn: Conn; text: string }> = [];
    proto.prepare = function (this: Conn, ...a: unknown[]) { sent.push({ conn: this, text: String(a[0]) }); return prepare.apply(this, a); };
    try { await call(); } finally { proto.prepare = prepare; }
    const s = sent.find((x) => x.text.includes(`from "${table}"`))!;
    return s.conn.prepare(`explain query plan ${s.text}`).all().map((r) => String(r.detail));
  }
  const c = (db as unknown as { $client: Client }).$client;
  const query = c.query;
  const sent: Array<{ text: string; params: unknown[] }> = [];
  c.query = (...a) => { sent.push({ text: a[0], params: a[1] ?? [] }); return query.apply(c, a); };
  try { await call(); } finally { c.query = query; }
  const s = sent.find((x) => x.text.includes(`from "${table}"`))!;
  const { rows } = await c.query(`explain ${s.text}`, s.params);
  return rows.map((r) => String(Object.values(r)[0]));
}

describe("the reconcile queues ride their pending partial indexes", () => {
  it.each([
    ["folder_state", "listPendingFolderStates"],
    ["flag_state", "listPendingFlagStates"],
  ] as const)("the %s poll reads its pending index, never every row or every message", async (table, read) => {
    const { db, ids, repo } = await seeded();
    let got: string[] = [];
    const plan = (await planOf(db, table, async () => {
      got = (await repo[read](ids["mine"]![0]!, 11)).map((r) => r.messageId);
    })).join("\n");
    expect(got.sort()).toEqual(ids["mine"]!.slice(1).sort());
    expect(plan).toContain(`${table}_pending_queue_idx`);
    // Not the table, nor the table by message (the mailbox's messages first), nor a sort on the device.
    const other = new RegExp(`Seq Scan on ${table}\\b|${table}_message_id_unique|SCAN ${table}\\b(?! USING INDEX ${table}_pending)|sqlite_autoindex_${table}|TEMP B-TREE`);
    expect(plan, plan).not.toMatch(other);
  });
});
