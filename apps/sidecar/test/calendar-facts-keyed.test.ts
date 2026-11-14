import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { attachments, invitationWithoutEventWhere, itipReplyHeaderWhere, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE CALENDAR FACTS ASK THE ATTACHMENTS INDEX BY ITS LEAD. Every materialized row (each search
 * and list page) asks both facts, and `attachments_account_message_idx` is (account_id,
 * message_id): asked by the message alone it was a scan of the whole index per row (PERF-026: 19
 * of a search page's 43 ms on the rig's store). Read off the desktop store's own plan, with the
 * unkeyed shape beside it as the control that the reading can tell the two apart.
 */

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Node = Record<string, unknown> & { Plans?: Node[] };
/** The Index Cond of every scan on the attachments index in one plan. */
function attachmentConds(plan: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n["Index Name"] === "attachments_account_message_idx") out.push(String(n["Index Cond"] ?? ""));
    for (const k of n.Plans ?? []) walk(k);
  };
  walk(plan);
  return out;
}

describe("the calendar facts' attachments lookups", () => {
  it("are keyed by account and message on the attachments index, as the unkeyed form is not", async () => {
    const dir = await freshDataDir("ohmail-calkeyed-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    const db = h.db;
    const accountId = randomUUID(), mailboxId = randomUUID();
    const at = new Date("2026-10-08T20:00:00.000Z");
    await db.insert(mailboxes).values({ id: mailboxId, accountId, provider: "imap", address: "me@example.test", status: "connected", createdAt: at });
    for (let i = 0; i < 120; i += 1) {
      const id = randomUUID();
      await db.insert(messages).values({ id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "", fromAddress: "a@example.test", date: at, createdAt: at, updatedAt: at });
      await db.insert(messageBodies).values({ messageId: id, accountId, text: "", headers: {} });
      await db.insert(attachments).values({ accountId, messageId: id, contentType: i % 3 === 0 ? "text/calendar; method=REPLY" : "application/pdf", sizeBytes: 1, createdAt: at });
    }
    const client = (db as unknown as { $client: PGlite }).$client;
    await client.exec("analyze attachments; analyze messages;");
    const d = dialect(db);
    const row = { id: sql`m.id`, accountId: sql`m.account_id` };
    const shipped = sql`select ${invitationWithoutEventWhere(d, row)} as inv, ${itipReplyHeaderWhere(d, row)} as itip
      from ${messages} m order by m.id limit 50`;
    const unkeyed = sql`select exists (select 1 from ${attachments} a where a.message_id = m.id) as any_part
      from ${messages} m order by m.id limit 50`;
    const planOf = async (q: ReturnType<typeof sql>): Promise<Node> => db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('enable_seqscan', 'off', true)`);
      const r = (await tx.execute(sql`explain (format json) ${q}`)) as unknown as { rows: Record<string, unknown>[] };
      const v = Object.values(r.rows[0]!)[0];
      return ((typeof v === "string" ? JSON.parse(v) : v) as { Plan: Node }[])[0]!.Plan;
    });

    const control = attachmentConds(await planOf(unkeyed));
    expect(control.length, "the control reached no attachments index scan, so the reading below says nothing").toBeGreaterThan(0);
    expect(control.every((c) => !c.includes("account_id")), "the unkeyed control already reads as keyed").toBe(true);

    const conds = attachmentConds(await planOf(shipped));
    expect(conds.length, "the shipped facts never reached the attachments index").toBeGreaterThan(0);
    for (const c of conds) {
      expect(c, "an attachments lookup scans the index without its lead column").toContain("account_id");
      expect(c).toContain("message_id");
    }
    const answers = (await db.execute(shipped)) as unknown as { rows: { itip: boolean }[] };
    expect(answers.rows.filter((r) => r.itip).length, "no row read the stored REPLY parts").toBeGreaterThan(0);
  });
});
