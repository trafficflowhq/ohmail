import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";

/**
 * MAIL 0166 ON PGlite, from a store without its seven columns: each account's count of letters emptied
 * for space comes from the letters that carry the marker, an account with none keeps zero, an account
 * with no counter row gets none, the two dates and the rest stay NULL, the letters withheld on arrival
 * before the release are not made up (zero), and a second application changes nothing. PGlite has no
 * staff role, so the guarded grant does nothing there and fails nothing.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const STATEMENTS = read("../../db-mail/drizzle/0166_account_storage_facts.sql").split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const rows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

describe("mail 0166 on Postgres (PGlite), from 0165", () => {
  it("counts each account's letters emptied for space, leaves the rest unrecorded, and replays", async () => {
    const db = await makeTestDb();
    const run = async (s: string) => rows<Record<string, unknown>>(await db.execute(sql.raw(s)));
    // Back to 0165: the CHECK and the seven columns gone.
    await run(`alter table account_storage drop constraint if exists account_storage_husked_nonneg`);
    for (const c of ["recounted_at", "recount_drift", "husked_for_space", "first_husked_at", "last_husked_at", "kept_from", "withheld_on_arrival"]) {
      await run(`alter table account_storage drop column ${c}`);
    }
    /** An account with `kept` letters holding text and `emptied` letters emptied for space. */
    const account = async (kept: number, emptied: number, counter: boolean): Promise<string> => {
      const a = randomUUID(); const mb = randomUUID();
      await run(`insert into accounts (id, name) values ('${a}', 'm0166')`);
      await run(`insert into mailboxes (id, account_id, provider, address) values ('${mb}', '${a}', 'imap', '${a}@example.test')`);
      for (let i = 0; i < kept + emptied; i++) {
        const m = randomUUID();
        await run(`insert into messages (id, account_id, mailbox_id, dedup_key, body_hash) values ('${m}', '${a}', '${mb}', 'k${i}', 'h${i}')`);
        await run(i < emptied
          ? `insert into message_bodies (message_id, text, withheld_reason) values ('${m}', '', 'storage_cap')`
          : `insert into message_bodies (message_id, text) values ('${m}', repeat('z', 1000))`);
      }
      // Another reason a letter has no text is not space: it must not be counted.
      const junk = randomUUID();
      await run(`insert into messages (id, account_id, mailbox_id, dedup_key, body_hash) values ('${junk}', '${a}', '${mb}', 'j', 'j')`);
      await run(`insert into message_bodies (message_id, text, withheld_reason) values ('${junk}', '', 'junk_filed')`);
      if (counter) await run(`insert into account_storage (account_id, bytes) values ('${a}', ${kept * 1000})`);
      return a;
    };
    const emptied = await account(2, 3, true);
    const none = await account(4, 0, true);
    const rowless = await account(1, 2, false);
    const facts = async (a: string) => run(`select bytes, husked_for_space, first_husked_at, last_husked_at, kept_from,
      recounted_at, recount_drift, withheld_on_arrival from account_storage where account_id = '${a}'`);
    const unrecorded = {
      first_husked_at: null, last_husked_at: null, kept_from: null, recounted_at: null, recount_drift: null, withheld_on_arrival: 0,
    };

    for (let pass = 0; pass < 2; pass++) {
      for (const s of STATEMENTS) await run(s);
      expect((await facts(emptied)).map((r) => ({ ...r, bytes: Number(r.bytes) })), `pass ${pass}`)
        .toEqual([{ bytes: 2_000, husked_for_space: 3, ...unrecorded }]);
      expect((await facts(none)).map((r) => r.husked_for_space), `pass ${pass}`).toEqual([0]);
      expect(await facts(rowless), "the backfill made a counter row").toEqual([]);
    }
    // The floor the clamped decrement relies on.
    await expect(run(`update account_storage set husked_for_space = -1 where account_id = '${emptied}'`))
      .rejects.toThrow(/account_storage_husked_nonneg/);
  }, 60_000);
});
