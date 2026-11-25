/* @postpush: alone — it makes databases of its own along the 1.0 road, plants a 1.0.11 store there
 * and copies it per case; nothing it does reaches the lane database. */
import { inspect } from "node:util";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql as dsql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { CLOUD_JOURNAL, MAIL_JOURNAL } from "../src/journal-specs.js";
import { journalThrough } from "../src/testing-journal.js";
import { readJournalOf } from "../src/baseline.js";
import { TransitionNeedsRunner, runMigrations } from "../src/migrate.js";
import { setupProdDatabase } from "../src/setup-prod.js";
import { OLD_HEADS } from "../src/journal-heads.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb, type ThrowawayDb,
} from "../src/testing.js";
import {
  MAP_2_0, NOTHING_OPENS, TransitionFailed, TransitionRefused, accountTablesFromCatalog, accountTablesOf, describeEvent, readWindow, runTransition, sealedOpener,
  tablesOf, transitionState, type StoreKind, type TransitionEvent, type TransitionInput, type TransitionReport,
} from "../src/transition/index.js";
import { makeStoreAtOldHeads } from "./_store-at-old-heads.js";
import { openAdmin, setupRole, type AdminSql } from "./_setup-role.js";
import { cloneStore, fingerprintOf, plant1011, testRing, type Planted } from "./_plant-1-0-11.js";

/**
 * THE 2.0 TRANSITION ON A STORE IN 1.0.11'S SHAPE, on a real Postgres: a database walked along the
 * old journals to their heads by drizzle's own migrator, then planted with invented rows. Each
 * case takes its own copy. Moved as a server and as the Cloud; the desktop kind is PGlite's file.
 */
const PG_UP = await realPgAvailable();
const base = throwawayDb("transition_base");
const ring = testRing();
const copies: ThrowawayDb[] = [];
const clients: ReturnType<typeof postgres>[] = [];
const folders: string[] = [];
let planted: Planted;
/**
 * `setupProdDatabase` writes its deadlines onto the role it connects as, role-wide. The cases that
 * run it connect as a role of their own, so the lane's role reads afterwards as it did before.
 */
const SETUP_AS = setupRole();
let admin: AdminSql | undefined;

async function copy(logical: string): Promise<{ sql: ReturnType<typeof postgres>; url: string; name: string }> {
  const db = throwawayDb(logical);
  copies.push(db);
  await cloneStore(base, db);
  const sql = postgres(db.url, { max: 2, onnotice: () => { /* quiet */ } });
  clients.push(sql);
  return { sql, url: db.url, name: db.name };
}

/** One run, with everything it said kept: the events, and the lines a plain log would carry. */
async function move(
  sql: ReturnType<typeof postgres>, kind: StoreKind, over: Partial<TransitionInput> = {},
): Promise<{ report?: TransitionReport; error?: unknown; events: TransitionEvent[]; lines: string[] }> {
  const events: TransitionEvent[] = [];
  const input: TransitionInput = {
    kind, db: brandDialect(drizzle(sql), "pg"), openSealed: sealedOpener(ring), log: (e) => { events.push(e); }, ...over,
  };
  try {
    return { report: await runTransition(input), events, lines: events.map(describeEvent) };
  } catch (error) {
    return { error, events, lines: events.map(describeEvent) };
  }
}

/** A journal copied to a folder of its own, with one entry's text edited: a fault no shipped file carries. */
function editedJournal(spec: typeof CLOUD_JOURNAL, tag: string, edit: (text: string) => string): typeof CLOUD_JOURNAL {
  const dir = mkdtempSync(join(tmpdir(), `ohmail-transition-${spec.name}-`));
  folders.push(dir);
  cpSync(spec.dir, dir, { recursive: true });
  writeFileSync(join(dir, `${tag}.sql`), edit(readFileSync(join(dir, `${tag}.sql`), "utf8")));
  return { ...spec, dir };
}

beforeAll(async () => {
  if (!PG_UP) return;
  await base.create(async (url) => {
    await makeStoreAtOldHeads(url);
    const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
    try { planted = await plant1011(plant, { cloud: true, ring }); } finally { await plant.end({ timeout: 5 }); }
  });
  admin = openAdmin(PG_TEST_URL);
  await SETUP_AS.create(admin);
}, MIGRATED_DB_SETUP_BUDGET_MS);

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => { /* a cut connection is already gone */ });
  for (const db of copies) await db.drop().catch(() => { /* the next run's names are its own */ });
  await base.drop();
  // After the databases: a role that still owns something in one cannot be dropped.
  if (admin) {
    await SETUP_AS.drop(admin).catch(() => { /* a leftover is swept by its stamp */ });
    await admin.end({ timeout: 5 });
  }
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
}, MIGRATED_DB_TEARDOWN_BUDGET_MS);

describe.skipIf(!PG_UP)("a store in 1.0.11's shape, moved as a server", () => {
  it("is what the map says a 1.0.11 server holds, at the old heads", async () => {
    const { sql } = await copy("transition_shape");
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("at-old-head");
    // The map's tables, less what the window makes, plus what it drops: exactly this catalog.
    const made = new Set(["pass_progress", "message_invitations", "account_counters", "account_closures", "cal_push_channels",
      ...Object.keys(MAP_2_0).filter((t) => t.startsWith("cal_"))]);
    const known = [...tablesOf("server", "window").filter((t) => !made.has(t)), "away_responder_sent"].sort();
    const standing = (await sql<{ name: string }[]>`select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`).map((r) => r.name);
    expect(standing).toEqual(known);
  });

  it("commits once: every table holds the count its formula gave, and both heads read the window's last entry", async () => {
    const { sql } = await copy("transition_server");
    const before = await fingerprintOf(sql);
    // The account two triggers copied onto the reconcile queues' rows (mail 0160, 0181): mail 0201 takes the copies away.
    const copies = async (): Promise<string[]> => (await sql<{ name: string }[]>`select table_name || '.' || column_name as name
      from information_schema.columns where table_schema = 'public'
       and (table_name, column_name) in (('folder_state', 'outstanding_account_id'), ('flag_state', 'pending_account_id'))
      union all select tgname::text from pg_trigger
       where tgname in ('folder_state_outstanding_account_tg', 'folder_state_pending_account_tg', 'flag_state_pending_account_tg')
      order by 1`).map((r) => r.name);
    expect(await copies()).toHaveLength(5);
    const { report, error, lines } = await move(sql, "server");
    expect(error).toBeUndefined();
    expect(report!.verdicts.filter((v) => !v.ok)).toEqual([]);
    expect(report!.verdicts.length).toBeGreaterThan(150);

    // The counts, table by table: the 111 of a server, each as the map says of the store before.
    const after = await fingerprintOf(sql);
    expect(Object.keys(after.counts).sort()).toEqual(tablesOf("server", "window"));
    for (const table of tablesOf("server", "window")) {
      const rows = MAP_2_0[table]!.rows;
      if (rows === "same") expect(after.counts[table], table).toBe(before.counts[table]);
      if (rows === "empty") expect(after.counts[table], table).toBe(0);
      expect(report!.counts[table], `${table} as the checks read it`).toBe(after.counts[table]);
    }
    expect(after.counts.pass_progress).toBe(planted.passRows.length);
    expect(after.counts.account_counters).toBe(planted.countersMoved.length);
    expect(after.counts.auth_throttle).toBe(planted.countersStayed.length);
    expect(after.counts.away_responder_sent).toBeUndefined();

    // What moved, value by value.
    // drizzle's handle leaves instants as the server wrote them; read back as instants.
    const at = (v: unknown): Date | null => v === null ? null : new Date(v as string);
    expect((await sql`select account_id, job, subject_id, requested_at, started_at, done_at, cursor from pass_progress order by account_id, job`)
      .map((r) => ({ ...r, requested_at: at(r.requested_at), started_at: at(r.started_at), done_at: at(r.done_at) }))).toEqual(planted.passRows);
    const counters = await sql<{ key: string; account_id: string; failures: number }[]>`select key, account_id, failures from account_counters order by key`;
    expect(counters.map((r) => r.key)).toEqual([...planted.countersMoved].sort());
    expect(counters.every((r) => r.account_id === planted.main.accountId && r.failures === 3)).toBe(true);
    expect((await sql<{ key: string }[]>`select key from auth_throttle order by key`).map((r) => r.key)).toEqual([...planted.countersStayed].sort());
    expect((await sql<{ n: number }[]>`select count(*)::int as n from alert_state where subject_account_id = ${planted.main.accountId}`)[0]!.n).toBe(3);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from auth_events where user_id is not null and account_id is null`)[0]!.n).toBe(0);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from message_bodies where account_id = ${planted.main.accountId}`)[0]!.n).toBe(planted.letters);
    // The row carries its account itself now: no copy and no trigger that kept one is left.
    expect(await copies()).toEqual([]);

    // The ledgers: each gained its window's entries with the journal's hash and stamp, and nothing else moved.
    for (const [journal, spec] of [["mail", MAIL_JOURNAL], ["cloud", CLOUD_JOURNAL]] as const) {
      const window = readWindow(journal, spec);
      const rows = await sql.unsafe(`select hash, created_at::text as at from "drizzle_${journal}"."__drizzle_migrations" where created_at > ${OLD_HEADS[journal].when} order by created_at`);
      expect(rows.map((r) => ({ hash: r.hash as string, when: Number(r.at) }))).toEqual(window.map((e) => ({ hash: e.hash, when: e.when })));
      expect(report!.heads[journal]).toBe(window.at(-1)!.when);
    }
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("moved");
    // The tables that carry the account, read from the moved store's own catalog, are the map's.
    expect(await accountTablesFromCatalog(brandDialect(drizzle(sql), "pg"))).toEqual(accountTablesOf("server", "window"));

    // Every sealed value was opened, and what it said is counts and the map's names.
    expect(Object.fromEntries(report!.sealed.filter((s) => s.rows > 0).map((s) => [s.site, s.opened]))).toEqual(planted.sealed);
    expect(lines.at(-1)).toMatch(/^transition: committed/);
    expect(lines.join("\n")).not.toMatch(/@iso\.test|v1:|scrypt\$/);
  });

  it("run a second time it applies nothing: the store is no longer at 1.0.11's heads", async () => {
    const { sql } = await copy("transition_twice");
    expect((await move(sql, "server")).error).toBeUndefined();
    const once = await fingerprintOf(sql);
    const again = await move(sql, "server");
    expect(again.error).toBeInstanceOf(TransitionRefused);
    expect((again.error as Error).message).toMatch(/the store is moved, not at 1\.0\.11's heads/);
    expect(await fingerprintOf(sql)).toEqual(once);
  });

  it("the old search stays whole where letters are found by it alone, and is gone where none is", async () => {
    const { sql } = await copy("transition_old_search");
    const tsv = async (): Promise<number> => (await sql<{ n: number }[]>`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and (table_name, column_name) in (('message_bodies', 'body_tsv'), ('messages', 'subject_tsv'))`)[0]!.n;
    expect(await tsv()).toBe(2);
    // One letter that no document search finds, in the account whose search pass never ran.
    const [m] = await sql<{ id: string }[]>`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, date)
      values (${planted.other.accountId}, ${planted.other.mailboxId}, 'h', 'only-the-old-search', 'old', now()) returning id`;
    await sql`insert into message_bodies (message_id, text) values (${m!.id}, 'found by the old search alone')`;
    const stays = await move(sql, "server");
    expect(stays.error).toBeUndefined();
    expect(await tsv()).toBe(2);
    expect(stays.lines.some((l) => /living letters only the old search finds.*: 1$/.test(l))).toBe(true);
    // The store planted as it stands has none: there the old search goes.
    const none = await copy("transition_old_search_gone");
    expect((await move(none.sql, "server")).error).toBeUndefined();
    expect((await none.sql<{ n: number }[]>`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and (table_name, column_name) in (('message_bodies', 'body_tsv'), ('messages', 'subject_tsv'))`)[0]!.n).toBe(0);
  });
});

/**
 * THE RECIPIENTS' KEY, STORED (mail 0208): a column the database writes from mail 0154's frozen
 * function, added inside the window, where it rewrites `messages` whole. Letters planted in 1.0's
 * columns in every shape the function reads: To and Cc, one address on both sides in two cases, an
 * entry with no address and one with an empty one, an address at the 254 characters one may have
 * and one past them, lists that are not lists, and no recipient at all.
 */
const RECIPIENT_KEYS_ENTRY = "0208_recipient_keys_column";
const RECIPIENT_KEYS_EXPRESSION = "messages_recipient_keys(account_id, to_addresses, cc_addresses)";
const LONGEST = `${"a".repeat(241)}@example.test`;
const recipientShapes = (account: string): ReadonlyArray<{ to: unknown; cc: unknown; keys: string[] }> => [
  { to: [{ name: "Ann", address: "Ann@Example.test" }], cc: [{ name: null, address: "bob@example.test" }], keys: [`${account}:ann@example.test`, `${account}:bob@example.test`] },
  { to: [{ address: "same@example.test" }, { address: "Same@Example.test" }], cc: [{ address: "SAME@example.test" }], keys: [`${account}:same@example.test`] },
  { to: [{ name: "no address" }, { address: null }, { address: "" }], cc: [], keys: [] },
  { to: [{ address: LONGEST }], cc: [{ address: `b${LONGEST}` }], keys: [`${account}:${LONGEST}`] },
  { to: { address: "not-a-list@example.test" }, cc: "nor-this@example.test", keys: [] },
  { to: [], cc: [], keys: [] },
];
type Sql = ReturnType<typeof postgres>;
/** The column as the catalog holds it: generated how, and from what. `null` where there is none. */
const keyColumn = async (sql: Sql): Promise<{ generated: string; expr: string | null } | null> =>
  (await sql<{ generated: string; expr: string | null }[]>`select a.attgenerated::text as generated, pg_get_expr(d.adbin, d.adrelid) as expr
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.messages'::regclass and a.attname = 'recipient_keys' and not a.attisdropped`)[0] ?? null;
/** An index of `public` by name: its definition, whether it is valid, its options. `null` where there is none. */
const indexNamed = async (sql: Sql, name: string): Promise<{ def: string; valid: boolean; options: string[] | null } | null> =>
  (await sql<{ def: string; valid: boolean; options: string[] | null }[]>`select pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid,
     c.reloptions as options from pg_index i join pg_class c on c.oid = i.indexrelid where i.indexrelid = to_regclass(${`public.${name}`})`)[0] ?? null;
/** The SQLSTATE a statement fails with, or `undefined` where it does not fail. */
const failsWith = async (q: Promise<unknown>): Promise<string | undefined> =>
  q.then(() => undefined, (e: { code?: string }) => e.code ?? "no code");

describe.skipIf(!PG_UP)("the recipients' key, stored (mail 0208)", () => {
  it("moved as a server: every letter holds the key the function gives, and the column's index stands where the expression index stood", async () => {
    const { sql } = await copy("transition_recipient_keys");
    const shaped: { id: string; keys: string[] }[] = [];
    for (const who of [planted.main, planted.other]) {
      for (const [i, s] of recipientShapes(who.accountId).entries()) {
        const [m] = await sql<{ id: string }[]>`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, date, to_addresses, cc_addresses)
          values (${who.accountId}, ${who.mailboxId}, 'h', ${`recipients:${who.accountId}:${i}`}, ${`recipients ${i}`}, now(), ${sql.json(s.to as never)}, ${sql.json(s.cc as never)})
          returning id`;
        shaped.push({ id: m!.id, keys: [...s.keys].sort() });
      }
    }
    // At 1.0.11's heads: mail 0154's expression index, and no column.
    expect(await keyColumn(sql)).toBeNull();
    expect((await indexNamed(sql, "messages_recipient_keys_idx"))?.def).toContain(`USING gin (${RECIPIENT_KEYS_EXPRESSION})`);

    const { report, error } = await move(sql, "server");
    expect(error).toBeUndefined();
    expect(report!.entries.map((e) => e.tag)).toContain(RECIPIENT_KEYS_ENTRY);
    expect(report!.verdicts.filter((v) => !v.ok)).toEqual([]);

    // Every letter of the store, the planted ones among them: the column is what the function answers.
    const [all] = await sql<{ letters: number; differ: number; keyed: number }[]>`select count(*)::int as letters,
      (count(*) filter (where recipient_keys is distinct from messages_recipient_keys(account_id, to_addresses, cc_addresses)))::int as differ,
      (count(*) filter (where cardinality(recipient_keys) > 0))::int as keyed from messages`;
    expect(all!.letters).toBe(planted.letters + shaped.length);
    expect(all!.differ).toBe(0);
    expect(all!.keyed).toBe(shaped.filter((p) => p.keys.length > 0).length);
    const stored = new Map((await sql<{ id: string; keys: string[] }[]>`select id, recipient_keys as keys from messages
      where id = any(${shaped.map((p) => p.id)}::uuid[])`).map((r) => [r.id, [...r.keys].sort()]));
    expect(shaped.map((p) => stored.get(p.id))).toEqual(shaped.map((p) => p.keys));

    // Written by the database, from the frozen function; its own index under a new name, the expression index gone.
    expect(await keyColumn(sql)).toEqual({ generated: "s", expr: RECIPIENT_KEYS_EXPRESSION });
    expect(await indexNamed(sql, "messages_recipient_keys_idx")).toBeNull();
    expect(await indexNamed(sql, "messages_recipient_keys_column_idx")).toEqual({
      def: "CREATE INDEX messages_recipient_keys_column_idx ON public.messages USING gin (recipient_keys) WITH (gin_pending_list_limit='256')",
      valid: true, options: ["gin_pending_list_limit=256"],
    });
  });

  it("a writer cannot set the key: the database refuses it, and writes it again when the letter's recipients change", async () => {
    const { sql } = await copy("transition_recipient_keys_writer");
    expect((await move(sql, "server")).error).toBeUndefined();
    const { accountId, mailboxId } = planted.main;
    /** One recipient list of one address, built by the server. */
    const one = (address: string) => sql`jsonb_build_array(jsonb_build_object('name', null, 'address', ${address}::text))`;
    expect(await failsWith(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, to_addresses, recipient_keys)
      values (${accountId}, ${mailboxId}, 'h', 'sets-its-key', 's', ${one("To@Example.test")}, array[${"forged:a@example.test"}::text])`)).toBe("428C9");
    const [m] = await sql<{ id: string; keys: string[] }[]>`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, to_addresses)
      values (${accountId}, ${mailboxId}, 'h', 'its-key-is-written', 's', ${one("To@Example.test")}) returning id, recipient_keys as keys`;
    expect(m!.keys).toEqual([`${accountId}:to@example.test`]);
    expect(await failsWith(sql`update messages set recipient_keys = array[${"forged:a@example.test"}::text] where id = ${m!.id}`)).toBe("428C9");
    await sql`update messages set cc_addresses = ${one("CC@example.test")} where id = ${m!.id}`;
    const [after] = await sql<{ keys: string[] }[]>`select recipient_keys as keys from messages where id = ${m!.id}`;
    expect([...after!.keys].sort()).toEqual([`${accountId}:cc@example.test`, `${accountId}:to@example.test`]);
  });

  it("a column made of another expression is the transition's red check, and nothing commits", async () => {
    const { sql } = await copy("transition_recipient_keys_plant");
    const before = await fingerprintOf(sql);
    // The plant: the entry's column made of To twice, Cc never.
    const mail = editedJournal(MAIL_JOURNAL, RECIPIENT_KEYS_ENTRY, (text) => {
      const toTwice = text.replace(`"to_addresses", "cc_addresses")) STORED`, `"to_addresses", "to_addresses")) STORED`);
      expect(toTwice).not.toBe(text);
      return toTwice;
    });
    const run = await move(sql, "server", { journals: { mail, cloud: CLOUD_JOURNAL } });
    expect(run.error).toBeInstanceOf(TransitionFailed);
    expect((run.error as TransitionFailed).at.stage).toBe("check");
    expect((run.error as TransitionFailed).at.lines).toEqual([{
      what: `the recipients' key is mail 0154's function / messages.recipient_keys: expected ${RECIPIENT_KEYS_EXPRESSION}, `
        + "found messages_recipient_keys(account_id, to_addresses, to_addresses)",
      n: 1,
    }]);
    expect(await fingerprintOf(sql)).toEqual(before);
    expect(await keyColumn(sql)).toBeNull();
  });
});

describe.skipIf(!PG_UP)("a store the transition was not written for", () => {
  it("a head between the two (one entry past 1.0.11's) is refused before the first entry", async () => {
    const { sql } = await copy("transition_0186");
    await sql.unsafe(`insert into "drizzle_mail"."__drizzle_migrations" (hash, created_at) values ('a-1.0-fix-this-tree-lacks', ${OLD_HEADS.mail.when + 1})`);
    const before = await fingerprintOf(sql);
    const state = await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true });
    expect(state).toMatchObject({ refused: expect.stringMatching(/neither 1\.0\.11's .* nor a store that took the whole 2\.0 window/) });
    const run = await move(sql, "server");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect(run.events.some((e) => e.type === "entry")).toBe(false);
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("a store an unreleased 2.0 build made is refused in words that say what it is and what becomes of it", async () => {
    // Made from empty by the journals as they stood one entry before the window's end: such a build's store.
    const built = throwawayDb("transition_unreleased");
    copies.push(built);
    const window = readWindow("mail");
    const cut = [journalThrough(MAIL_JOURNAL, window.at(-2)!.when), journalThrough(CLOUD_JOURNAL, readJournalOf(CLOUD_JOURNAL).at(-1)!.when)];
    try {
      await built.create(async (url) => {
        const client = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
        try {
          for (const c of cut) await migrate(brandDialect(drizzle(client), "pg"), { migrationsFolder: c.spec.dir, migrationsSchema: c.spec.migrationsSchema });
        } finally { await client.end({ timeout: 5 }); }
      });
    } finally { for (const c of cut) c.dispose(); }
    const sql = postgres(built.url, { max: 2, onnotice: () => { /* quiet */ } });
    clients.push(sql);
    const before = await fingerprintOf(sql);
    const said = `the mail journal records ${window.length - 1} of the ${window.length} entries of the 2.0 window: `
      + "a store an unreleased 2.0 build made; no release moves it, so it is made again from empty";
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toEqual({ refused: said });
    // The ordinary start says the same and changes nothing.
    const start = await runMigrations(built.url).then(() => null, (e: unknown) => e);
    expect(start).toBeInstanceOf(TransitionRefused);
    expect((start as Error).message).toContain(said);
    expect(await fingerprintOf(sql)).toEqual(before);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("a ledger that lost an entry of the file is refused, whatever its count", async () => {
    const { sql } = await copy("transition_lost_row");
    // One row out and one stranger in: the count is unchanged, the head too.
    await sql.unsafe(`delete from "drizzle_cloud"."__drizzle_migrations" where created_at = (select min(created_at) from "drizzle_cloud"."__drizzle_migrations")`);
    await sql.unsafe(`insert into "drizzle_cloud"."__drizzle_migrations" (hash, created_at) values ('an-entry-that-left-the-journal', 5)`);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toMatchObject({ refused: expect.stringMatching(/1 of its entries are not recorded/) });
    expect((await move(sql, "server")).error).toBeInstanceOf(TransitionRefused);
    // The other way round is no fault: entries that ran here and later left the journal.
    const more = await copy("transition_more_rows");
    await more.sql.unsafe(`insert into "drizzle_cloud"."__drizzle_migrations" (hash, created_at) values ('an-entry-that-left-the-journal', 5)`);
    expect(await transitionState(brandDialect(drizzle(more.sql), "pg"), { cloud: true })).toBe("at-old-head");
  });

  it("a store its runner misnames is refused: a server said to be a desktop", async () => {
    const { sql } = await copy("transition_kind");
    const before = await fingerprintOf(sql);
    const run = await move(sql, "desktop");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect((run.error as Error).message).toMatch(/its runner says it is a desktop's/);
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("a name an entry needs that is gone, and a name an entry makes that is taken, are each named before anything runs", async () => {
    const { sql } = await copy("transition_names");
    await sql`drop index "learning_signals_account_idx"`;
    await sql`create index "message_bodies_account_idx" on message_bodies (message_id)`;
    await sql`create table pass_progress (id int)`;
    const before = await fingerprintOf(sql);
    const run = await move(sql, "server");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    const said = (run.error as TransitionRefused).lines.map((l) => l.what);
    expect(said).toContain("a name an entry needs is missing: mail 0202: index learning_signals_account_idx");
    expect(said).toContain("a name an entry makes is taken: mail 0201: index message_bodies_account_idx");
    expect(said.some((l) => l.startsWith("a table the map does not name for this store: it takes a name 2.0 makes"))).toBe(true);
    expect(run.events.some((e) => e.type === "entry")).toBe(false);
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("an index or a constraint left half done on one of the product's tables is named before anything runs; what an entry drops itself stops nothing", async () => {
    const { sql } = await copy("transition_half_done");
    /** As a concurrent build that was cut leaves an index: in the catalog, not valid. */
    const cut = async (index: string, valid = false): Promise<void> => {
      await sql`update pg_index set indisvalid = ${valid} where indexrelid = to_regclass(${`public."${index.replaceAll('"', '""')}"`})`;
    };
    // An index nobody's list knows on a table of the product's, one with a name no line may carry,
    // a check nobody validated, and an index mail 0202 drops by name.
    await sql`create index "an_operators_idx" on mailboxes (address)`;
    await sql.unsafe(`create index "idx'; drop table accounts; --" on mailboxes (provider)`);
    for (const index of ["an_operators_idx", "idx'; drop table accounts; --", "learning_signals_account_idx"]) await cut(index);
    await sql`alter table mailboxes add constraint "an_operators_ck" check (address <> '') not valid`;
    const before = await fingerprintOf(sql);

    const run = await move(sql, "server");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect((run.error as TransitionRefused).lines).toEqual([
      { what: "an index on one of the product's tables is not valid: an interrupted build left it, and no entry drops it", n: 2 },
      { what: "a constraint on one of the product's tables is not validated, and no entry validates or drops it", n: 1 },
    ]);
    const said = run.lines.join("\n");
    expect(said).toContain(`an index that is not valid, "an_operators_idx", refuses the transition`);
    expect(said).toContain(`a constraint that is not validated, "an_operators_ck", refuses the transition`);
    expect(said).toContain("an index that is not valid, <name of 29 bytes, not printed>, refuses the transition");
    expect(`${said}\n${inspect(run.error, { depth: 10 })}`).not.toMatch(/drop table|learning_signals_account_idx/);
    expect(run.events.some((e) => e.type === "entry")).toBe(false);
    expect(await fingerprintOf(sql)).toEqual(before);

    // Repaired by hand, the store moves; the index 0202 drops went with its entry, valid or not.
    await sql`drop index "an_operators_idx"`;
    await sql.unsafe(`drop index "idx'; drop table accounts; --"`);
    await sql`alter table mailboxes validate constraint "an_operators_ck"`;
    const again = await move(sql, "server");
    expect(again.error).toBeUndefined();
    expect((await sql`select to_regclass('public.learning_signals_account_idx') as t`)[0]!.t).toBeNull();
  });

  it("a row an entry would stop on is counted before anything runs", async () => {
    const { sql } = await copy("transition_precondition");
    // A kept copy of the account that disagrees with its letter's: the trigger is off for the write.
    await sql`alter table folder_state disable trigger user`;
    await sql`update folder_state set outstanding_account_id = ${planted.other.accountId}
      where message_id = (select message_id from folder_state where outstanding_account_id is not null limit 1)`;
    await sql`alter table folder_state enable trigger user`;
    await sql`insert into auth_throttle (key) values (${`nobody-classed-this:${planted.main.accountId}`})`;
    const run = await move(sql, "server");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect((run.error as TransitionRefused).lines).toEqual(expect.arrayContaining([
      { what: "folder_state rows whose kept copy of the account disagrees with the letter's (mail 0201)", n: 1 },
      { what: "counters that carry an id and are of no family cloud 0101 moves", n: 1 },
    ]));
  });
});

describe.skipIf(!PG_UP)("a table that is not the product's", () => {
  /** Names an owner might give a table, each with rows; none may reach a statement or a line unquoted. */
  const HOSTILE = [
    `messages"; drop table "accounts"; --`, `'; drop table accounts; --`, "%I%s%L", "alice@example.test",
    "line\nMUST BE ZERO forged = 0", "Messages", "n".repeat(63), "transition_2_0",
  ];
  const plantOwners = async (sql: ReturnType<typeof postgres>): Promise<void> => {
    for (const name of HOSTILE) {
      const q = `"${name.replaceAll('"', '""')}"`;
      await sql.unsafe(`create table public.${q} (account_id uuid, note text)`);
      await sql.unsafe(`insert into public.${q} (note) values ('a row of its own')`);
    }
    await sql`create schema transition_2_0`;
    await sql`create table transition_2_0.kept (note text)`;
  };

  it("on a self-hosted server it is reported and left alone, with its rows, and its name is printed only when it is a plain one", async () => {
    const { sql } = await copy("transition_owner_server");
    await plantOwners(sql);
    const run = await move(sql, "server");
    expect(run.error).toBeUndefined();
    expect(run.report!.ownerTables).toBe(HOSTILE.length);
    for (const name of HOSTILE) {
      const q = `"${name.replaceAll('"', '""')}"`;
      expect((await sql.unsafe(`select note from public.${q}`)).map((r) => r.note)).toEqual(["a row of its own"]);
    }
    expect((await sql`select count(*)::int as n from transition_2_0.kept`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from accounts`)[0]!.n).toBeGreaterThan(0);
    const said = run.lines.join("\n");
    expect(said).toContain(`"Messages", left alone`);
    expect(said).toContain(`"transition_2_0", left alone`);
    expect(said).not.toMatch(/alice|drop table|forged|%I%s%L/);
    expect(run.lines.every((l) => !l.includes("\n"))).toBe(true);
    expect(said).toContain("<name of 18 bytes, not printed>");
  });

  it("what is left half done on such a table is its owner's: a constraint not validated and an index not valid there stop nothing", async () => {
    const { sql } = await copy("transition_owner_half_done");
    await sql`create table owners_notes (id int primary key, account_id uuid, note text)`;
    await sql`insert into owners_notes (id, note) values (1, 'a row of its own')`;
    await sql`alter table owners_notes add constraint owners_notes_note_ck check (note <> '') not valid`;
    await sql`alter table owners_notes add constraint owners_notes_account_fk foreign key (account_id) references accounts (id) not valid`;
    await sql`create index owners_notes_note_idx on owners_notes (note)`;
    await sql`update pg_index set indisvalid = false where indexrelid = 'public.owners_notes_note_idx'::regclass`;
    const halfDone = async (): Promise<unknown> => [
      (await sql`select conname::text as name from pg_constraint where conrelid = 'public.owners_notes'::regclass and not convalidated order by 1`).map((r) => r.name),
      (await sql`select indisvalid as valid from pg_index where indexrelid = 'public.owners_notes_note_idx'::regclass`)[0]!.valid,
    ];
    expect(await halfDone()).toEqual([["owners_notes_account_fk", "owners_notes_note_ck"], false]);

    const run = await move(sql, "server");
    expect(run.error).toBeUndefined();
    expect(run.report!.ownerTables).toBe(1);
    expect(run.report!.verdicts.filter((v) => !v.ok)).toEqual([]);
    expect(run.lines.join("\n")).toContain(`"owners_notes", left alone`);
    // Its row and what was half done on it stand as they were: no statement touched it.
    expect((await sql`select note from owners_notes`).map((r) => r.note)).toEqual(["a row of its own"]);
    expect(await halfDone()).toEqual([["owners_notes_account_fk", "owners_notes_note_ck"], false]);
  });

  it("on the Cloud every such table refuses, and nothing is changed", async () => {
    const { sql } = await copy("transition_owner_cloud");
    await plantOwners(sql);
    const before = await fingerprintOf(sql);
    const run = await move(sql, "cloud");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect((run.error as TransitionRefused).lines).toContainEqual(
      { what: "a table the map does not name for this store: the Cloud's catalog holds the product's tables only", n: HOSTILE.length });
    expect(inspect(run.error, { depth: 10 })).not.toMatch(/alice|drop table|forged/);
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("anything that is not the product's and hangs off a name an entry drops refuses a server too", async () => {
    const { sql } = await copy("transition_owner_view");
    await sql`create view kickstarts as select id, kickstart_at from mailboxes`;
    await sql`create table owners_refs (user_id uuid references credentials (user_id))`;
    const before = await fingerprintOf(sql);
    const run = await move(sql, "server");
    expect(run.error).toBeInstanceOf(TransitionRefused);
    expect((run.error as TransitionRefused).lines.map((l) => l.what)).toEqual(expect.arrayContaining([
      "a view reads something an entry drops",
      "a key from a table that is not the product's points at something an entry drops",
    ]));
    expect(run.lines.join("\n")).toContain(`"kickstarts", refuses the transition`);
    expect(await fingerprintOf(sql)).toEqual(before);
  });
});

describe.skipIf(!PG_UP)("a transition that does not hold", () => {
  it("a red check after the last entry rolls everything back: the store and both ledgers are as they were", async () => {
    const { sql } = await copy("transition_red");
    const before = await fingerprintOf(sql);
    // Four faults no entry makes: a row lost, a counter's number changed, a mark moved, a ledger row gone.
    const run = await move(sql, "server", {
      afterEntries: async (tx) => {
        await tx.execute(dsql`delete from mailbox_folders where ctid = (select min(ctid) from mailbox_folders)`);
        await tx.execute(dsql`update account_counters set failures = failures + 1 where key like 'user:%'`);
        await tx.execute(dsql`update pass_progress set done_at = done_at + interval '1 second' where job = 'kickstart'`);
        await tx.execute(dsql.raw(`delete from "drizzle_cloud"."__drizzle_migrations" where created_at = ${readWindow("cloud")[2]!.when}`));
      },
    });
    expect(run.error).toBeInstanceOf(TransitionFailed);
    const red = (run.error as TransitionFailed).at.lines!.map((l) => l.what);
    for (const check of ["count against the map's formula / mailbox_folders", "accounts whose sixteen figures differ from before",
      "counters whose numbers changed in the move", "rows that differ from the marks they were written from",
      "the ledger gained the window's entries and no other / cloud", "entries not recorded once with their hash and stamp / cloud"]) {
      expect(red.some((l) => l.startsWith(check)), check).toBe(true);
    }
    expect(await fingerprintOf(sql)).toEqual(before);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("at-old-head");
  });

  it("a failing Cloud entry rolls the mail entries back with it, and its error carries no row", async () => {
    const { sql } = await copy("transition_cloud_fails");
    const before = await fingerprintOf(sql);
    // The counters' move, run a second time inside 0101: a duplicate key whose DETAIL quotes the key.
    const cloud = editedJournal(CLOUD_JOURNAL, "0101_account_counters", (text) => {
      const move = /-- @account_counters_move_user_keys\n([\s\S]*?);\n--> statement-breakpoint/.exec(text)![1]!;
      // A function, because the statement ends in `$'`, which a replacement string would expand.
      return text.replace("-- @account_counters_move_mailbox_keys",
        () => `-- @account_counters_move_user_keys_again\n${move};\n--> statement-breakpoint\n-- @account_counters_move_mailbox_keys`);
    });
    const run = await move(sql, "server", { journals: { mail: MAIL_JOURNAL, cloud } });
    expect(run.error).toBeInstanceOf(TransitionFailed);
    expect((run.error as TransitionFailed).at).toMatchObject({
      stage: "entry", entry: "cloud 0101_account_counters", step: "account_counters_move_user_keys_again",
      sqlState: "23505", constraint: "account_counters_pk",
    });
    // Nothing of the driver's error travels: not the key, not the account, not the statement.
    const all = `${inspect(run.error, { depth: 10 })}\n${run.lines.join("\n")}`;
    expect(all).not.toContain(planted.main.userId);
    expect(all).not.toContain(planted.main.accountId);
    expect(all).not.toMatch(/Key \(|already exists|INSERT INTO/i);
    expect((run.error as { cause?: unknown }).cause).toBeUndefined();
    expect(run.events.filter((e) => e.type === "entry").map((e) => (e as { name: string }).name)).toContain("0205_calendar");
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("a sealed value the key ring cannot open is red, and nothing is committed", async () => {
    const { sql } = await copy("transition_sealed");
    const before = await fingerprintOf(sql);
    // The ring holds version 1; one mailbox's secret says it was sealed under version 2.
    await sql`update mailbox_credentials set key_version = 2, secret_enc = 'v2:c2VjcmV0' where mailbox_id = ${planted.other.mailboxId}`;
    const lacking = await move(sql, "server");
    expect(lacking.error).toBeInstanceOf(TransitionFailed);
    expect((lacking.error as TransitionFailed).at.stage).toBe("sealed");
    expect((lacking.error as TransitionFailed).at.lines).toEqual([
      { what: "sealed values that do not open under the key ring / mailbox_credentials.secret_enc: expected 0, found 1", n: 1 }]);
    expect(lacking.lines.join("\n")).not.toMatch(/v2:|c2VjcmV0/);
    // No ring at all, on a store that holds sealed values: red on every place that holds one.
    const none = await move(sql, "server", { openSealed: NOTHING_OPENS });
    expect((none.error as TransitionFailed).at.lines!.length).toBe(Object.keys(planted.sealed).length);
    await sql`update mailbox_credentials set key_version = 1, secret_enc = 'v1:c2VjcmV0' where mailbox_id = ${planted.other.mailboxId}`;
    expect(await fingerprintOf(sql)).toEqual(before);
  });

  it("a connection cut in the middle leaves the store as it was, and the next run moves it", async () => {
    const { sql, url } = await copy("transition_cut");
    const before = await fingerprintOf(sql);
    const victim = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
    clients.push(victim);
    const run = await move(victim, "server", {
      afterEntries: async (tx) => {
        // Every entry has run and nothing is committed: a second connection ends this one.
        const [me] = await tx.execute(dsql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
        await sql`select pg_terminate_backend(${me!.pid})`;
        await tx.execute(dsql`select 1`);
      },
    });
    expect(run.error).toBeInstanceOf(TransitionFailed);
    expect(["lost", "check"]).toContain((run.error as TransitionFailed).at.stage);
    expect(run.events.some((e) => e.type === "committed")).toBe(false);
    expect(await fingerprintOf(sql)).toEqual(before);
    expect((await move(sql, "server")).error).toBeUndefined();
  });
});

describe.skipIf(!PG_UP)("the transition as a deployment reaches it: through the migrator and the setup", () => {
  const through = { kind: "server" as const, openSealed: sealedOpener(ring) };

  it("at the old heads with no word of what the store is, the migrator and the setup refuse and change nothing", async () => {
    const { sql, url } = await copy("transition_no_kind");
    const before = await fingerprintOf(sql);
    await expect(runMigrations(url)).rejects.toBeInstanceOf(TransitionNeedsRunner);
    await expect(setupProdDatabase(SETUP_AS.urlFor(url))).rejects.toThrow(/was not told what kind of store it is\. Nothing was changed/);
    const after = await fingerprintOf(sql);
    expect([after.counts, after.ledgers]).toEqual([before.counts, before.ledgers]);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("at-old-head");
  });

  it("the setup moves a server's store once, says so in its log, and a second setup applies nothing", async () => {
    const { sql, url } = await copy("transition_setup");
    const said: string[] = [];
    await setupProdDatabase(SETUP_AS.urlFor(url), { log: (m) => { said.push(m); }, transition: through });
    expect(said.filter((m) => m.startsWith("transition: committed"))).toHaveLength(1);
    expect(said.filter((m) => /^transition: (mail|cloud) 0[12]0\d_\w+ applied in \d+ ms$/.test(m))).toHaveLength(readWindow("mail").length + readWindow("cloud").length);
    expect(readWindow("mail").length + readWindow("cloud").length).toBe(14);
    expect(said.join("\n")).not.toMatch(/@iso\.test|v1:/);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("moved");
    const once = await fingerprintOf(sql);
    const again: string[] = [];
    const second = await setupProdDatabase(SETUP_AS.urlFor(url), { log: (m) => { again.push(m); }, transition: through });
    expect(second.appliedThisRun).toEqual([]);
    expect(again.some((m) => m.startsWith("transition:"))).toBe(false);
    expect((await fingerprintOf(sql)).ledgers).toEqual(once.ledgers);
  });

  it("an index an interrupted build of an earlier setup left not valid goes ahead of the migrator: the store moves, and the setup builds its own again", async () => {
    const { sql, url } = await copy("transition_setup_leftover");
    const cut = async (index: string): Promise<void> => {
      await sql`update pg_index set indisvalid = false where indexrelid = to_regclass(${`public.${index}`})`;
    };
    const valid = async (index: string): Promise<boolean | null> =>
      (await sql<{ valid: boolean }[]>`select indisvalid as valid from pg_index where indexrelid = to_regclass(${`public.${index}`})`)[0]?.valid ?? null;
    // Three leftovers of a setup that was cut: an index it builds after the journals, one 1.0's
    // setup built and 2.0's builds no more, and one mail 0201 drops by name and makes again.
    await sql`create index if not exists "audit_log_created_at_idx" on audit_log (created_at)`;
    await sql`create index if not exists "messages_subject_trgm_idx" on messages (subject)`;
    for (const index of ["audit_log_created_at_idx", "messages_subject_trgm_idx", "folder_state_pending_queue_idx"]) {
      await cut(index);
      expect(await valid(index), index).toBe(false);
    }
    const said: string[] = [];
    await setupProdDatabase(SETUP_AS.urlFor(url), { log: (m) => { said.push(m); }, transition: through });
    expect(said.filter((m) => m.includes("left not valid by an interrupted build")).sort()).toEqual([
      "audit_log_created_at_idx: left not valid by an interrupted build, dropped ahead of the migrator",
      "messages_subject_trgm_idx: left not valid by an interrupted build, dropped ahead of the migrator",
    ]);
    expect(said.filter((m) => m.startsWith("transition: committed"))).toHaveLength(1);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("moved");
    // The setup's own is built again after the journals; 0201 made its index again; the old one is gone.
    expect(await valid("audit_log_created_at_idx")).toBe(true);
    expect(await valid("folder_state_pending_queue_idx")).toBe(true);
    expect(await valid("messages_subject_trgm_idx")).toBeNull();
  });

  it("an index not valid that is nobody's of the setup refuses the setup before the first entry, by name, and nothing is changed", async () => {
    const { sql, url } = await copy("transition_setup_stranger");
    await sql`create index "an_operators_idx" on mailboxes (address)`;
    await sql`update pg_index set indisvalid = false where indexrelid = 'public.an_operators_idx'::regclass`;
    const before = await fingerprintOf(sql);
    const said: string[] = [];
    await expect(setupProdDatabase(SETUP_AS.urlFor(url), { log: (m) => { said.push(m); }, transition: through }))
      .rejects.toThrow(/refused before its first entry and nothing was changed: an index on one of the product's tables is not valid/);
    expect(said).toContain(`transition: an index that is not valid, "an_operators_idx", refuses the transition`);
    expect(said.some((m) => /^transition: (mail|cloud) 0[12]0\d_\w+ applied/.test(m))).toBe(false);
    const after = await fingerprintOf(sql);
    expect([after.catalog, after.counts, after.ledgers]).toEqual([before.catalog, before.counts, before.ledgers]);
    expect((await sql`select indisvalid as valid from pg_index where indexrelid = 'public.an_operators_idx'::regclass`)[0]!.valid).toBe(false);
  });

  it("a session ended from outside while the entries stand uncommitted leaves the store as it was, and the next run moves it", async () => {
    const { sql, url } = await copy("transition_killed");
    const before = await fingerprintOf(sql);
    const killed = runMigrations(url, {
      transition: {
        ...through,
        afterEntries: async (tx) => {
          const [me] = await tx.execute(dsql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
          await sql`select pg_terminate_backend(${me!.pid})`;
          await tx.execute(dsql`select 1`);
        },
      },
    });
    await expect(killed).rejects.toThrow(/session holding the migration lock was lost|rolled back whole/);
    const after = await fingerprintOf(sql);
    expect([after.catalog, after.counts, after.ledgers]).toEqual([before.catalog, before.counts, before.ledgers]);
    await runMigrations(url, { transition: through });
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("moved");
  });

  it("an entry stamped at or below a recorded head is skipped for ever, without an error", async () => {
    const { sql, url } = await copy("transition_skipped");
    await runMigrations(url, { transition: through });
    // A later file stamped one below 0205's stamp: the ordinary migrator never applies it.
    const dir = mkdtempSync(join(tmpdir(), "ohmail-transition-late-"));
    folders.push(dir);
    cpSync(MAIL_JOURNAL.dir, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const last = journal.entries.at(-1)!;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when - 1, tag: "0206_planted_below_the_head" });
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
    writeFileSync(join(dir, "0206_planted_below_the_head.sql"), `CREATE TABLE "planted_below_the_head" (id int);`);
    await migrate(brandDialect(drizzle(sql), "pg"), { migrationsFolder: dir, migrationsSchema: MAIL_JOURNAL.migrationsSchema });
    expect((await sql`select to_regclass('public.planted_below_the_head') as t`)[0]!.t).toBeNull();
  });

  it("a store below 1.0.11's heads walks the 1.0 road to them first, then moves", async () => {
    const earlier = throwawayDb("transition_below");
    copies.push(earlier);
    const cut = [MAIL_JOURNAL, CLOUD_JOURNAL].map((spec) => {
      const road = readJournalOf(spec).filter((e) => e.when <= OLD_HEADS[spec.name as "mail" | "cloud"].when);
      return journalThrough(spec, road.at(-3)!.when);
    });
    try {
      await earlier.create(async (url) => {
        const client = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
        try {
          for (const c of cut) await migrate(brandDialect(drizzle(client), "pg"),{ migrationsFolder: c.spec.dir, migrationsSchema: c.spec.migrationsSchema });
        } finally { await client.end({ timeout: 5 }); }
      });
    } finally { for (const c of cut) c.dispose(); }
    const sql = postgres(earlier.url, { max: 2, onnotice: () => { /* quiet */ } });
    clients.push(sql);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("below-old-head");
    // Without the word it walks to the heads and stops there: a 1.0.11 store, which 1.0 starts on.
    await expect(runMigrations(earlier.url)).rejects.toBeInstanceOf(TransitionNeedsRunner);
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("at-old-head");
    await runMigrations(earlier.url, { transition: { kind: "server", openSealed: NOTHING_OPENS } });
    expect(await transitionState(brandDialect(drizzle(sql), "pg"), { cloud: true })).toBe("moved");
  }, MIGRATED_DB_SETUP_BUDGET_MS);
});
