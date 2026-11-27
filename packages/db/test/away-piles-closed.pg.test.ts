import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, awayResponders } from "@trafficflow/db";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { AWAY_ANSWERABLE_PILES, AWAY_PILES_DEFAULT } from "@trafficflow/core/away-scope";
import { brandDialect } from "../src/dialect/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `away_responders.piles` IS A CLOSED SET, AND THE DATABASE IS WHAT CLOSES IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * mail 0096. The write path is already closed in code — the settings validator admits members of
 * `AWAY_ANSWERABLE_PILES` and 400s anything else, and the settings control offers that same
 * constant — and that argument is the one the operator console's isolation sweep cannot check. It
 * sees constraints, not validators; and the argument stops being true the moment a second write
 * path exists, with nothing failing when it does.
 *
 * What makes it worth a constraint rather than a review note is which way an unhandled member
 * fails. The pile rule refuses a member it does not know, so a stored `ohmail/Quarantine` would not
 * cause a reply — but a stored member is also what the SURFACE reads to say what the responder is
 * doing, and a scope nobody enumerated has no true sentence. The database refusing it is what keeps
 * the stored value and the stated scope the same thing.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ────────────────────────────────────────────────────────
 *
 * The constraint's whole content is what REAL Postgres does with a value outside the set, and the
 * containment operator (`<@`) over a `text[]` is the part most worth reading off a server rather
 * than assuming. A green run against a database that never applied the migration would say nothing
 * at all, so the journal is applied here.
 *
 * ── AND THE SET IS READ FROM THE CODE, NOT RETYPED ──────────────────────────────────────────
 *
 * `AWAY_ANSWERABLE_PILES` is what the validator and the settings control both use. Retyping it here
 * would let the two drift in the direction that fails silently: a third pile added to the code and
 * not to the constraint is a setting that appears to save and is refused by the database at the
 * moment somebody presses Save.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");

/** A drizzle journal, as much of it as this file reads. */
interface Journal { entries: Array<{ idx: number; tag: string }> }

/**
 * THE JOURNAL AS IT STOOD JUST BEFORE ONE MIGRATION — selected by that migration's own TAG.
 *
 * It used to be `filter(idx <= 100)` with `length === full.length - 1` beside it, which is a
 * statement about the journal's LAST entry rather than about 0101, and it went red the day an
 * unrelated 0102 landed. Keyed on the tag, an entry after the one under test cannot move it.
 */
function stagedBefore(full: Journal, tag: string): { journal: Journal; idx: number } {
  const under = full.entries.find((e) => e.tag === tag);
  if (under === undefined) throw new Error(`journal has no entry tagged ${tag}`);
  return {
    journal: { ...full, entries: full.entries.filter((e) => e.idx < under.idx) },
    idx: under.idx,
  };
}

const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

const ACCT = randomUUID();

describe.skipIf(!PG_UP)("mail 0096/0101 — the away responder's pile scope, enforced by Postgres", () => {
  const dbName = `tf_away_piles_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
    await db.execute(sql`INSERT INTO accounts (id, name) VALUES (${ACCT}, 'away piles')`);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /**
   * One responder row for a fresh account, with the given piles — or the database's refusal.
   *
   * ── WRITTEN THROUGH DRIZZLE'S COLUMN-AWARE BUILDER, NOT A RAW `sql` FRAGMENT ───────────────
   *
   * The first version interpolated the array into a fragment (`VALUES (…, ${piles})`) and real
   * Postgres answered `malformed array literal: "INBOX"` for a single member and `syntax error at
   * or near ")"` for the empty one. A value in a raw fragment has NO COLUMN to take its type from,
   * so the driver serialises it however it likes; `.values({ piles })` knows the column is
   * `text[]` and converts accordingly. It is also the shape the settings save actually uses, so
   * this test now exercises the same serialisation production does.
   *
   * PGlite accepted the fragment. This is the assertion class that only appears against a real
   * server, which is the whole reason this file is a `.pg.test.ts`.
   */
  async function insertPiles(piles: string[] | null): Promise<string[]> {
    const acct = randomUUID();
    await db.insert(accounts).values({ id: acct, name: "a" });
    const [row] = await db.insert(awayResponders).values({
      accountId: acct,
      enabled: true,
      body: "Back Monday.",
      // `undefined` leaves the column out of the INSERT entirely, so the DEFAULT applies — which
      // is the case every existing row takes and a different statement from writing `{INBOX}`.
      ...(piles === null ? {} : { piles }),
    }).returning({ piles: awayResponders.piles });
    return row!.piles;
  }

  it("the constraint exists under the name the migration creates", async () => {
    const rows = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint WHERE conname = 'away_responders_piles_closed'`);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });

  /**
   * THE DEFAULT IS THE NARROW MEMBER, read off the server rather than from the schema file.
   *
   * This is the assertion that says what happens to a responder somebody has ALREADY switched on:
   * it answers the Ohbox and nothing else from this migration forward. Getting it wrong in the
   * wide direction is the defect the migration exists to close, so it is asserted against the
   * column and against the constant the rule reads.
   */
  it("a row that names no piles gets the Ohbox alone", async () => {
    expect(await insertPiles(null)).toEqual(["INBOX"]);
    expect([...AWAY_PILES_DEFAULT]).toEqual(["INBOX"]);
  });

  it("every member of the offered set is accepted — the constraint is not narrower than the code", async () => {
    for (const pile of AWAY_ANSWERABLE_PILES) {
      const stored = await insertPiles([pile]).catch((err: unknown) => {
        throw new Error(`the database refused '${pile}', which the settings save writes: ${String(err)}`);
      });
      expect(stored).toEqual([pile]);
    }
    expect(await insertPiles([...AWAY_ANSWERABLE_PILES])).toEqual([...AWAY_ANSWERABLE_PILES]);
  });

  /**
   * THE EMPTY ARRAY IS ACCEPTED, and it is the one arm of this constraint worth stating out loud.
   * Containment (`<@`) admits it, deliberately: a responder answering nobody is what unticking
   * every box means, the rule handles it by name, and refusing it here would 400 that save.
   */
  it("the empty array is accepted — a responder answering nobody is a state, not an error", async () => {
    expect(await insertPiles([])).toEqual([]);
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * MUTATION WATCHED RED: drop the `ADD CONSTRAINT` from `0096_away_piles.sql` and every insert
   * below succeeds — the column becomes free text in an array, the isolation census's
   * classification of it becomes an assertion about free text, and nothing else in the product
   * misbehaves, because the pile rule refuses an unknown member anyway. What breaks is the
   * surface: a stored scope nobody enumerated has no true sentence to state.
   */
  it("a pile OUTSIDE the offered set is refused by the database", async () => {
    for (const bad of [
      // The two folders no setting may reach: the durable "no" of a screening decision, and mail
      // the pipeline judged hostile. Refused HERE so a second write path cannot store one.
      ["ohmail/Screened"],
      ["ohmail/Quarantine"],
      // A member that is nearly right, which is the shape a hand-written request produces.
      ["inbox"],
      ["INBOX "],
      ["ohmail/reads"],
      ["ohmail/Receipt"],
      ["ohmail/Screeners"],
      // Free text, in an array, beside a legitimate member.
      ["INBOX", "Re: your invoice — see attached"],
      [""],
    ]) {
      await expect(insertPiles(bad), `piles=${JSON.stringify(bad)} was stored`)
        .rejects.toThrow(/away_responders_piles_closed|violates check constraint/i);
    }
  });

  /**
   * ══ THE 0101 BACKFILL, ACROSS THE MIGRATION IT BELONGS TO ═══════════════════════════════════
   *
   * Until 0101 the pile rule EXEMPTED `ohmail/Screener`: a responder set to `everyone` answered a
   * stranger waiting there whatever its `piles` held, because the audience owned that population.
   * 0101 removes the exemption, so the same stored row would silently stop answering those
   * strangers — a change to a standing order nobody asked for. The migration therefore adds the
   * member that keeps every `everyone` row doing exactly what it did.
   *
   * Asserted across the migration and not by re-running its UPDATE: the rows have to exist at
   * 0100 for the backfill to have anything to read, and at 0100 the CHECK still refuses the member
   * — so the ORDER inside the file (widen the constraint, then write) is part of what this proves.
   * A separate database, migrated in two stages from a journal truncated at 0100.
   */
  it("0101 adds the Screener to every `everyone` row and to no other", async () => {
    const stagedDb = `tf_away_0101_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const staged = join(mkdtempSync(join(tmpdir(), "away-0101-")), "drizzle");
    cpSync(MAIL_DIR, staged, { recursive: true });
    const journalPath = join(staged, "meta", "_journal.json");
    const full = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const { journal: upTo0100, idx } = stagedBefore(full, "0101_away_piles_wider");
    // Two readings of the staged journal, each failing on a different off-by-one: nothing at or
    // after the migration under test survives, and the entry immediately in front of it does —
    // a filter that dropped that one would migrate stage one to a schema this case never
    // describes, and the count assertion this replaces could see neither.
    expect(upTo0100.entries.some((e) => e.idx >= idx)).toBe(false);
    expect(upTo0100.entries.at(-1)!.idx).toBe(idx - 1);

    await admin.unsafe(`CREATE DATABASE "${stagedDb}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${stagedDb}`;
    const client2 = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const db2 = brandDialect(drizzle(client2), "pg");
      // STAGE ONE: everything up to 0100, where `piles` is closed over two members.
      writeFileSync(journalPath, JSON.stringify(upTo0100, null, 2));
      await migrate(db2, { migrationsFolder: staged, migrationsSchema: "drizzle_mail" });

      const wide = randomUUID();
      const narrow = randomUUID();
      /* WRITTEN AS SQL, and it has to be. This database is STAGED AT 0100 and the schema module
         is HEAD's: drizzle's insert names every column of the table it is given, filling the ones
         the caller omitted with the `default` keyword, so a column added to `away_responders` by
         any later migration makes the statement 42703 against this stage — the head schema cannot
         describe an old database. Both inserts name only the columns present at this stage. */
      for (const [acct, audience] of [[wide, "everyone"], [narrow, "screened_in"]] as const) {
        await db2.execute(sql`INSERT INTO "accounts" ("id", "name") VALUES (${acct}::uuid, ${audience})`);
        await db2.execute(sql`
          INSERT INTO "away_responders" ("account_id", "enabled", "body", "audience", "piles")
          VALUES (${acct}::uuid, true, 'Back Monday.', ${audience}, ARRAY['INBOX']::text[])`);
      }
      // The member is UNREPRESENTABLE at this stage — which is why the backfill needs 0101's own
      // constraint replacement to run first.
      await expect(db2.update(awayResponders)
        .set({ piles: ["INBOX", "ohmail/Screener"] })
        .where(eq(awayResponders.accountId, wide)))
        .rejects.toThrow(/away_responders_piles_closed|violates check constraint/i);

      // STAGE TWO: 0101.
      writeFileSync(journalPath, JSON.stringify(full, null, 2));
      await migrate(db2, { migrationsFolder: staged, migrationsSchema: "drizzle_mail" });

      const after = async (acct: string): Promise<string[]> => {
        const [row] = await db2.select({ piles: awayResponders.piles }).from(awayResponders)
          .where(eq(awayResponders.accountId, acct));
        return row!.piles;
      };
      expect(await after(wide)).toEqual(["INBOX", "ohmail/Screener"]);
      // The narrow audience is untouched: the pass never answered a waiting stranger for it, and
      // that pair is the one the write doors refuse.
      expect(await after(narrow)).toEqual(["INBOX"]);
      // And RECEIPTS is added to nothing — receipts are not answered today, and ticking that box
      // is a decision its owner makes.
      expect(await after(wide)).not.toContain("ohmail/Receipts");
      expect(await after(narrow)).not.toContain("ohmail/Receipts");

      // IDEMPOTENT: the desktop engine replays this journal at every launch, so the statement runs
      // again against a row that already holds the member.
      await db2.execute(sql`
        UPDATE "away_responders" SET "piles" = array_append("piles", 'ohmail/Screener')
         WHERE "audience" = 'everyone' AND NOT ('ohmail/Screener' = ANY("piles"))`);
      expect(await after(wide)).toEqual(["INBOX", "ohmail/Screener"]);
    } finally {
      await client2.end({ timeout: 5 }).catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${stagedDb}"`).catch(() => {});
      rmSync(staged, { recursive: true, force: true });
    }
  }, 180_000);

  /** The bounce record's column exists and rests NULL — nobody is unreachable until one arrives. */
  it("`away_sender_state.undeliverable_at` exists and rests NULL", async () => {
    const acct = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, name) VALUES (${acct}, 'b')`);
    await db.execute(sql`
      INSERT INTO away_sender_state (account_id, sender, last_replied_at, last_text_hash)
      VALUES (${acct}, 'them@x.test', now(), 'h')`);
    const rows = await db.execute<{ undeliverable_at: Date | null }>(sql`
      SELECT undeliverable_at FROM away_sender_state WHERE account_id = ${acct}`);
    expect((rows as unknown as Array<{ undeliverable_at: Date | null }>)[0]!.undeliverable_at)
      .toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SELECTION ITSELF, WITHOUT A DATABASE

   The case above stages a journal and migrates it, so it can only run where Postgres is. The
   property that broke is about the SELECTION, not the migration, and it broke the day a later
   migration landed — which is a thing a fixture can do in a millisecond. So it is asserted here
   too, against the real journal plus one synthetic entry after it.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("`stagedBefore` is keyed on the migration under test, not on the journal's length", () => {
  const real = JSON.parse(readFileSync(join(MAIL_DIR, "meta", "_journal.json"), "utf8")) as Journal;

  it("selects everything strictly before the tagged migration", () => {
    const { journal, idx } = stagedBefore(real, "0101_away_piles_wider");
    expect(journal.entries.some((e) => e.idx >= idx)).toBe(false);
    expect(journal.entries.at(-1)!.idx).toBe(idx - 1);
  });

  /**
   * THE CONTROL. One more entry appended — which is what every later migration is — must not
   * change the selection by a single row. The assertion this replaces read
   * `length === full.length - 1`, and against this fixture it is off by exactly the number of
   * entries added after 0101.
   */
  it("one more journal entry after it changes the selection by nothing", () => {
    const grown: Journal = {
      ...real,
      entries: [...real.entries, { idx: Math.max(...real.entries.map((e) => e.idx)) + 1, tag: "9999_later" }],
    };
    const base = stagedBefore(real, "0101_away_piles_wider");
    const after = stagedBefore(grown, "0101_away_piles_wider");
    expect(after.idx).toBe(base.idx);
    expect(after.journal.entries.map((e) => e.tag)).toEqual(base.journal.entries.map((e) => e.tag));
    // And the old shape's own arithmetic, stated so the regression is readable: the journal has
    // grown past 0101, so "everything but the last entry" is no longer "everything before 0101".
    expect(grown.entries.filter((e) => e.idx <= 100).length)
      .not.toBe(grown.entries.length - 1);
  });
});
