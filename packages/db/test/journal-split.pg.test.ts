import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUD_JOURNAL, MAIL_JOURNAL } from "../src/journal-specs.js";
import { journalThrough } from "../src/testing-journal.js";
import { OLD_HEADS } from "../src/journal-heads.js";
import { LEGACY_CUTOFF_WHEN } from "../src/baseline.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { catalogFingerprint } from "./_catalog.js";
import { crossJournalConstraints, replacedConstraints } from "./_replaced-constraints.js";

/**
 * THE ONE PROOF THAT THE JOURNAL SPLIT WAS FAITHFUL.
 *
 * Stage 3 cut one migration journal into two — a publishable mail-domain half and a private
 * Cloud half — by moving 191 statements between folders. `journal-split.test.ts` proves none
 * were lost, that `when` is strictly increasing in each half, and that the closure rule holds.
 * None of that can see whether the two halves, run in order, produce the SAME DATABASE.
 * Statements can all be present, in order, on the correct side, and still build something
 * different.
 *
 * So: migrate the PRE-SPLIT journal into one database, the two new journals into another, and
 * diff everything the catalog knows — columns with their type, nullability, default, generated
 * expression and ordinal position; every constraint's definition and deferrability; every index
 * definition; every trigger; every function; every sequence.
 *
 * ── why the whole catalog and not a table/column probe ──
 *
 * Because the invariants of this schema are not columns. `users_email_unique_idx` IS "one
 * account per login address". `away_replies_message_uq` IS "at most one automatic reply per
 * message, ever" — the index a duplicate auto-reply is impossible BECAUSE of. A probe
 * that reads `information_schema.columns` — which is what `SCHEMA_MARKERS` and baseline adoption
 * use, correctly, for their own narrower purposes — is blind to every one of them.
 *
 * And the failure is silent in the worst possible way. Production ran the ORIGINAL journal, so
 * it keeps whatever the surgery dropped. Only databases created afterwards lack it: CI, every
 * developer, every isolated worker database, and eventually every local sidecar. Production and
 * fresh diverge permanently and nothing anywhere says so.
 *
 * ── why this test carries more weight than it looks like it should ──
 *
 * `drizzle-kit` and its `meta/*_snapshot.json` files were removed in this stage (see
 * The project's design notes §3a: the snapshots were already five migrations stale, and
 * leaving them would have made the first post-split `generate` emit `DROP TABLE` for 35 tables).
 * The other surviving check — `makeTestDb()` replaying the journal into PGlite while 2301 tests
 * write through the drizzle schema — catches a column the schema declares that the journal never
 * creates, and a NOT NULL column the journal creates that the schema omits. It does NOT catch a
 * missing index, trigger or constraint. **This file is the only thing that does.**
 *
 * The last case deliberately BREAKS a database and asserts the diff notices. A diff nobody has
 * seen fail is not evidence, and this repository has shipped a guard that printed a violation
 * and then reported success.
 *
 * ── THE COMPARISON IS DELIBERATELY FROZEN AT THE SPLIT ──
 *
 * The catalog diff below replays only the journal entries at or below {@link LEGACY_CUTOFF_WHEN}
 * on BOTH sides. That is the only window in which the question this file asks is even meaningful:
 * the legacy journal is frozen at 24 entries and can never gain another, while the two live
 * journals have grown 17 mail and 1 cloud migration since — so an unbounded comparison is asking
 * whether a frozen thing equals a moving one, and the answer is no by construction.
 *
 * Everything AFTER the cutoff is `baseline-adoption.pg.test.ts`'s subject, not this file's: it
 * proves that a database which adopted the frozen baseline then applies exactly the post-cutoff
 * migrations and no others, against a real Postgres, deriving the set from the same journals the
 * migrator walks. Between the two files the whole timeline is covered once each; duplicating the
 * post-cutoff half here is what produced the hand-maintained catalog list this bounding replaced.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LEGACY_DIR = join(HERE, "..", "drizzle");

/**
 * THE JOURNALS, BOUNDED TO THE SPLIT.
 *
 * Drizzle's migrator applies whatever the folder's `meta/_journal.json` lists, so replaying the
 * two live journals in full builds today's schema — which the frozen pre-split journal cannot
 * possibly match, and never will again. This writes a throwaway folder holding only the entries
 * at or below {@link LEGACY_CUTOFF_WHEN} (the `when` of the pre-split journal's last entry) and
 * the `.sql` files they name, which is exactly the population the legacy journal contains.
 *
 * The alternative was a hand-maintained list of "objects a later migration added", subtracted
 * from the `after` catalog before the diff. It stood here for a while and it rotted, in the way
 * such lists do: every new migration made the comparison legitimately fail, and the repair was to
 * paste more catalog lines into the list. Bounding the INPUT instead means nothing to maintain —
 * a migration authored tomorrow simply falls outside the window.
 */
function boundedToCutoff(dir: string, label: string): string {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const kept = journal.entries.filter((e) => e.when <= LEGACY_CUTOFF_WHEN);
  const out = mkdtempSync(join(tmpdir(), `ohmail-at-split-${label}-`));
  mkdirSync(join(out, "meta"), { recursive: true });
  writeFileSync(join(out, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) copyFileSync(join(dir, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  return out;
}

/** How many entries a journal holds in total, read from the journal the migrator itself walks. */
const entriesIn = (dir: string): number =>
  (JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as
    { entries: unknown[] }).entries.length;

/** How many entries each journal holds at or below the cutoff, read from the journal itself. */
const entriesAtCutoff = (dir: string): number =>
  (JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as
    { entries: Array<{ when: number }> }).entries.filter((e) => e.when <= LEGACY_CUTOFF_WHEN).length;
/*
 * THE 1.0 ROAD, as it stood at the old heads (`journalThrough`). The split is a property of that
 * road: its entries only ever added to the split's schema, which is what this file holds them
 * to. 2.0's entries retire objects on purpose and are held by the transition's own tests; read
 * here, every one of their drops would be a "removed object".
 */
const MAIL_CUT = journalThrough(MAIL_JOURNAL, OLD_HEADS.mail.when);
const CLOUD_CUT = journalThrough(CLOUD_JOURNAL, OLD_HEADS.cloud.when);
const MAIL_DIR = MAIL_CUT.spec.dir;
const CLOUD_DIR = CLOUD_CUT.spec.dir;

const ADMIN_URL = PG_TEST_URL;

/**
 * Throwaway databases with a RANDOM suffix, not fixed names.
 *
 * The `*.pg.test.ts` files share one docker Postgres, and a second checkout or suite may be
 * running against it at the same time. A fixed name would let two runs drop each other's
 * database mid-migration, which surfaces as an unexplained worker crash rather than as a
 * collision.
 */
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 12);
const DB_BEFORE = `ohmail_split_before_${SUFFIX}`;
/** The two journals BOUNDED to the cutoff — the only side the frozen `before` can be diffed against. */
const DB_AT_SPLIT = `ohmail_split_at_${SUFFIX}`;
/** The two journals IN FULL — today's schema, which the migrations-table census below counts. */
const DB_AFTER = `ohmail_split_after_${SUFFIX}`;

const PG_UP = await realPgAvailable(ADMIN_URL);

/**
 * CONSTRAINTS A POST-CUTOFF MIGRATION DELIBERATELY REPLACES — the one shape "post-cutoff work only
 * ADDS to the schema" cannot express, and it must not be answered by deleting that assertion.
 *
 * Postgres cannot amend a CHECK in place. A migration that has to change what a constraint SAYS
 * drops it and re-adds it under the same name, so the frozen catalog's line for it genuinely does
 * not survive into today's schema even though nothing was lost.
 *
 * The exemption is by CONSTRAINT IDENTITY (`CONSTRAINT <table> <name>`) and never by whole table,
 * and it is paired with the assertion below that a line of the SAME IDENTITY exists afterwards —
 * so a migration that DROPS one of these and forgets to re-add it still fails here, which is the
 * property the rule is protecting. Every entry is a claim that someone read both bodies.
 */
const AMENDED_CONSTRAINTS: readonly string[] = [
  /* EMPTY since mail 0118, and the emptying is the mechanism working. Its one entry was
     `outbound_sends_draft_id_drafts_id_fk`, amended in place by 0095 — and 0118 then REPLACED
     that key with a composite one under a new name, so the honouring check below rightly stopped
     finding it. A stale exemption is removed rather than loosened: the key is now carried by
     {@link REPLACED}, which asserts more, not less — the old name is gone AND the successor the
     SQL names is on the server. The list stays because the in-place shape does. */
];

/**
 * FUNCTIONS a post-cutoff migration deliberately replaces — the same rule as
 * {@link AMENDED_CONSTRAINTS}, arriving through `CREATE OR REPLACE FUNCTION` instead of a
 * drop-and-re-add.
 *
 * EMPTY today: every entry it held named a trigger function on a metering table, and those
 * left this schema with the tables. The list stays because the mechanism does — a replaced
 * body is invisible to a name probe, so the next one needs this exemption rather than a new
 * argument — and it is honoured below exactly like the constraint one: a line of the same
 * identity must exist afterwards with a genuinely different body, so a migration that DROPPED
 * the function still fails here.
 */
const AMENDED_FUNCTIONS: readonly string[] = [];

/**
 * COLUMNS a post-cutoff migration deliberately ALTERS IN PLACE — the third amendment kind, and
 * the first one this census met.
 *
 * `AMENDED_CONSTRAINTS` and `AMENDED_FUNCTIONS` both exist because an object can change while
 * keeping its name, and the frozen catalog's line for the old shape then genuinely does not
 * survive. A column is the same case and had simply never come up: `ALTER COLUMN … DROP NOT NULL`
 * changes `null=NO` to `null=YES` on one line, so a census that only asks "is every frozen line
 * still present" reads a nullability change as a REMOVED COLUMN.
 *
 * It is deliberately a per-column allowlist rather than a rule that ignores the `null=` field:
 * a column that genuinely disappears, or one whose TYPE is rewritten under the reader's feet,
 * must still fail here. The identity carries the table AND the ordinal position, so a column
 * dropped and re-added at the end of the table — which is a different thing, and one that
 * reorders every reader's `SELECT *` — does not satisfy an entry written for the original.
 */
const AMENDED_COLUMNS: readonly string[] = [
  /* Mail 0095: `outbound_sends.draft_id` becomes nullable, so a person can discard a draft whose
     send is over while the ledger keeps the attempt. Same table, same ordinal, same type — only
     `null=NO` becomes `null=YES`, which the honouring check below asserts is a real difference. */
  "COLUMN outbound_sends.4 draft_id",
  /* Cloud 0042: `login_tokens.user_id` becomes nullable for an unconfirmed desktop approval, and
     a CHECK keeps every other purpose bound. Same ordinal and type; `null=NO` becomes `null=YES`. */
  "COLUMN login_tokens.2 user_id",
  /* Mail 0140: `message_bodies.body_tsv` stops being generated and is kept by a trigger over the
     first stretch of characters of `text`. Same ordinal and type, every value kept; `gen=ALWAYS` and
     its expression become `gen=NEVER genexpr=-`. */
  "COLUMN message_bodies.7 body_tsv",
];

/**
 * CONSTRAINTS A POST-CUTOFF MIGRATION REPLACED UNDER A NEW NAME — the fourth amendment shape.
 * Derived from the migration SQL, never listed here: mail 0118 alone replaces 28 single-column
 * foreign keys with composite `(child_id, account_id)` ones, and 28 literals are a census only
 * while somebody re-derives them. A drop the SQL pairs with nothing still fails.
 */
const REPLACED = replacedConstraints([MAIL_DIR, CLOUD_DIR], LEGACY_CUTOFF_WHEN);

/** `COLUMN foo.4 bar uuid null=NO …` → `COLUMN foo.4 bar`. */
const columnIdentity = (line: string): string | null => {
  const m = /^(COLUMN [a-z_]+\.\d+ [a-z_]+) /.exec(line);
  return m ? m[1]! : null;
};

/** `CONSTRAINT credit_ledger foo [c] deferrable=… :: CHECK (…)` → `CONSTRAINT credit_ledger foo`. */
const constraintIdentity = (line: string): string | null => {
  const m = /^(CONSTRAINT [a-z_]+ [a-z_]+) /.exec(line);
  return m ? m[1]! : null;
};

/** `FUNCTION foo :: CREATE OR REPLACE FUNCTION …` → `FUNCTION foo`. */
const functionIdentity = (line: string): string | null => {
  const m = /^(FUNCTION [a-z_]+) /.exec(line);
  return m ? m[1]! : null;
};

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!PG_UP)("the two journals build exactly the schema the single journal built", () => {
  let admin: ReturnType<typeof postgres>;
  let before: string[];
  let atSplit: string[];
  let after: string[];
  let atSplitClient: ReturnType<typeof postgres>;
  let afterClient: ReturnType<typeof postgres>;
  const scratch: string[] = [];

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    for (const db of [DB_BEFORE, DB_AT_SPLIT, DB_AFTER]) {
      await admin.unsafe(`drop database if exists "${db}" with (force)`);
      await admin.unsafe(`create database "${db}"`);
    }

    // BEFORE: the pre-split journal, exactly as production took it.
    const b = postgres(urlFor(DB_BEFORE), { max: 1, onnotice: () => {} });
    try {
      await migrate(brandDialect(drizzle(b), "pg"), { migrationsFolder: LEGACY_DIR });
      before = await catalogFingerprint(brandDialect(drizzle(b), "pg"));
    } finally {
      await b.end({ timeout: 5 });
    }

    // AT THE SPLIT: the two journals bounded to the cutoff, MAIL FIRST — the order production
    // runs them in, and the order the closure rule makes mandatory. Separate migrations schemas,
    // so neither journal's bookkeeping can be mistaken for the other's. This is the side the
    // frozen `before` is diffed against.
    const mailAtSplit = boundedToCutoff(MAIL_DIR, "mail");
    const cloudAtSplit = boundedToCutoff(CLOUD_DIR, "cloud");
    scratch.push(mailAtSplit, cloudAtSplit);
    atSplitClient = postgres(urlFor(DB_AT_SPLIT), { max: 1, onnotice: () => {} });
    const atSplitDb = brandDialect(drizzle(atSplitClient), "pg");
    await migrate(atSplitDb, { migrationsFolder: mailAtSplit, migrationsSchema: "drizzle_mail" });
    await migrate(atSplitDb, { migrationsFolder: cloudAtSplit, migrationsSchema: "drizzle_cloud" });
    atSplit = await catalogFingerprint(atSplitDb);

    // AFTER: the same two journals IN FULL — today's schema. Not diffed against `before` (see the
    // header); it is what the migrations-table census and the named-invariant cases below read,
    // because both of those are questions about the journals as they stand now.
    afterClient = postgres(urlFor(DB_AFTER), { max: 1, onnotice: () => {} });
    const db = brandDialect(drizzle(afterClient), "pg");
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
    await migrate(db, { migrationsFolder: CLOUD_DIR, migrationsSchema: "drizzle_cloud" });
    after = await catalogFingerprint(db);
  }, 300_000);

  afterAll(async () => {
    MAIL_CUT.dispose();
    CLOUD_CUT.dispose();
    await atSplitClient?.end({ timeout: 5 }).catch(() => {});
    await afterClient?.end({ timeout: 5 }).catch(() => {});
    for (const db of [DB_BEFORE, DB_AT_SPLIT, DB_AFTER]) {
      await admin?.unsafe(`drop database if exists "${db}" with (force)`).catch(() => {});
    }
    await admin?.end({ timeout: 5 }).catch(() => {});
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("resolved a real catalog on all three sides", () => {
    // Guards against a fingerprint that silently returned nothing and made the diff below
    // vacuously true — which is the exact shape of failure this whole file exists to prevent.
    expect(before.length).toBeGreaterThan(600);
    expect(atSplit.length).toBeGreaterThan(600);
    expect(after.length).toBeGreaterThan(600);
    // ONE LINE READ IN FULL, so "resolved a catalog" means the definitions are there and not
    // just the names. `users_email_unique_idx` is chosen because the PRE-SPLIT journal creates
    // it — an index a post-cutoff migration adds would be absent from `before` and this
    // assertion would fail for a reason that is not about the fingerprint.
    expect(before.some((l) => l.startsWith("INDEX users users_email_unique_idx :: CREATE UNIQUE INDEX")),
      "the fingerprint carries no definition for a known unique index").toBe(true);
  });

  it("the catalogs are IDENTICAL, line for line", () => {
    const onlyBefore = before.filter((l) => !atSplit.includes(l));
    const onlyAfter = atSplit.filter((l) => !before.includes(l));
    expect(onlyBefore, "the split LOST these objects").toEqual([]);
    expect(onlyAfter, "the split INVENTED these objects").toEqual([]);
    // Ordering too, not just set membership — both are produced by the same sorted queries, so
    // a difference in order would mean a difference in ordinal positions or names.
    expect(atSplit).toEqual(before);
  });

  it("the bounding is REAL — the at-split databases are missing what the full journals add", () => {
    // If `boundedToCutoff` ever stopped filtering, the diff above would fail loudly rather than
    // silently — but if it filtered too hard, or the cutoff drifted upwards past the whole
    // journal, the diff would keep passing over a smaller and smaller pair of schemas. Both
    // journals must therefore hold entries on BOTH sides of the cutoff, and the full schema must
    // be strictly larger than the frozen one.
    const mailKept = entriesAtCutoff(MAIL_DIR);
    const cloudKept = entriesAtCutoff(CLOUD_DIR);
    expect(mailKept).toBeGreaterThan(0);
    expect(cloudKept).toBeGreaterThan(0);
    expect(mailKept).toBeLessThan(entriesIn(MAIL_DIR));
    expect(cloudKept).toBeLessThan(entriesIn(CLOUD_DIR));
    expect(after.length).toBeGreaterThan(atSplit.length);
    // Every line the frozen catalog has, today's schema still has: post-cutoff migrations ADD to
    // the split's schema, they do not rewrite it. A migration that dropped one would be caught
    // here rather than by the bounded diff, which cannot see past the cutoff by construction.
    //
    // With THREE named exceptions, and all are narrow — see AMENDED_CONSTRAINTS,
    // AMENDED_FUNCTIONS and AMENDED_COLUMNS. A CHECK cannot be amended in place, so a migration
    // that changes what one SAYS drops and re-adds it under the same name; a trigger function is
    // amended with `CREATE OR REPLACE`, same shape; and a column's nullability is altered in
    // place, which rewrites its one line. The line changes; the object does not go away.
    const missing = atSplit.filter((l) => !after.includes(l));
    const afterConstraints = new Set(
      after.map(constraintIdentity).filter((x): x is string => x !== null),
    );
    const unexplained = missing.filter((l) => {
      const cid = constraintIdentity(l);
      if (cid !== null) {
        if (AMENDED_CONSTRAINTS.includes(cid)) return false;
        const successor = REPLACED.get(cid);
        return successor === undefined || !afterConstraints.has(successor);
      }
      const fid = functionIdentity(l);
      if (fid !== null) return !AMENDED_FUNCTIONS.includes(fid);
      const colid = columnIdentity(l);
      if (colid !== null) return !AMENDED_COLUMNS.includes(colid);
      return true;
    });
    expect(unexplained, "post-cutoff work REMOVED these objects").toEqual([]);

    // And each exemption is honoured rather than merely claimed: the object it names must
    // still EXIST under that name, with a body that is genuinely different — otherwise the entry
    // is either covering a plain drop or is dead weight nobody has noticed.
    for (const [identityOf, ids] of [
      [constraintIdentity, AMENDED_CONSTRAINTS],
      [functionIdentity, AMENDED_FUNCTIONS],
      [columnIdentity, AMENDED_COLUMNS],
    ] as const) {
      for (const id of ids) {
        const frozen = atSplit.filter((l) => identityOf(l) === id);
        const now = after.filter((l) => identityOf(l) === id);
        expect(frozen, `${id}: not in the frozen catalog — the exemption is stale`).toHaveLength(1);
        expect(now, `${id}: a post-cutoff migration DROPPED it and never re-added it`).toHaveLength(1);
        expect(now[0], `${id}: unchanged — the exemption is dead weight`).not.toBe(frozen[0]);
      }
    }
  });

  it("every REPLACED constraint is present under its new name, and gone under the old one", () => {
    /* THE DECLARATION THE OLD ONE BECAME. This file used to name single-column foreign keys the
       server no longer has; mail 0118 replaced them, so the claim is re-derived onto the keys the
       server DOES have rather than dropped. Both halves, because forgiving the old name without
       proving the new one is the plain drop the exemption must never cover.
       TWO KEYS ARE AUTHORED IN BOTH JOURNALS (`refresh_tokens`, mail 0060 and the cloud auth
       ceremony), so whichever runs second re-adds what 0118 dropped and the absence half is not
       true of them. Narrowed to the half still measured true and derived, never listed: the
       successor is asserted for all of them, and the overlap is a gap row, not a skip. */
    expect(REPLACED.size, "no replacements derived — this case is vacuous").toBeGreaterThan(0);
    const ids = new Set(after.map(constraintIdentity).filter((x): x is string => x !== null));
    const bothJournals = crossJournalConstraints([MAIL_DIR, CLOUD_DIR]);
    for (const [old, now] of REPLACED) {
      expect(ids.has(now), `${now}: the migration SQL adds it, the server does not have it`).toBe(true);
      if (bothJournals.has(old.split(" ")[2]!)) continue;
      expect(ids.has(old), `${old}: replaced by ${now}, yet still on the server`).toBe(false);
    }
    // The exclusion is a CLAIM about the overlap, so it is measured rather than assumed.
    expect([...bothJournals].sort(), "the cross-journal overlap moved").toEqual(
      ["refresh_tokens_session_id_sessions_id_fk", "refresh_tokens_user_id_users_id_fk"],
    );
  });

  /**
   * The invariants that have no undo, named individually.
   *
   * The line-for-line diff above already covers these, but it covers them as anonymous lines
   * in a list of 700. If a future change to the fingerprint query ever narrows what it sees,
   * these four keep failing for a reason a reader can act on.
   */
  it.each([
    ["INDEX users users_email_unique_idx", "one account per login address"],
    ["INDEX push_subscriptions push_subscriptions_identity_uq", "one subscription per endpoint"],
    ["INDEX mailboxes mailboxes_active_address_uq", "one live mailbox per address per account"],
    ["INDEX away_replies away_replies_message_uq", "at most one automatic reply per message"],
  ])("carried %s across the split (%s)", (prefix) => {
    expect(after.some((l) => l.startsWith(prefix)), `${prefix} is MISSING after the split`).toBe(true);
  });

  it("both migrations tables are populated, and the legacy one was never created", async () => {
    const db = brandDialect(drizzle(afterClient), "pg");
    const counts = await db.execute(sql`
      select (select count(*)::int from drizzle_mail.__drizzle_migrations) as mail,
             (select count(*)::int from drizzle_cloud.__drizzle_migrations) as cloud,
             (select count(*)::int from information_schema.tables
               where table_schema = 'drizzle' and table_name = '__drizzle_migrations') as legacy`);
    const row = (counts as unknown as Array<{ mail: number; cloud: number; legacy: number }>)[0]!;
    /* COUNTED FROM THE JOURNALS. These were two literals above a comment listing every
     * migration by name, so each new one failed here for the honest reason — a fresh database
     * really did gain an entry — and was "fixed" by editing the number. The property is not
     * "there are exactly N", which nobody can check by reading, but "the two-journal path
     * applies every authored migration and invents none", and `readJournalOf` reads the same
     * `_journal.json` the migrator walks so the two sides cannot drift. A migration authored
     * without a journal entry still fails here. */
    const mailAuthored = entriesIn(MAIL_DIR);
    const cloudAuthored = entriesIn(CLOUD_DIR);
    expect(mailAuthored, "the mail journal is empty — this count is reading nothing")
      .toBeGreaterThan(30);
    expect(Number(row.mail)).toBe(mailAuthored);
    expect(Number(row.cloud)).toBe(cloudAuthored);
    // A database built by the two-journal path has NO legacy table. That is what makes the
    // legacy table meaningful evidence for baseline adoption: its presence means, and can only
    // mean, that this database took the pre-split journal.
    expect(Number(row.legacy)).toBe(0);
  });

  /**
   * THE POSITIVE CONTROL — the diff is proven to fail.
   *
   * `users_email_unique_idx` is dropped from the already-verified database and the fingerprint
   * retaken. If the diff cannot see a missing unique index then it cannot see a lost statement
   * either, and every assertion above is decoration.
   *
   * Done by dropping the object rather than by editing a migration file: it is deterministic,
   * it leaves no chance of a half-edited journal in the tree, and it exercises the same
   * comparison the real case would.
   *
   * Sabotage lands on the database, because that is the one the identity assertion
   * reads. Breaking the full-journal database would prove that a diff nobody runs can fail.
   */
  it("DETECTS a dropped index — so 'identical' above means the diff looked", async () => {
    const db = brandDialect(drizzle(atSplitClient), "pg");
    const [{ def }] = (await db.execute(sql`
      select indexdef as def from pg_indexes
       where schemaname = 'public' and indexname = 'users_email_unique_idx'`)
    ) as unknown as Array<{ def: string }>;
    expect(def, "the index this control sabotages does not exist").toContain("CREATE UNIQUE INDEX");
    await db.execute(sql`drop index "users_email_unique_idx"`);
    const sabotaged = await catalogFingerprint(db);

    expect(sabotaged).not.toEqual(before);
    const lost = before.filter((l) => !sabotaged.includes(l));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("users_email_unique_idx");

    // …and it is restorable — RE-CREATED FROM THE CATALOG'S OWN DEFINITION rather than from a
    // copy of the migration's SQL, so the restore cannot quietly differ from what was dropped.
    await db.execute(sql.raw(def));
    expect(await catalogFingerprint(db)).toEqual(before);
  }, 60_000);
});
