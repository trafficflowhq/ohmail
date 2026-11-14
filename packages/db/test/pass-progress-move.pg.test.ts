import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { NOTHING_OPENS, runMigrations } from "../src/admin.js";
import { brandDialect } from "../src/dialect/index.js";
import { PASS_NAMES, accountPass, mailboxPass, markPassDone, readPassProgress, type Tx } from "../src/index.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import { makeStoreAtOldHeads, plantAccount, plantPassMarks, type MovedPassRow } from "./_store-at-old-heads.js";

/**
 * MAIL 0203 MOVES THE FOURTEEN MARKS INTO ROWS, VALUE BY VALUE, on real Postgres: a store that
 * stood at 1.0.11 with every mark set on one account, a walk stopped part way on a second and
 * nothing on a third, migrated on. Each row holds what its columns held, under a name the door
 * knows; the account with no mark has no row; the columns are gone.
 */
const PG_UP = await realPgAvailable();
const moved = throwawayDb("pass_progress_move");

describe.skipIf(!PG_UP)("a store that stood at 1.0.11 with its passes' marks in columns", () => {
  let sql: ReturnType<typeof postgres>;
  let expected: MovedPassRow[] = [];

  beforeAll(async () => {
    await moved.create(async (url) => {
      await makeStoreAtOldHeads(url);
      const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
      try {
        expected = await plantPassMarks(plant);
      } finally {
        await plant.end({ timeout: 5 });
      }
      // A store at 1.0.11's heads is moved by the transition; this one holds nothing sealed.
      await runMigrations(url, { transition: { kind: "server", openSealed: NOTHING_OPENS } });
    });
    sql = postgres(moved.url, { max: 4, onnotice: () => { /* quiet */ } });
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await moved.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("holds every mark as a row, value by value, and no row for an account that had none", async () => {
    const rows = await sql<MovedPassRow[]>`select account_id, job, subject_id, requested_at, started_at, done_at, cursor
      from pass_progress order by account_id, job`;
    expect(rows.map((r) => ({ ...r }))).toEqual(expected);
  });

  it("wrote them under the door's names, all nine", async () => {
    const written = (await sql<{ job: string }[]>`select distinct job from pass_progress order by 1`).map((r) => r.job);
    expect(written).toHaveLength(9);
    expect([...PASS_NAMES].sort()).toEqual(expect.arrayContaining(written));
  });

  it("is read through the door as the pass left it", async () => {
    const db = brandDialect(drizzle(sql), "pg") as unknown as Tx;
    const stopped = expected.find((r) => r.job === "sensitive_rescreen" && r.done_at === null)!;
    expect(await readPassProgress(db, mailboxPass("sensitive_rescreen", stopped.account_id, stopped.subject_id)))
      .toEqual({ requestedAt: null, startedAt: stopped.started_at, doneAt: null, cursor: stopped.cursor });
    const tidy = expected.find((r) => r.job === "ohbox_tidy" && r.done_at !== null)!;
    expect(await readPassProgress(db, accountPass("ohbox_tidy", tidy.account_id)))
      .toEqual({ requestedAt: tidy.requested_at, startedAt: null, doneAt: tidy.done_at, cursor: tidy.cursor });
  });

  it("a mailbox's removal waits for a mark being written, and then takes it", async () => {
    // The table has no key into `mailboxes`. What orders a pass's write against a removal is the
    // write's own read of the mailbox's row FOR SHARE: the removal's first write to that row
    // queues behind it, and deletes the pass's rows afterwards.
    const { accountId, mailboxId } = await plantAccount(sql, randomUUID());
    const db = brandDialect(drizzle(sql), "pg") as unknown as Tx;
    let written!: () => void;
    let release!: () => void;
    const marked = new Promise<void>((r) => { written = r; });
    const held = new Promise<void>((r) => { release = r; });
    const pass = (db as unknown as { transaction: (f: (t: Tx) => Promise<void>) => Promise<void> }).transaction(async (t) => {
      expect(await markPassDone(t, mailboxPass("kickstart", accountId, mailboxId), new Date())).toBe(true);
      written();
      await held;
    });
    await marked;
    const removal = sql.begin(async (tx) => {
      await tx`update mailboxes set erased_at = now() where id = ${mailboxId}`;
      await tx`delete from pass_progress where account_id = ${accountId} and subject_id = ${mailboxId}`;
    });
    const first = await Promise.race([
      removal.then(() => "the removal"), new Promise<string>((r) => setTimeout(() => r("nothing yet"), 400)),
    ]);
    expect(first, "the removal did not wait for the pass's write").toBe("nothing yet");
    release();
    await Promise.all([pass, removal]);
    expect(await sql`select 1 from pass_progress where subject_id = ${mailboxId}`).toHaveLength(0);
    // And a pass that comes after the removal writes nothing.
    expect(await markPassDone(db, mailboxPass("kickstart", accountId, mailboxId), new Date())).toBe(false);
  });

  it("left none of the fourteen columns", async () => {
    const left = await sql<{ c: string }[]>`select table_name || '.' || column_name as c from information_schema.columns
      where table_schema = 'public' and table_name in ('mailboxes', 'account_settings')
        and (column_name like 'sensitive_rescreen%' or column_name like 'ohbox_tidy%' or column_name like 'html_words_backfill%'
          or column_name in ('kickstart_at', 'sensitive_fp_backfill_at', 'legacy_news_clean_at', 'gate_release_done_at',
                             'search_index_built_at', 'list_addresses_scanned_at'))`;
    expect(left.map((r) => r.c)).toEqual([]);
  });
});
