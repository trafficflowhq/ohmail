/* @postpush: alone — it walks a database of its own along the 1.0 road, plants letters there and
 * migrates it on; the build and the retirement take locks a co-tenant's writes would hold. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";
import { brandDialect } from "../src/dialect/index.js";
import { BodyVectorLockTimeout, NOTHING_OPENS, OLD_SEARCH_RETIREMENT, retireOldSearch, runMigrations } from "../src/admin.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import { makeStoreAtOldHeads, plantAccount, plantLetter } from "./_store-at-old-heads.js";

/**
 * THE OLD SEARCH LEAVES A STORE ONLY WHEN NOTHING ON IT IS FOUND BY THE OLD SEARCH ALONE, on real
 * Postgres. Two stores. One stood at 1.0.11 with a letter that had no search document in an
 * account whose index was never stamped built: mail 0200 keeps the whole old search there, and the
 * setup's step retires it later, with 0200's own statements, once that letter is no longer owed.
 * The other is made from empty: 0200 took the old search on the way, and the step has nothing to do.
 */
const PG_UP = await realPgAvailable();
const owing = throwawayDb("old_search_owing");
const fresh = throwawayDb("old_search_fresh");
const quiet = { max: 3, onnotice: () => { /* a migration raises notices */ } };

/** The catalog's reading of the old search on one store. */
async function oldSearchOf(sql: ReturnType<typeof postgres>): Promise<{
  columns: string[]; trigger: string | null; functions: string[]; indexes: string[];
}> {
  const columns = await sql<{ c: string }[]>`select table_name || '.' || column_name as c from information_schema.columns
    where table_schema = 'public' and column_name in ('body_tsv', 'subject_tsv') order by 1`;
  const trigger = await sql<{ f: string }[]>`select p.proname::text as f from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgname = 'message_bodies_body_tsv_tg' and t.tgrelid = 'message_bodies'::regclass`;
  const functions = await sql<{ f: string }[]>`select proname::text as f from pg_proc
    where proname in ('message_bodies_body_tsv_bounded', 'message_bodies_body_tsv_cleared') order by 1`;
  const indexes = await sql<{ i: string }[]>`select indexname::text as i from pg_indexes where schemaname = 'public'
    and indexname in ('message_bodies_body_tsv_idx', 'messages_subject_tsv_idx', 'messages_subject_trgm_idx', 'messages_from_address_trgm_idx')
    order by 1`;
  return { columns: columns.map((r) => r.c), trigger: trigger[0]?.f ?? null, functions: functions.map((r) => r.f), indexes: indexes.map((r) => r.i) };
}

const GONE = { columns: [], trigger: null, functions: [], indexes: [] };

describe.skipIf(!PG_UP)("a store that stood at 1.0.11 with a letter only the old search finds", () => {
  let sql: ReturnType<typeof postgres>;
  let step: ReturnType<typeof postgres>;
  let stepDb: ReturnType<typeof drizzle>;
  const built = { accountId: randomUUID(), mailboxId: "", letter: "" };
  const owed = { accountId: randomUUID(), mailboxId: "", letter: "" };

  /** The account's search index stamped built: its letters are read through their documents alone. */
  const stampBuilt = (accountId: string) => sql`insert into pass_progress (account_id, job, subject_id, done_at)
    values (${accountId}, 'search_index_backfill', ${accountId}, now())
    on conflict (account_id, job, subject_id) do update set done_at = now()`;
  const vector = async (id: string): Promise<string | null> =>
    (await sql<{ v: string | null }[]>`select body_tsv::text as v from message_bodies where message_id = ${id}`)[0]!.v;
  const retire = (o: Parameters<typeof retireOldSearch>[1] = {}) => retireOldSearch(stepDb, { concurrently: false, ...o });

  beforeAll(async () => {
    await owing.create(async (url) => {
      await makeStoreAtOldHeads(url);
      const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
      try {
        Object.assign(built, await plantAccount(plant, built.accountId));
        Object.assign(owed, await plantAccount(plant, owed.accountId));
        built.letter = await plantLetter(plant, built, { subject: "s", text: "an old letter about lighthouses" });
        owed.letter = await plantLetter(plant, owed, { subject: "s", text: "an owed letter about harbours" });
        await plant`insert into account_settings (account_id, search_index_built_at) values (${built.accountId}, now())`;
      } finally {
        await plant.end({ timeout: 5 });
      }
      // A store at 1.0.11's heads is moved by the transition; this one holds nothing sealed.
      await runMigrations(url, { transition: { kind: "server", openSealed: NOTHING_OPENS } });
    });
    sql = postgres(owing.url, quiet);
    step = postgres(owing.url, { max: 1, onnotice: () => { /* quiet */ } });
    stepDb = brandDialect(drizzle(step), "pg");
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await Promise.all([sql?.end({ timeout: 5 }), step?.end({ timeout: 5 })]);
    await owing.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("mail 0200 kept the whole old search, and still dropped what a later index superseded", async () => {
    expect(await oldSearchOf(sql)).toEqual({
      columns: ["message_bodies.body_tsv", "messages.subject_tsv"],
      trigger: "message_bodies_body_tsv_bounded",
      functions: ["message_bodies_body_tsv_bounded"],
      indexes: ["message_bodies_body_tsv_idx", "messages_subject_tsv_idx"],
    });
    expect(await vector(owed.letter)).toContain("harbour");
    const indexes = (await sql<{ i: string }[]>`select indexname::text as i from pg_indexes where tablename = 'messages'`).map((r) => r.i);
    expect(indexes).toContain("messages_account_mailbox_idx");
    expect(indexes).not.toContain("messages_account_mailbox_unread_idx");
  });

  it("the step keeps it while the letter is owed: the trigger stores no new vector, the old one still answers", async () => {
    expect(await retire()).toEqual({ columns: "standing", trigger: "cleared", gin: "kept", owedAccounts: 1, owedLetters: 1 });
    const later = await plantLetter(sql, built, { subject: "s", text: "a new letter about lighthouses" }, "2.0");
    expect(await vector(later)).toBeNull();
    expect(await vector(built.letter), "an old row keeps its vector until its text changes").toContain("lighthous");
    const [hit] = await sql<{ n: number }[]>`select count(*)::int as n from message_bodies where body_tsv @@ plainto_tsquery('english', 'harbours')`;
    expect(hit!.n, "the owed account still finds its letter by the vector").toBe(1);
    await sql`update message_bodies set text = '', html = null, withheld_reason = 'expunged' where message_id = ${built.letter}`;
    expect(await vector(built.letter), "a letter emptied as gone keeps no words").toBeNull();
  });

  it("gives up with a named error while a body writer holds the table, and changes nothing", async () => {
    await stampBuilt(owed.accountId);
    const writer = await sql.reserve();
    try {
      await writer`begin`;
      await writer`update message_bodies set text = 'uncommitted' where message_id = ${owed.letter}`;
      const err = await retire({ lockTimeoutMs: 100, attempts: 2, pauseMs: 0 }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BodyVectorLockTimeout);
    } finally {
      await writer`rollback`;
      writer.release();
    }
    expect((await oldSearchOf(sql)).columns).toEqual(["message_bodies.body_tsv", "messages.subject_tsv"]);
    const [lt] = await step<{ v: string }[]>`select current_setting('lock_timeout') as v`;
    expect(lt!.v, "the session's lock_timeout is put back").toBe("0");
  });

  it("once nothing is found by it alone, the step runs 0200's statements and the old search is gone", async () => {
    const said: string[] = [];
    expect(await retire({ log: (m) => said.push(m) })).toEqual({ columns: "gone", trigger: "absent", gin: "dropped", owedAccounts: 0, owedLetters: 0 });
    expect(await oldSearchOf(sql)).toEqual(GONE);
    expect(said.join("\n")).toContain("retiring its columns");
    // The body insert that would fail if the trigger had outlived its column.
    const after = await plantLetter(sql, owed, { subject: "s", text: "a letter after the retirement" }, "2.0");
    expect((await sql`select text from message_bodies where message_id = ${after}`)[0]!.text).toBe("a letter after the retirement");
  });

  it("a second run reads the catalog, takes no lock and runs no DDL", async () => {
    const ran: string[] = [];
    const recorded = { execute: (q: Parameters<typeof stepDb.execute>[0]) => {
      ran.push(JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
      return stepDb.execute(q);
    } };
    expect(await retireOldSearch(recorded, { concurrently: false })).toEqual({ columns: "gone", trigger: "absent", gin: "absent", owedAccounts: 0, owedLetters: 0 });
    expect(ran.filter((s) => /advisory_lock|create |drop |lock_timeout/i.test(s))).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("a store made from empty", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await fresh.createFromTemplate();
    sql = postgres(fresh.url, quiet);
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await fresh.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("has no old search: 0200 took it on the way, and the step creates nothing", async () => {
    expect(await oldSearchOf(sql)).toEqual(GONE);
    expect(await retireOldSearch(brandDialect(drizzle(sql), "pg"), { concurrently: false }))
      .toEqual({ columns: "gone", trigger: "absent", gin: "absent", owedAccounts: 0, owedLetters: 0 });
    expect(await oldSearchOf(sql)).toEqual(GONE);
  });

  it("stores a body after the setup's step ran", async () => {
    const at = await plantAccount(sql, randomUUID());
    const id = await plantLetter(sql, at, { subject: "s", text: "stored whole" }, "2.0");
    expect((await sql`select text from message_bodies where message_id = ${id}`)[0]!.text).toBe("stored whole");
  });
});

describe("mail 0200's guarded block and the setup's step are the same statements", () => {
  it("in the same order", () => {
    const entry = readFileSync(join(MAIL_MIGRATIONS_DIR, "0200_search_one_generation.sql"), "utf8");
    const block = /END IF;\n([\s\S]*?)\nEND \$\$;/.exec(entry)?.[1] ?? "";
    const statements = block.split("\n").map((l) => l.trim().replace(/;$/, "")).filter((l) => l.length > 0);
    expect(statements.length).toBeGreaterThan(5);
    expect(OLD_SEARCH_RETIREMENT.map((s) => s.sql)).toEqual(statements);
  });
});
