import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/migrate.js";
import { ensureConcurrentIndexes, type ConcurrentIndexSpec } from "../src/concurrent-index.js";
import {
  ensureHotPathIndexes, HOT_PATH_INDEXES, HOT_PATH_INDEX_SPECS,
  DEFERRED_HOT_PATH_INDEXES, DEFERRED_INDEX_MIN_ROWS,
} from "../src/hot-path-indexes.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE DEFERRAL RULE, DRIVEN — and why this cannot be a PGlite test.
 *
 * `CREATE INDEX CONCURRENTLY` refuses inside a transaction block (25001) and the whole helper
 * exists because of that, so a store that cannot run the statement proves nothing about it.
 *
 * "An index lands only where the planner would use one at this size" used to live in a commit
 * body, which is how two indexes stayed deferred while the tables underneath them moved on (one
 * of them, `billing_events`, was dropped entirely by cloud 0032 and the note never noticed). It
 * is now a number on the spec, and this file drives BOTH of its states — the contrary state of a
 * condition nobody can reach is a condition nobody can watch fail.
 */
const PG_UP = await realPgAvailable();
const OWN = "concurrent_index_deferral_probe";

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect>;

/** A spec over a table this file owns, so the gate is measured without a shared tenant's rows. */
const probeSpec = (minRows: number): ConcurrentIndexSpec => ({
  name: `${OWN}_v_idx`,
  table: OWN,
  minRows,
  ddl: sql.raw(
    `create index concurrently if not exists "${OWN}_v_idx" on public."${OWN}" using btree ("v")`,
  ),
});

const indexExists = async (name: string): Promise<boolean> => {
  const rows = await client<{ n: number }[]>`
    select count(*)::int as n from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'i' and c.relname = ${name}`;
  return Number(rows[0]?.n ?? 0) > 0;
};

const rowsIn = async (table: string): Promise<number> => {
  const rows = await client.unsafe(`select count(*)::int as n from public."${table}"`);
  return Number((rows[0] as unknown as { n: number } | undefined)?.n ?? 0);
};

// FILE-LEVEL, not per-describe: an `afterAll` inside the first block ends the connection before
// the second block's first line, which reads as CONNECTION_ENDED rather than as a failure.
beforeAll(async () => {
  if (!PG_UP) return;
  client = postgres(PG_TEST_URL, { max: 4 });
  db = brandDialect(drizzle(client), "pg");
  await runMigrations(PG_TEST_URL);
  await client.unsafe(`drop table if exists public."${OWN}"`);
  await client.unsafe(`create table public."${OWN}" (id bigserial primary key, v int not null)`);
}, 180_000);

afterAll(async () => {
  await client?.unsafe(`drop table if exists public."${OWN}"`).catch(() => undefined);
  await client?.end({ timeout: 5 });
});

describe.skipIf(!PG_UP)("the concurrent-index helper's size gate (real Postgres)", () => {
  it("DECLINES the build while the table is under the ceiling, and says so", async () => {
    await client.unsafe(`truncate table public."${OWN}"`);
    await client.unsafe(`insert into public."${OWN}" (v) select g from generate_series(1, 9) g`);
    const said: string[] = [];

    await ensureConcurrentIndexes(db as never, [probeSpec(10)], {
      label: "the probe", log: (m) => said.push(m),
    });

    expect(await indexExists(`${OWN}_v_idx`)).toBe(false);
    expect(said.join("\n")).toMatch(/under 10 rows — declined at this size/);
  });

  it("BUILDS it the moment the table crosses the ceiling", async () => {
    // The same spec, the same call — only the size changed. This is the arm that makes the
    // decline above a decision rather than a permanent no.
    await client.unsafe(`insert into public."${OWN}" (v) select g from generate_series(10, 40) g`);
    expect(await rowsIn(OWN)).toBeGreaterThanOrEqual(10);

    await ensureConcurrentIndexes(db as never, [probeSpec(10)], { label: "the probe" });

    expect(await indexExists(`${OWN}_v_idx`)).toBe(true);
  });

  it("is idempotent — a re-run over a present, valid index writes nothing", async () => {
    const said: string[] = [];
    await ensureConcurrentIndexes(db as never, [probeSpec(10)], {
      label: "the probe", log: (m) => said.push(m),
    });
    expect(await indexExists(`${OWN}_v_idx`)).toBe(true);
    expect(said).toEqual([]);
  });

  it("an INVALID leftover from a failed concurrent build is dropped and rebuilt", async () => {
    // The one state `IF NOT EXISTS` gets wrong: a failed CONCURRENTLY build leaves an index the
    // catalog lists and the planner refuses to use, for ever.
    await client.unsafe(`update pg_index set indisvalid = false
       where indexrelid = '${OWN}_v_idx'::regclass`);
    const said: string[] = [];

    await ensureConcurrentIndexes(db as never, [probeSpec(10)], {
      label: "the probe", log: (m) => said.push(m),
    });

    expect(said.join("\n")).toMatch(/INVALID leftover/);
    const valid = await client<{ v: boolean }[]>`
      select indisvalid as v from pg_index where indexrelid = ${`${OWN}_v_idx`}::regclass`;
    expect(valid[0]?.v).toBe(true);
  });

  it("a table that does not exist at all is deferred, never thrown over", async () => {
    const said: string[] = [];
    await ensureConcurrentIndexes(
      db as never,
      [{ name: "no_such_idx", table: "no_such_table_here", ddl: sql`select 1` }],
      { label: "the probe", log: (m) => said.push(m) },
    );
    expect(said.join("\n")).toMatch(/does not exist yet — deferred to the journal/);
  });
});

describe.skipIf(!PG_UP)("what the production spec table declares", () => {
  it("names exactly one deferred index, at the measured ceiling", () => {
    expect(DEFERRED_HOT_PATH_INDEXES.map((d) => d.name))
      .toEqual(["outbound_sends_pending_created_idx"]);
    expect(DEFERRED_HOT_PATH_INDEXES[0]!.minRows).toBe(DEFERRED_INDEX_MIN_ROWS);
    // The unconditional set is the complement, and neither list is written twice.
    expect([...HOT_PATH_INDEXES].sort()).toEqual([
      "audit_log_account_action_idx",
      // The two retention prunes' age keys: index builds a journal may not carry on a growth
      // table, so they are specs like the rest.
      "audit_log_created_at_idx",
      "auth_events_at_idx",
      // Mail 0160's outstanding filings by account — the mailbox poll's filing facts.
      "folder_state_outstanding_idx",
      // The Screener auto-apply held page: a growth table, unconditional like `messages`. Keyed by
      // the floor version since mail 0141; the old `folder_state_screener_held_idx` left the list.
      "folder_state_screener_held_floor_idx",
      // Mail 0161's list read — the caller's mailboxes by account.
      "mailboxes_account_idx",
      // Mail 0171's arrival order — the order every list, History and snapshot page walks.
      "messages_account_arrival_key_idx",
      "messages_account_date_order_idx",
      "messages_account_msg_order_idx",
      // Mail 0157's sender-date index — the Screener cutline probe's key.
      "messages_account_sender_date_idx",
      // Mail 0154's recipient keys — the prebuild's own spec, so the read-back checks it valid.
      "messages_recipient_keys_idx",
      // Mail 0148's never-checked rows — the identity backfill's set, every row NULL at the column's
      // birth, so built CONCURRENTLY here and never in the journal.
      "messages_sender_check_owed_idx",
    ]);
    expect(HOT_PATH_INDEX_SPECS).toHaveLength(
      HOT_PATH_INDEXES.length + DEFERRED_HOT_PATH_INDEXES.length,
    );
  });

  it("builds the unconditional set and leaves the deferred one alone on a small table", async () => {
    // The precondition is ASSERTED, not assumed: if this database's `outbound_sends` were
    // already over the ceiling the absence below would mean nothing.
    const held = await rowsIn("outbound_sends");
    expect(held, "this database's outbound_sends is over the ceiling — the arm proves nothing")
      .toBeLessThan(DEFERRED_INDEX_MIN_ROWS);

    await ensureHotPathIndexes(db as never);

    for (const name of HOT_PATH_INDEXES) expect(await indexExists(name)).toBe(true);
    expect(await indexExists("outbound_sends_pending_created_idx")).toBe(false);
  }, 180_000);
});
