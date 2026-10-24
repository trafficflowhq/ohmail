import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";

/**
 * MAIL 0165 ON PGlite: an account with an erased mailbox gets its counter recounted to the bodies it
 * really holds; an account without one keeps its counter as it was, drift included; an account with
 * no counter row gets none; a second application changes nothing.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const STATEMENTS = read("../../db-mail/drizzle/0165_account_storage_recount.sql").split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

describe("mail 0165 on Postgres (PGlite)", () => {
  it("recounts only the accounts with an erased mailbox, and replays", async () => {
    const db = await makeTestDb();
    const run = async (s: string) => rows<Record<string, unknown>>(await db.execute(sql.raw(s)));
    /** An account with `bodies` letters of 1,000 bytes, a counter at `counter` (null: no row). */
    const account = async (bodies: number, counter: number | null, erased: boolean): Promise<string> => {
      const a = randomUUID(); const kept = randomUUID(); const gone = randomUUID();
      await run(`insert into accounts (id, name) values ('${a}', 'm0165')`);
      await run(`insert into mailboxes (id, account_id, provider, address) values ('${kept}', '${a}', 'imap', 'k-${a}@example.test')`);
      await run(`insert into mailboxes (id, account_id, provider, address, status, erased_at) values
        ('${gone}', '${a}', 'imap', 'g-${a}@example.test', 'disabled', ${erased ? "now()" : "null"})`);
      for (let i = 0; i < bodies; i++) {
        const m = randomUUID();
        await run(`insert into messages (id, account_id, mailbox_id, dedup_key, body_hash) values ('${m}', '${a}', '${kept}', 'k${i}', 'h${i}')`);
        await run(`insert into message_bodies (message_id, text) values ('${m}', repeat('z', 1000))`);
      }
      if (counter !== null) await run(`insert into account_storage (account_id, bytes) values ('${a}', ${counter})`);
      return a;
    };
    const inflated = await account(3, 9_000, true);
    const drifted = await account(2, 7_777, false);
    const rowless = await account(1, null, true);
    const counter = async (a: string) => (await run(`select bytes from account_storage where account_id = '${a}'`))
      .map((r) => Number(r.bytes));

    expect(STATEMENTS.length).toBe(2);
    for (let pass = 0; pass < 2; pass++) {
      // One transaction, as the migrator replays a pending set: the table lock needs one.
      await db.transaction(async (tx) => { for (const s of STATEMENTS) await tx.execute(sql.raw(s)); });
      expect(await counter(inflated), `pass ${pass}`).toEqual([3_000]);
      expect(await counter(drifted), "an account without an erased mailbox was touched").toEqual([7_777]);
      expect(await counter(rowless)).toEqual([]);
    }
  }, 60_000);
});
