import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adoptBaseline, adoptionVerdict, AdoptionRefused, readJournalOf, LEGACY_CUTOFF_WHEN,
  LEGACY_JOURNAL_WHENS,
  type JournalSpec,
} from "../src/baseline.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { catalogFingerprint } from "./_catalog.js";
import { replacedConstraints } from "./_replaced-constraints.js";

/** Migrations authored AFTER the frozen baseline cutoff — the set adoption does not claim and
 *  the migrator therefore still applies. Derived from the journal the migrator itself walks, so
 *  a new migration cannot leave these assertions describing a smaller repository than exists. */
const postCutoffOf = (spec: JournalSpec): number =>
  readJournalOf(spec).filter((e) => e.when > LEGACY_CUTOFF_WHEN).length;

/**
 * BASELINE ADOPTION, against real databases in every state it can meet one.
 *
 * `baseline-adoption.test.ts` covers the frozen cutoff and the derived object probe with no
 * database. This file covers the part that only a real Postgres can answer: the five cells of
 * the truth table, the idempotency of a re-run, and the one claim the whole design rests on —
 *
 *   **after adopting, the migrator applies exactly the migrations authored AFTER the split**
 *   — ZERO while none existed, and `0021_mailbox_address_unique` since one does.
 *
 * If that is false, `pnpm db:setup:prod` on the hosted service runs DDL over a live database.
 *
 * Every case builds its own database from scratch, with a random suffix rather than a fixed
 * name, because the `*.pg.test.ts` files share one docker Postgres and a fixed name lets two
 * runs drop each other's database mid-migration — which surfaces as an unexplained worker crash
 * rather than as a collision.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LEGACY_DIR = join(HERE, "..", "drizzle");
/** The `when`s the legacy FOLDER can still replay — its own retained metadata, read here. */
const FOLDER_WHENS: ReadonlySet<number> = new Set(
  (JSON.parse(readFileSync(join(LEGACY_DIR, "meta", "_journal.json"), "utf8")) as
    { entries?: Array<{ when: number }> }).entries?.map((e) => e.when) ?? [],
);
const MAIL: JournalSpec = {
  name: "mail", dir: join(HERE, "..", "..", "db-mail", "drizzle"), migrationsSchema: "drizzle_mail",
};
const CLOUD: JournalSpec = {
  name: "cloud", dir: join(HERE, "..", "drizzle-cloud"), migrationsSchema: "drizzle_cloud",
};

const ADMIN_URL = PG_TEST_URL;

const PG_UP = await realPgAvailable(ADMIN_URL);

type Db = PostgresJsDatabase<Record<string, never>>;

describe.skipIf(!PG_UP)("baseline adoption", () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const open: Array<ReturnType<typeof postgres>> = [];

  beforeAll(async () => { admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} }); }, 60_000);

  /**
   * CLEANUP GETS AN EXPLICIT TIMEOUT, for the reason `beforeAll` above already has one.
   *
   * This hook drops one database PER TEST, serially, and `drop database … with (force)` is dominated
   * by the server's file cleanup rather than by how much is in it. Measured on this machine
   * (2026-09-01): nine drops of EMPTY databases take **8.2 s**, against vitest's default 10 s hook
   * timeout — so the teardown was already inside two seconds of its limit while asserting nothing,
   * and adding one table to the schema was enough to push it over. The suite then reports
   * `Hook timed out in 10000ms` with all nine tests passing, which reads as a flake and is not one.
   *
   * 60 s, the same allowance `beforeAll` was deliberately given. Nothing here is an assertion — a
   * timeout that fires only means databases are leaked on the test server, which is worth being
   * generous about rather than sharp.
   */
  afterAll(async () => {
    for (const c of open) await c.end({ timeout: 5 }).catch(() => {});
    for (const db of created) {
      await admin?.unsafe(`drop database if exists "${db}" with (force)`).catch(() => {});
    }
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  /** A fresh, empty database nobody else can touch. */
  async function blank(): Promise<Db> {
    const name = `ohmail_adopt_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.unsafe(`create database "${name}"`);
    created.push(name);
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    const client = postgres(u.toString(), { max: 1, onnotice: () => {} });
    open.push(client);
    return brandDialect(drizzle(client), "pg") as Db;
  }

  /**
   * A database in exactly the state production is in: the pre-split journal, applied.
   *
   * THE FOLDER CANNOT BUILD IT ANY MORE, and the extra statement is what keeps this fixture
   * honest rather than making the constant wrong. `LEGACY_JOURNAL_WHENS` names 24 entries; the
   * folder holds 23 files, because the metering tables' own migration left with them. Every
   * database that actually took this path applied it and carries its ROW, so the fixture writes
   * that row rather than the list dropping the entry — the difference between "this database
   * lived through that era" (what adoption asks) and "this tree can still replay it" (what the
   * folder answers).
   *
   * Written with the migrator's own column shape and a hash that names itself, so a reader who
   * finds it in a dump can see it is a fixture and not a migration nobody has.
   */
  async function legacyShaped(): Promise<Db> {
    const db = await blank();
    await migrate(db, { migrationsFolder: LEGACY_DIR });
    const gone = LEGACY_JOURNAL_WHENS.filter((w) => !FOLDER_WHENS.has(w));
    expect(gone, "the legacy folder gained or lost a file — re-derive this fixture").toHaveLength(1);
    for (const when of gone) {
      await db.execute(sql`
        insert into "drizzle"."__drizzle_migrations" (hash, created_at)
        values (${`retired-migration-fixture-${when}`}, ${when})`);
    }
    return db;
  }

  const countRows = async (db: Db, schema: string): Promise<number> => {
    const r = await db.execute(sql`select count(*)::int as n
      from ${sql.raw(`"${schema}"."__drizzle_migrations"`)}`);
    return Number((r as unknown as Array<{ n: number }>)[0]!.n);
  };

  // ── CELL: virgin database ───────────────────────────────────────────────────────────────
  it("a VIRGIN database is `fresh`, and adoption writes nothing", async () => {
    const db = await blank();
    for (const spec of [MAIL, CLOUD]) {
      expect(await adoptionVerdict(db, spec)).toEqual({ kind: "fresh" });
      expect(await adoptBaseline(db, spec)).toEqual([]);
    }
    // …and the migrator is then free to build everything, which is what CI does on every run.
    await migrate(db, { migrationsFolder: MAIL.dir, migrationsSchema: MAIL.migrationsSchema });
    await migrate(db, { migrationsFolder: CLOUD.dir, migrationsSchema: CLOUD.migrationsSchema });
    /* COUNTED FROM THE JOURNALS, NOT RESTATED.
     *
     * These were two hand-maintained integers and a comment listing every migration by name,
     * which meant each new migration failed this test for the honest reason (a fresh database
     * really did gain an entry) and got "fixed" by editing the number — a census that only
     * ever agreed with reality because somebody kept typing. Four migrations landing in one
     * night left it four behind.
     *
     * The property worth asserting is not "there are exactly N" — nobody can check that by
     * reading — but "a fresh migrate applies EVERY authored migration and invents none".
     * `readJournalOf` reads the same `_journal.json` the migrator walks, so the two sides
     * cannot drift apart, and a migration authored without a journal entry (the half-landed
     * shape this repo keeps hitting) still fails here. */
    const mailAuthored = readJournalOf(MAIL).length;
    const cloudAuthored = readJournalOf(CLOUD).length;
    expect(mailAuthored, "the mail journal is empty — this census is reading nothing").toBeGreaterThan(30);
    expect(await countRows(db, "drizzle_mail")).toBe(mailAuthored);
    expect(await countRows(db, "drizzle_cloud")).toBe(cloudAuthored);
  }, 300_000);

  // ── CELL: legacy-complete + schema-complete ⇒ ADOPT. THE DECISIVE CASE. ─────────────────
  it("a LEGACY-shaped database adopts, and then applies EXACTLY the post-cutoff migrations", async () => {
    // THIS IS THE PRODUCTION DEPLOY PATH, and it is why the assertion changed shape.
    //
    // It used to claim the migrator applies ZERO entries after adoption, which was true while
    // every migration predated the split. `0021_mailbox_address_unique` is the first authored
    // after it, so the honest claim is now "adoption covers the pre-split bulk, and the
    // migrator applies exactly what came after" — a no-op assertion here would mean production
    // never receives that migration, which is the opposite of what is wanted.
    const db = await legacyShaped();
    const before = await catalogFingerprint(db);

    for (const spec of [MAIL, CLOUD]) {
      const verdict = await adoptionVerdict(db, spec);
      expect(verdict.kind).toBe("adopt");
    }
    // Adoption is still bounded by the cutoff: it claims the 21 pre-split mail entries and the
    // 7 cloud ones, and claims nothing above.
    const belowCutoff = (spec: JournalSpec): number =>
      readJournalOf(spec).filter((e) => e.when <= LEGACY_CUTOFF_WHEN).length;
    expect(await adoptBaseline(db, MAIL)).toHaveLength(belowCutoff(MAIL));
    expect(await adoptBaseline(db, CLOUD)).toHaveLength(belowCutoff(CLOUD));

    const mailRows = await countRows(db, "drizzle_mail");
    const cloudRows = await countRows(db, "drizzle_cloud");
    await migrate(db, { migrationsFolder: MAIL.dir, migrationsSchema: MAIL.migrationsSchema });
    await migrate(db, { migrationsFolder: CLOUD.dir, migrationsSchema: CLOUD.migrationsSchema });

    /* Exactly the post-cutoff mail entries ran, and no cloud entry did. Measured by row count
     * because `appliedThisRun` is not observable from `migrate` — the counts cannot lie.
     *
     * The count is DERIVED, not typed. It was `mailRows + 13` with a comment promising it would
     * be raised "deliberately and in the same diff" as each new migration; four migrations
     * landed in one night and it was not, because the promise lives in a comment and the
     * migrations were authored by four different slices. `readJournalOf` reads the same
     * `_journal.json` the migrator walks, so post-cutoff is exactly authored-minus-adopted and
     * the two cannot drift. The property under test is unchanged and still bites: adoption
     * claims the pre-split bulk, the migrator applies everything after it, and an entry that
     * ran twice or not at all still fails here. */
    expect(postCutoffOf(MAIL), "no post-cutoff mail migrations — this assertion would be vacuous")
      .toBeGreaterThan(0);
    expect(await countRows(db, "drizzle_mail")).toBe(mailRows + postCutoffOf(MAIL));
    /* The cloud side used to assert NOTHING ran — true only while every cloud migration
     * predated the cutoff. `0007_staff_users` is the first authored after it, so a cloud entry
     * running here is now the correct behaviour and asserting zero would demand production
     * never receive it. Same derivation as the mail side, so neither can silently drift. */
    expect(await countRows(db, "drizzle_cloud")).toBe(cloudRows + postCutoffOf(CLOUD));

    // …and the SCHEMA moved by exactly those migrations and nothing else. An adoption that
    // silently re-ran a pre-split entry would show up here as extra churn.
    const after = await catalogFingerprint(db);
    const gained = after.filter((l) => !before.includes(l));
    /**
     * WHAT "REMOVE" MEANS, and the one shape that is not a removal.
     *
     * Postgres cannot amend a CHECK in place, so a migration that changes what a constraint SAYS
     * drops it and re-adds it under the same name — cloud 0011 does exactly that to the ledger's
     * two reason-vocabulary CHECKs, to admit the trial bounty's `trial_grant`. The frozen line
     * does not survive; the OBJECT does.
     *
     * So a lost line is forgiven only when a constraint of the same identity is present
     * afterwards, which is checked here rather than assumed. A migration that drops a constraint
     * and never re-adds it still fails, and so does one that drops an index or a table — the
     * forgiveness reaches constraint lines, FUNCTION lines, and nothing else.
     *
     * FUNCTION lines joined for cloud 0013, which is the same shape through `CREATE OR REPLACE`:
     * it rewrites the refund-origin trigger's function to cap a refund at the debit it reverses,
     * so the old body's line does not survive while the function (and the trigger dispatching to
     * it) does. A migration that DROPPED the function outright still fails — no same-identity
     * line exists afterwards. `journal-split.pg.test.ts` additionally pins the amended set by
     * NAME (`AMENDED_FUNCTIONS`), so this looser same-identity forgiveness is not the only gate.
     *
     * ── A COLUMN'S NULLABILITY IS THE THIRD AMENDMENT KIND ──────────────────────────────────────
     *
     * `ALTER COLUMN … DROP NOT NULL` rewrites one FIELD of one line — `null=NO` becomes `null=YES` —
     * so a census that only asks "is every frozen line still present" reads a nullability change as
     * a REMOVED COLUMN. Mail 0095 does exactly that to `outbound_sends.draft_id`, so a person can
     * discard a draft whose send is definitively over while the ledger keeps the record of the
     * attempt, and this file was red on it with the sentence "adoption must not remove anything".
     *
     * The forgiveness for a COLUMN is NARROWER than the one above rather than looser: a lost line is
     * forgiven only when a line identical in EVERY OTHER FIELD is present afterwards — same table,
     * same ordinal position, same name, same type, same default, same generated-ness, same length
     * and precision — with `null=` masked and nothing else. So a column that DISAPPEARS still fails,
     * one whose TYPE is rewritten under a reader's feet still fails, and one dropped and re-added at
     * the END of the table (a different ordinal, which reorders every reader's `SELECT *`) still
     * fails. `journal-split.pg.test.ts` pins the amended column by NAME (`AMENDED_COLUMNS`), so here
     * too the same-identity reading is not the only gate.
     */
    const identity = (l: string) =>
      (/^(CONSTRAINT [a-z_]+ [a-z_]+) /.exec(l)?.[1] ?? /^(FUNCTION [a-z_]+) /.exec(l)?.[1]) ?? null;
    /** `COLUMN t.4 c uuid null=NO default=- …` → the same line with `null=` masked out. */
    const columnExceptNullability = (l: string): string | null =>
      /^COLUMN [a-z_]+\.\d+ /.test(l) ? l.replace(/ null=(YES|NO) /, " null=? ") : null;
    /* A RENAMED REPLACEMENT IS THE FOURTH AMENDMENT KIND, and the first the identity rule above
       cannot see: mail 0118 drops 28 single-column foreign keys and re-adds each as a composite
       one under a NEW name, so neither the line nor its `CONSTRAINT <table> <name>` identity
       survives. Forgiven only where the migration SQL itself pairs the drop with an add on the
       same table AND that successor is on the server — `_replaced-constraints.ts` derives the
       pairs. A drop with no successor still fails, and so does a successor the server lacks. */
    const REPLACED = replacedConstraints([MAIL.dir, CLOUD.dir], LEGACY_CUTOFF_WHEN);
    /* A DROPPED GENERATION EXPRESSION IS THE FIFTH (mail 0140): `body_tsv` keeps its name, ordinal,
       type and values and stops being generated. Forgiven only for a column a post-cutoff
       migration's own SQL names in `ALTER COLUMN … DROP EXPRESSION`, when the line after is the
       same with both generation fields masked and reads plain; the trigger is asserted below. */
    const droppedExpressions = new Set<string>();
    for (const entry of readJournalOf(MAIL).filter((e) => e.when > LEGACY_CUTOFF_WHEN)) {
      const text = readFileSync(join(MAIL.dir, `${entry.tag}.sql`), "utf8").replace(/^\s*--[^\n]*$/gm, "");
      for (const m of text.matchAll(/ALTER TABLE "([a-z_]+)" ALTER COLUMN "([a-z_]+)" DROP EXPRESSION/gi)) {
        droppedExpressions.add(`${m[1]}.${m[2]}`);
      }
    }
    expect([...droppedExpressions], "a second dropped expression is a decision, not a drift").toEqual(["message_bodies.body_tsv"]);
    const exceptGeneration = (l: string): string =>
      l.replace(/ gen=\S+ genexpr=.*? len=(\S+) prec=(\S+)$/, " gen=? genexpr=? len=$1 prec=$2");
    const generationDropped = (l: string): boolean => {
      const m = /^COLUMN ([a-z_]+)\.\d+ ([a-z_]+) /.exec(l);
      if (!m || !droppedExpressions.has(`${m[1]}.${m[2]}`)) return false;
      return after.some((a) => exceptGeneration(a) === exceptGeneration(l) && / gen=NEVER genexpr=- len=/.test(a));
    };
    const presentAfter = new Set(after.map(identity).filter((x): x is string => x !== null));
    const columnsAfter = new Set(
      after.map(columnExceptNullability).filter((x): x is string => x !== null),
    );
    const lost = before.filter((l) => {
      if (after.includes(l)) return false;
      const col = columnExceptNullability(l);
      if (col !== null) return !columnsAfter.has(col) && !generationDropped(l);
      const id = identity(l);
      if (id === null) return true;
      if (presentAfter.has(id)) return false;
      const successor = REPLACED.get(id);
      return successor === undefined || !presentAfter.has(successor);
    });
    expect(lost, "adoption must not remove anything").toEqual([]);
    // The column a dropped expression leaves plain is kept by its trigger, never by the app.
    expect(after.filter((l) => l.startsWith("TRIGGER message_bodies message_bodies_body_tsv_tg ")
      && l.includes("BEFORE INSERT OR UPDATE OF text")), "0140's trigger keeps body_tsv").toHaveLength(1);
    /* WHAT THE POST-CUTOFF MIGRATIONS BUILD, DERIVED FROM THEIR OWN SQL.
     *
     * This was `expect(gained).toHaveLength(87)` above a paragraph naming what each migration
     * contributed — 0023's four columns, 0031's two whole tables, and so on. The intent was
     * right and the mechanism was not: the number is only a census while somebody re-derives
     * it, and four migrations landing in one night left it fifty lines behind with nobody
     * able to tell whether the delta was those four or a defect riding along with them.
     *
     * So the SQL is asked instead. Every table a post-cutoff migration CREATEs must appear in
     * the catalog delta, and every column it ADDs must appear against its own table — the same
     * "derived from the journal SQL rather than hand-maintained" rule `baselineObjects` already
     * follows for the baseline half. A migration that ships three of its four columns still
     * fails, which was the property the paragraph was protecting, and it now holds for
     * migrations nobody has read yet. */
    const declared = { tables: new Set<string>(), columns: new Set<string>() };
    for (const entry of readJournalOf(MAIL).filter((e) => e.when > LEGACY_CUTOFF_WHEN)) {
      const text = readFileSync(join(MAIL.dir, `${entry.tag}.sql`), "utf8")
        .replace(/^\s*--[^\n]*$/gm, "");
      for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/gi)) {
        declared.tables.add(m[1]!);
      }
      /* PER STATEMENT, because a lazy match across the whole file crosses boundaries: this
       * file's `ALTER TABLE "message_instances"` and a later `ALTER TABLE "messages" ADD
       * COLUMN "auth_verdict"` were read as one, inventing a column on the wrong table. Split
       * first, and take every ADD COLUMN within one statement so a multi-column ALTER counts
       * all of them. */
      for (const stmt of text.split(";")) {
        const table = /ALTER TABLE "([a-z_]+)"/i.exec(stmt)?.[1];
        if (!table) continue;
        for (const m of stmt.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"([a-z_]+)"/gi)) {
          declared.columns.add(`${table}.${m[1]}`);
        }
      }
    }
    expect(declared.tables.size + declared.columns.size,
      "no post-cutoff DDL parsed — this assertion would be vacuous").toBeGreaterThan(10);

    /* THE ADOPTED TABLE: mail 0060's `refresh_tokens` is a guarded CREATE over a table the
     * LEGACY journal already built (the cloud half owned it before a later phase moved it), so on
     * exactly this scenario — a legacy-shaped database — the catalog GAINS nothing and that is
     * the migration working, not failing. Asserted as PRESENCE in the after-catalog instead, so
     * a 0060 that silently created nothing anywhere would still be caught by the fresh-database
     * suites (`journal-split.pg.test.ts` diffs the whole catalog; the sidecar's pairing e2e
     * writes through it). Pinned by name so a SECOND no-gain table is a deliberate decision. */
    const adoptedTables = new Set(["refresh_tokens"]);
    const afterText = after.join("\n");
    for (const t of adoptedTables) {
      expect(afterText, `the adopted table ${t} must exist after migration`)
        .toMatch(new RegExp(`COLUMN ${t}\\.`));
    }

    const gainedText = gained.join("\n");
    for (const t of declared.tables) {
      if (adoptedTables.has(t)) continue;
      expect(gainedText, `migration declared table ${t}, catalog did not gain it`)
        .toMatch(new RegExp(`COLUMN ${t}\\.`));
    }
    for (const c of declared.columns) {
      const [table, col] = c.split(".");
      expect(gainedText, `migration declared column ${c}, catalog did not gain it`)
        .toMatch(new RegExp(`COLUMN ${table}\\.\\d+ ${col} `));
    }
    // And the delta is not empty for a reason unrelated to those migrations.
    expect(gained.length).toBeGreaterThanOrEqual(declared.tables.size + declared.columns.size);
    // 0032's unique is the one line in its 17 that is a correctness claim rather than a name:
    // without it the claim's `ON CONFLICT` has nothing to serialize on, so it is asserted here
    // as well as in the fingerprint list.
    expect(gained.filter((l) => l.includes("unsubscribe_records_mailbox_list_uq"))).toHaveLength(1);
    expect(gained.filter((l) => l.includes("mailboxes_active_address_uq"))).toHaveLength(1);
    expect(gained.filter((l) => l.includes("message_bodies_html_cap"))).toHaveLength(1);
    for (const col of ["error_code", "error_detail", "failed_at", "retry_count"]) {
      expect(gained.filter((l) => l.startsWith(`COLUMN mailboxes.`) && l.includes(` ${col} `)),
        `0023 must add mailboxes.${col}`).toHaveLength(1);
    }
    // 0024: eight columns, three constraints, two indexes. The unique on `message_id` is the
    // one that carries meaning — it is what makes the API's `desired_seen` write and the
    // worker's `observed_seen` write land on ONE row.
    for (const col of ["id", "message_id", "desired_seen", "observed_seen", "last_set_by",
      "reconcile_status", "conflict", "updated_at"]) {
      expect(gained.filter((l) => l.startsWith("COLUMN flag_state.") && l.includes(` ${col} `)),
        `0024 must add flag_state.${col}`).toHaveLength(1);
    }
    expect(gained.filter((l) => l.startsWith("CONSTRAINT flag_state "))).toHaveLength(3);
    expect(gained.filter((l) => l === "CONSTRAINT flag_state flag_state_message_id_unique [u] " +
      "deferrable=false deferred=false :: UNIQUE (message_id)")).toHaveLength(1);
    // Mail 0181 adds the third: the read-state queue's pending rows.
    expect(gained.filter((l) => l.startsWith("INDEX flag_state "))).toHaveLength(3);
    // 0025: the one column that decides whether a mailbox is HEY-shaped on its next attach.
    expect(gained.filter((l) => l.startsWith("COLUMN mailboxes.") && l.includes(" kickstart_at ")),
      "0025 must add mailboxes.kickstart_at").toHaveLength(1);
    // 0026: the threading anchor and the two indexes it is useless without. The anchor must be
    // NULLABLE (a message with no Message-ID has to be storable) and its index must be UNIQUE
    // and account-leading — that pair IS the find-or-create race guard, so an adoption that
    // produced the column without the index would leave production splitting conversations.
    expect(gained.filter((l) => l.startsWith("COLUMN threads.") && l.includes(" root_message_id_header ")),
      "0026 must add threads.root_message_id_header").toEqual([
        "COLUMN threads.8 root_message_id_header text null=YES default=- gen=NEVER genexpr=- len=- prec=-/-",
      ]);
    expect(gained.filter((l) => l.includes("threads_account_root_header_uq") && l.includes("CREATE UNIQUE INDEX")),
      "0026 must add the ON CONFLICT anchor as a UNIQUE index").toHaveLength(1);
    expect(gained.filter((l) => l.includes("messages_account_message_id_header_idx")),
      "0026 must add the parent-lookup index").toHaveLength(1);
    // 0027: the organizer lease's two columns and the CHECK that closes the reason set. The
    // CHECK is asserted SEPARATELY from the columns because they fail differently and only one
    // of them is loud — a column that arrives without its constraint accepts whatever the write
    // site lets through and says nothing, which is the shape of the finding on `error_detail`.
    for (const col of ["disabled_reason", "takeover_authorized_at"]) {
      expect(gained.filter((l) => l.startsWith("COLUMN mailboxes.") && l.includes(` ${col} `)),
        `0027 must add mailboxes.${col}`).toHaveLength(1);
    }
    expect(gained.filter((l) => l.includes("mailboxes_disabled_reason_closed")),
      "0027 must add the CHECK, not just the column").toHaveLength(1);
    // 0028: physical identity — ten columns, four constraints, four indexes, plus one column each
    // on `attachments` and `messages`. Two of those objects carry the meaning and are asserted
    // individually, because an adoption that produced the table WITHOUT them would leave production
    // unable to evaluate the consent boundary at all:
    //  · the locator unique must include `uidvalidity`. Without the epoch, a UID number reused after
    //    a folder reset reads as already-known, so the new message's body is never fetched and the
    //    cursor is persisted past it — permanently and silently.
    //  · the primary unique must be PARTIAL. Non-partial it refuses the second instance the table
    //    exists to hold; absent, two rows can both claim one message's primary and `native_locator`
    //    and the table can disagree about where a message physically is.
    for (const col of ["id", "account_id", "mailbox_id", "message_id", "folder", "uidvalidity",
      "uid", "is_primary", "first_seen_at", "last_seen_at"]) {
      expect(gained.filter((l) => l.startsWith("COLUMN message_instances.") && l.includes(` ${col} `)),
        `0028 must add message_instances.${col}`).toHaveLength(1);
    }
    expect(gained.filter((l) => l.startsWith("CONSTRAINT message_instances "))).toHaveLength(4);
    expect(gained.filter((l) => l.startsWith("INDEX message_instances "))).toHaveLength(4);
    expect(gained.filter((l) => l === "CONSTRAINT message_instances message_instances_locator_uq [u] " +
      "deferrable=false deferred=false :: UNIQUE (mailbox_id, folder, uidvalidity, uid)"),
      "0028's locator unique must include the EPOCH").toHaveLength(1);
    expect(gained.filter((l) => l === "INDEX message_instances message_instances_primary_uq :: " +
      "CREATE UNIQUE INDEX message_instances_primary_uq ON public.message_instances " +
      "USING btree (message_id) WHERE is_primary"),
      "0028's primary unique must be PARTIAL").toHaveLength(1);
    expect(gained.filter((l) => l.startsWith("COLUMN attachments.") && l.includes(" content_sha256 ")),
      "0028 must add attachments.content_sha256").toHaveLength(1);
    expect(gained.filter((l) => l.startsWith("COLUMN messages.") && l.includes(" auth_verdict ")),
      "0028 must add messages.auth_verdict — slice 3 needs no DDL of its own").toHaveLength(1);
    // 0029: why a `connected` mailbox is not being synced. Two columns and a CHECK, asserted
    // SEPARATELY for 0027's reason and one more of its own: this column is projected
    // UNCONDITIONALLY by `MailboxService.toDTO` — that asymmetry with the failure four IS the
    // slice — so a column that adopted without its constraint would put an unconstrained TEXT
    // field on the wire to the account owner and to the admin console, and say nothing.
    for (const col of ["sync_blocked_reason", "sync_blocked_since"]) {
      expect(gained.filter((l) => l.startsWith("COLUMN mailboxes.") && l.includes(` ${col} `)),
        `0029 must add mailboxes.${col}`).toHaveLength(1);
    }
    expect(gained.filter((l) => l.includes("mailboxes_sync_blocked_reason_closed")),
      "0029 must add the CHECK, not just the column").toHaveLength(1);
    // 0030: the one-time re-screen marker. The column is asserted, and so is its NULLABILITY
    // with no default — which is the assertion rather than the name. A NOT NULL column, or one
    // defaulting to `now()`, would stamp EVERY mailbox in the deployment as already re-screened at
    // migration time: the pass would then skip all of them and the misrouted mail would stay in the
    // Ohbox behind a marker claiming it had been dealt with. That is the one way this migration can
    // silently defeat its own slice, and it is a schema fact, so it is checked here.
    expect(gained.filter((l) => l.startsWith("COLUMN mailboxes.") && l.includes(" sensitive_rescreen_at ")),
      "0030 must add mailboxes.sensitive_rescreen_at").toHaveLength(1);
    expect(gained.filter((l) => l.startsWith("COLUMN mailboxes.")
      && l.includes(" sensitive_rescreen_at ") && l.includes("null=YES default=-")),
      "0030's marker must be NULLABLE with NO default — a default marks every mailbox done")
      .toHaveLength(1);
    // 0033: the workflow-run claim stamp. Asserted with its NULLABILITY and absent default
    // for 0030's reason — the schema fact IS the correctness claim here. A `now()` default would
    // stamp every `pending` row at insert with a claim no worker ever made, so the reaper would
    // be reading a fabricated liveness signal; NOT NULL would erase the one thing NULL says,
    // which is "claimed by code older than this column" — the exact population the reaper has to
    // resolve through `created_at` and the exact population already stranded when this shipped.
    expect(gained.filter((l) => l.startsWith("COLUMN workflow_runs.") && l.includes(" claimed_at ")),
      "0033 must add workflow_runs.claimed_at").toHaveLength(1);
    expect(gained.filter((l) => l.startsWith("COLUMN workflow_runs.")
      && l.includes(" claimed_at ") && l.includes("null=YES default=-")),
      "0033's stamp must be NULLABLE with NO default — a default fabricates a claim")
      .toHaveLength(1);

    // Idempotent from here: a second pass changes nothing at all. This is the pass that would catch
    // 0028's `INSERT … SELECT` re-running without `ON CONFLICT DO NOTHING` — `openLocalDb` re-runs
    // both journals on every launch, so a non-idempotent data statement is a launch that fails.
    await migrate(db, { migrationsFolder: MAIL.dir, migrationsSchema: MAIL.migrationsSchema });
    expect(await countRows(db, "drizzle_mail")).toBe(mailRows + postCutoffOf(MAIL));
    expect(await catalogFingerprint(db)).toEqual(after);

    // The legacy table is left exactly as it was — it is the evidence, and it is the only
    // record that the pre-split journal ever ran.
    expect(await countRows(db, "drizzle")).toBe(24);
  }, 300_000);

  it("adoption is IDEMPOTENT — a second run writes nothing", async () => {
    const db = await legacyShaped();
    expect(await adoptBaseline(db, MAIL)).toHaveLength(21);
    expect(await adoptBaseline(db, MAIL)).toEqual([]);
    expect(await adoptBaseline(db, MAIL)).toEqual([]);
    expect(await countRows(db, "drizzle_mail")).toBe(21);
    expect(await adoptionVerdict(db, MAIL)).toEqual({ kind: "already_tracked", rows: 21 });
  }, 300_000);

  it("CONCURRENT adopters cannot produce duplicate rows", async () => {
    // drizzle's migrations table has no constraint of its own — `(id SERIAL, hash, created_at)` —
    // so two adopters racing a `WHERE NOT EXISTS` would both insert. The unique index adoption
    // creates on `created_at` is what makes this safe, and this is the case that proves it.
    const db = await legacyShaped();
    const results = await Promise.all([
      adoptBaseline(db, MAIL), adoptBaseline(db, MAIL), adoptBaseline(db, MAIL),
    ]);
    expect(results.flat()).toHaveLength(21);        // adopted exactly once, in total
    expect(await countRows(db, "drizzle_mail")).toBe(21);
  }, 300_000);

  // ── CELL: legacy ABSENT + objects PRESENT ⇒ THROW. The cell that is easy to miss. ───────
  it("REFUSES a populated database with no migrations table anywhere", async () => {
    const db = await legacyShaped();
    // Simulate an operator who dropped `__drizzle_migrations` as cleanup. Without this cell,
    // adoption reads "absent ⇒ fresh" and the migrator replays DDL over a live database.
    await db.execute(sql`drop schema drizzle cascade`);
    await expect(adoptionVerdict(db, MAIL)).rejects.toThrow(AdoptionRefused);
    await expect(adoptionVerdict(db, MAIL)).rejects.toThrow(/__drizzle_migrations` table anywhere/i);
    // It must say the objects ARE all there — that is what distinguishes this cell from a
    // half-built database, and it is what tells the reader the schema is not the problem.
    await expect(adoptionVerdict(db, MAIL)).rejects.toThrow(/86 of 86 pre-split objects/);
    // And the message has to be actionable — it names the remedy for a scratch database.
    await expect(adoptionVerdict(db, MAIL)).rejects.toThrow(/drop/i);
  }, 300_000);

  // ── CELL: legacy INCOMPLETE ⇒ THROW ────────────────────────────────────────────────────
  it("REFUSES a database that stopped part-way through the single-journal era", async () => {
    const db = await legacyShaped();
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at >= 1785833686206`);
    await expect(adoptionVerdict(db, CLOUD)).rejects.toThrow(/missing 3 of the 24 pre-split entries/);
  }, 300_000);

  // ── CELL: legacy COMPLETE + objects INCOMPLETE ⇒ THROW ─────────────────────────────────
  it("REFUSES when the journal is complete but an object it creates is gone", async () => {
    const db = await legacyShaped();
    // The exact shape of the failure this cell exists for: an invariant is missing, the journal
    // says everything ran, and adopting would record it as applied forever.
    //
    // THE INDEX IS ONE THE LEGACY FOLDER STILL CREATES, and that is not a detail: the object
    // list is DERIVED from the folder's own SQL (`baselineObjects`), so an index whose file has
    // left the tree is no longer demanded — dropping one of those would be a case that cannot
    // fail. `push_subscriptions_identity_uq` is the uniqueness a duplicate push endpoint
    // depends on, created in that era and standing today.
    await db.execute(sql`drop index "push_subscriptions_identity_uq"`);
    await expect(adoptionVerdict(db, CLOUD)).rejects.toThrow(/push_subscriptions_identity_uq/);
    await expect(adoptionVerdict(db, CLOUD)).rejects.toThrow(/would never run again/);
    // The MAIL half is unaffected — a fault in one half must not block the other.
    expect((await adoptionVerdict(db, MAIL)).kind).toBe("adopt");
  }, 300_000);

  it("REFUSES when a whole table is missing, and names it", async () => {
    const db = await legacyShaped();
    await db.execute(sql`drop table "tracker_events"`);
    await expect(adoptionVerdict(db, MAIL)).rejects.toThrow(/table tracker_events/);
  }, 300_000);

  // ── the legacy table found in an UNEXPECTED schema ──────────────────────────────────────
  it("finds the legacy table when it lives in `public`, not `drizzle`", async () => {
    // `setup-prod.ts` records that `__drizzle_migrations` "has lived in `public` in older
    // versions". If adoption only looked in `drizzle`, such a database would read as fresh and
    // the migrator would replay over it.
    const db = await legacyShaped();
    await db.execute(sql`alter table drizzle.__drizzle_migrations set schema public`);
    await db.execute(sql`drop schema drizzle`);
    expect((await adoptionVerdict(db, MAIL)).kind).toBe("adopt");
    expect(await adoptBaseline(db, MAIL)).toHaveLength(21);
  }, 300_000);
});
