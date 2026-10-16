import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@trafficflow/db/admin";
import { MAIL_JOURNAL } from "@trafficflow/db/journal";
import { REQUIRE_PG_ENV, journalDrift, realPgAvailable } from "@trafficflow/db/testing";
import { DB_URL, refuseDriftedSharedDb } from "./_workerdb.js";

/**
 * A DATABASE WHOSE MIGRATION JOURNAL IS NOT THIS TREE'S IS REFUSED, NOT MEASURED.
 *
 * `trafficflow_test` on the test server is long-lived and shared by every `*.pg.test.ts` in the
 * workspace. The migrator applies only a migration stamped strictly after the latest one a
 * database has already recorded, so a run that migrated it from a different tree leaves a
 * watermark: from then on, every migration THIS tree adds below that watermark is recorded as
 * applied without ever being run, and nothing raises. The suites that follow assert against
 * columns and constraints that were never created, and each failure names whatever that test was
 * about rather than the database.
 *
 * The isolated worker databases have had a drift check for a while and answer it by RECREATING.
 * The shared one cannot be dropped by whoever notices first, so the two entry points that reach
 * it — `realPgAvailable` for the `*.pg.test.ts` files, `refuseDriftedSharedDb` for the worker's
 * harness — REFUSE instead. One implementation (`journalDrift`), two policies, and this file is
 * the evidence for both halves of each: the refusal fires on a drifted database, AND an ordinary
 * one is admitted.
 *
 * ── WHY THIS RUNS ON A DATABASE OF ITS OWN ────────────────────────────────────────────────
 *
 * The thing under test is "a poisoned journal is refused", and the only honest fixture for it is
 * a poisoned journal. Writing one into the shared database would hand every other file on the
 * server exactly the failure this exists to prevent, so this file creates its own database,
 * poisons that, and drops it when it is done. The shared `trafficflow_test` is read by nothing
 * here and written by nothing here.
 */

const PRIVATE_DB = "trafficflow_box_drift_refusal";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const ADMIN_URL = withDatabase(DB_URL, "postgres");
const PRIVATE_URL = withDatabase(DB_URL, PRIVATE_DB);

/**
 * Is the server up? DELIBERATELY not `realPgAvailable`, which is the function under test: asking
 * it would make this file skip on exactly the condition it exists to measure.
 */
async function serverUp(): Promise<boolean> {
  const c = postgres(ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await c`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await c.end({ timeout: 2 }).catch(() => {});
  }
}

const UP = await serverUp();

/** This tree's own latest mail migration, and the sha256 the migrator stores for one of them. */
function mailJournalEntries(): Array<{ when: number; tag: string }> {
  const j = JSON.parse(
    readFileSync(join(MAIL_JOURNAL.dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number; tag: string }> };
  return j.entries;
}

const ENTRIES = mailJournalEntries();
const TREE_MAX = Math.max(...ENTRIES.map((e) => e.when));
/** A stamp NO tree entry declares, and above the tree's own maximum — the unfixable direction. */
const FOREIGN_WHEN = TREE_MAX + 600_000;
const FOREIGN_HASH = createHash("sha256").update(`foreign-${randomUUID()}`).digest("hex");

const MAIL_TABLE = `"${MAIL_JOURNAL.migrationsSchema}"."__drizzle_migrations"`;

describe.skipIf(!UP)("a database whose migration journal is not this tree's", () => {
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    // FORCE, so a connection left over from an interrupted run cannot turn the drop into a hang.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${PRIVATE_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${PRIVATE_DB}"`);
    await runMigrations(PRIVATE_URL);
    sql = postgres(PRIVATE_URL, { max: 1, onnotice: () => {} });
  }, 300_000);

  /**
   * THE TEARDOWN NAMES ITS BUDGET, and it is not a style preference.
   *
   * Measured here: with the unreadable-journal case added, this teardown exceeded vitest's 10 s
   * default `hookTimeout` — `Hook timed out in 10000ms`, 11 tests passed, the FILE red, and no
   * test name in the failure. That reads as a suite-level defect and is not one: the drop had in
   * fact completed (the database was gone and `pg_database` held no invalid row), just later than
   * the default allowed. Which side of 10 s it lands on is decided by machine load, so a file
   * taking the default is green or red for reasons that are not in it.
   *
   * `_isolateddb.ts` already records this failure shape for its own reset, from the other
   * direction and at a cost: a hook timeout there was reported as a product regression in the
   * organizer lease. This is the same shape for a `DROP DATABASE`.
   */
  const TEARDOWN_BUDGET_MS = 120_000;

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    // FORCE terminates whatever is still attached, so the drop cannot become a hung fixture — and
    // an interrupted `DROP DATABASE` is worse than a slow one: it leaves the database INVALID, and
    // every later run on this server fails with "cannot connect to invalid database".
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${PRIVATE_DB}" WITH (FORCE)`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, TEARDOWN_BUDGET_MS);

  /** Run `fn` with one journal row this tree does not declare, and take it out again either way. */
  async function withForeignRow(fn: () => Promise<void>): Promise<void> {
    await sql.unsafe(
      `INSERT INTO ${MAIL_TABLE} (hash, created_at) VALUES ('${FOREIGN_HASH}', ${FOREIGN_WHEN})`,
    );
    try {
      await fn();
    } finally {
      await sql.unsafe(`DELETE FROM ${MAIL_TABLE} WHERE created_at = ${FOREIGN_WHEN}`);
    }
  }

  /** Run `fn` with one DECLARED migration's recorded hash rewritten — the edited-in-place shape. */
  async function withEditedHash(fn: (entry: { when: number; tag: string }) => Promise<void>): Promise<void> {
    const entry = ENTRIES[0]!;
    const rows = await sql.unsafe(
      `SELECT hash FROM ${MAIL_TABLE} WHERE created_at = ${entry.when}`,
    ) as unknown as Array<{ hash: string }>;
    const original = rows[0]?.hash;
    expect(original, `the fixture premise: ${entry.tag} is recorded on a freshly migrated database`)
      .toBeTypeOf("string");
    const rewritten = createHash("sha256").update(`edited-${randomUUID()}`).digest("hex");
    await sql.unsafe(
      `UPDATE ${MAIL_TABLE} SET hash = '${rewritten}' WHERE created_at = ${entry.when}`,
    );
    try {
      await fn(entry);
    } finally {
      await sql.unsafe(
        `UPDATE ${MAIL_TABLE} SET hash = '${original}' WHERE created_at = ${entry.when}`,
      );
    }
  }

  /**
   * `realPgAvailable` UNDER ONE POLICY, pinned for the call and put back. A refused database is a
   * skip (false, and the sentence on stderr) when `TF_REQUIRE_PG` is unset, and a throw carrying the
   * same sentence when it is "1" — which every CI job sets. Read under whatever the run happened to
   * set, the false-answer arms were red in CI three times out of three and green on a laptop, and the
   * throwing half was never asked at all. Each refusal arm now asks both.
   */
  async function realPgUnder(
    requirePg: "1" | undefined,
  ): Promise<{ answer: boolean | "threw"; thrown: string; written: string }> {
    const saved = process.env[REQUIRE_PG_ENV];
    if (requirePg === undefined) delete process.env[REQUIRE_PG_ENV];
    else process.env[REQUIRE_PG_ENV] = requirePg;
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const answer = await realPgAvailable(PRIVATE_URL);
      return { answer, thrown: "", written: written.join("") };
    } catch (e) {
      return { answer: "threw", thrown: e instanceof Error ? e.message : String(e), written: written.join("") };
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env[REQUIRE_PG_ENV];
      else process.env[REQUIRE_PG_ENV] = saved;
    }
  }

  // ── the admitting half, first: a refusal whose positive control is missing proves nothing ──

  it("admits a freshly migrated database — all three doors", async () => {
    expect(await journalDrift(PRIVATE_URL)).toBeNull();
    expect(await realPgAvailable(PRIVATE_URL)).toBe(true);
    await expect(refuseDriftedSharedDb(PRIVATE_URL)).resolves.toBeUndefined();
  });

  // ── a row this tree does not declare ────────────────────────────────────────────────────

  it("names a journal row this tree does not declare: spec, stamp, hash and this tree's own maximum", async () => {
    await withForeignRow(async () => {
      const drift = await journalDrift(PRIVATE_URL);
      expect(drift).not.toBeNull();
      const s = drift!;
      expect(s).toContain("mail:");                          // the spec
      expect(s).toContain(String(FOREIGN_WHEN));             // the foreign stamp
      expect(s).toContain(FOREIGN_HASH.slice(0, 12));        // the hash it carries
      expect(s).toContain(String(TREE_MAX));                 // this tree's own maximum
      // The hazard the sentence exists to name, not merely "they differ".
      expect(s).toContain("WITHOUT RUNNING");
      // WHICH arm answered. An undeclared row read as an EDIT sends the reader to diff a file
      // that is fine, and the two arms both have the stamp and the maximum in them, so the
      // numbers above cannot tell them apart.
      expect(s).toContain("does not declare");
      expect(s).not.toContain("edited since");
    });
  });

  it("realPgAvailable answers false and writes the sentence to stderr", async () => {
    await withForeignRow(async () => {
      const { answer, written: line } = await realPgUnder(undefined);
      expect(answer).toBe(false);
      expect(line).toContain("refusing this database");
      expect(line).toContain(PRIVATE_DB);
      expect(line).toContain(String(FOREIGN_WHEN));
      expect(line).toContain(String(TREE_MAX));
      expect(line).toContain("does not declare");
      expect(line).not.toContain("edited since");
    });
  });

  it("with TF_REQUIRE_PG=1, realPgAvailable throws that sentence instead of answering", async () => {
    await withForeignRow(async () => {
      const { answer, thrown, written } = await realPgUnder("1");
      expect(answer).toBe("threw");
      expect(thrown).toContain(`${REQUIRE_PG_ENV}=1 and the database at`);
      expect(thrown).toContain(PRIVATE_DB);
      expect(thrown).toContain(String(FOREIGN_WHEN));
      expect(thrown).toContain(String(TREE_MAX));
      expect(thrown).toContain("does not declare");
      expect(thrown).toContain("nothing was measured");
      // and the stderr line is written before the throw, so a run that catches it still says why
      expect(written).toContain("refusing this database");
    });
  });

  it("the worker's shared-database door throws the same sentence", async () => {
    await withForeignRow(async () => {
      // A one-word verdict, not the resolved value: a `.rejects` miss pretty-prints what it got,
      // and what this resolves to holds a live connection pool.
      const verdict = await refuseDriftedSharedDb(PRIVATE_URL).then(
        () => "admitted",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(verdict).not.toBe("admitted");
      expect(verdict).toContain("is not this tree's");
      expect(verdict).toContain(String(FOREIGN_WHEN));
      expect(verdict).toContain(String(TREE_MAX));
      expect(verdict).toContain("nothing was measured");
      expect(verdict).toContain("does not declare");
      expect(verdict).not.toContain("edited since");
    });
  });

  // ── a declared migration whose recorded content is not the file's ───────────────────────

  it("names a migration edited since it ran: both hashes and this tree's own maximum", async () => {
    await withEditedHash(async (entry) => {
      const drift = await journalDrift(PRIVATE_URL);
      expect(drift).not.toBeNull();
      const s = drift!;
      expect(s).toContain("mail:");
      expect(s).toContain(String(entry.when));
      expect(s).toContain("edited since it ran");
      expect(s).not.toContain("does not declare");
      expect(s).toContain(String(TREE_MAX));
      // The file's own sha256 — the half the comparison is against.
      const want = createHash("sha256")
        .update(readFileSync(join(MAIL_JOURNAL.dir, `${entry.tag}.sql`)))
        .digest("hex");
      expect(s).toContain(want.slice(0, 12));
    });
  });

  it("the worker's door throws for an edited migration too", async () => {
    await withEditedHash(async (entry) => {
      const verdict = await refuseDriftedSharedDb(PRIVATE_URL).then(
        () => "admitted",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(verdict).not.toBe("admitted");
      expect(verdict).toContain(String(entry.when));
      expect(verdict).toContain("edited since it ran");
      expect(verdict).not.toContain("does not declare");
    });
  });

  // ── and the poison is removable: the refusal is a state, not a latch ────────────────────

  it("admits again once the journal matches this tree", async () => {
    expect(await journalDrift(PRIVATE_URL)).toBeNull();
    expect(await realPgAvailable(PRIVATE_URL)).toBe(true);
    await expect(refuseDriftedSharedDb(PRIVATE_URL)).resolves.toBeUndefined();
  });

  // ── and an UNREADABLE journal is refused too, as its own state ─────────────────────────

  it("a journal it cannot read at all is refused, and named as unknown rather than as drift", async () => {
    // Rename the column the query reads, so the read fails for a reason that is neither drift nor
    // its absence. Lossless and reversible: the hashes are all still there under another name.
    await sql.unsafe(`ALTER TABLE ${MAIL_TABLE} RENAME COLUMN hash TO hash_probe`);
    try {
      // journalDrift ANSWERS or FAILS — it never invents an answer, so this one rejects.
      const answered = await journalDrift(PRIVATE_URL).then(
        (v) => `answered ${String(v)}`,
        () => "rejected",
      );
      expect(answered).toBe("rejected");

      // Both policies refuse, and say which of the two states this is.
      const skipped = await realPgUnder(undefined);
      expect(skipped.answer).toBe(false);
      expect(skipped.written).toContain("could not be read at all");
      expect(skipped.written).toContain("neither drift nor its absence");
      const required = await realPgUnder("1");
      expect(required.answer).toBe("threw");
      expect(required.thrown).toContain("could not be read at all");
      expect(required.thrown).toContain("neither drift nor its absence");

      const verdict = await refuseDriftedSharedDb(PRIVATE_URL).then(
        () => "admitted",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(verdict).not.toBe("admitted");
      expect(verdict).toContain("could not be read at all");
    } finally {
      await sql.unsafe(`ALTER TABLE ${MAIL_TABLE} RENAME COLUMN hash_probe TO hash`);
    }
    // and the rename back admits again, so the refusal is a state and not a latch
    expect(await journalDrift(PRIVATE_URL)).toBeNull();
  });

  it("a database that is merely BEHIND is not drift — the migrator fixes that itself", async () => {
    const entry = ENTRIES[ENTRIES.length - 1]!;
    const rows = await sql.unsafe(
      `SELECT hash FROM ${MAIL_TABLE} WHERE created_at = ${entry.when}`,
    ) as unknown as Array<{ hash: string }>;
    const original = rows[0]!.hash;
    await sql.unsafe(`DELETE FROM ${MAIL_TABLE} WHERE created_at = ${entry.when}`);
    try {
      expect(await journalDrift(PRIVATE_URL)).toBeNull();
    } finally {
      await sql.unsafe(
        `INSERT INTO ${MAIL_TABLE} (hash, created_at) VALUES ('${original}', ${entry.when})`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CENSUS. The two cases above prove the doors refuse; neither can see a file that walks past
// them. This does, and it is the reason the shared-database door is one named function rather
// than a line copied into each fixture.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Files whose IMPORT LIST from `./_workerenv.js` or `./_workerdb.js` includes `DB_URL` — the test database. */
function filesReachingTheSharedDb(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(TEST_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const src = readFileSync(join(TEST_DIR, name), "utf8");
    // The IMPORT, not any mention: `worker-multimailbox.e2e.test.ts` declares a local `DB_URL`
    // holding an ISOLATED database, and a bare name grep reads that as a shared-database file.
    if (/import[^;]*\bDB_URL\b[^;]*from "\.\/_worker(?:env|db)\.js"/.test(src)) out.push(name);
  }
  return out.sort();
}

/**
 * `_isolateddb.ts` reaches `DB_URL` to build the ADMIN url it creates databases with, and it
 * holds the other policy (recreate) rather than this one. It is the door, not a file walking
 * past one.
 */
const OWNS_THE_OTHER_POLICY = "_isolateddb.ts";

describe("every worker test that reaches the shared database goes through a checked door", () => {
  it("each file either uses the harness or calls the door itself", () => {
    const files = filesReachingTheSharedDb();
    // A census that selected nothing would pass silently, which is the failure it exists to stop.
    expect(files.length).toBeGreaterThan(10);
    const unguarded = files.filter((name) => {
      if (name === OWNS_THE_OTHER_POLICY) return false;
      const src = readFileSync(join(TEST_DIR, name), "utf8");
      return !/\bmakeHarness\b/.test(src) && !/\brefuseDriftedSharedDb\b/.test(src);
    });
    expect(unguarded).toEqual([]);
  });

  it("the harness consults the door BEFORE its first statement", () => {
    const src = readFileSync(join(TEST_DIR, "_workerenv.ts"), "utf8");
    const start = src.indexOf("export async function makeHarness");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const door = body.indexOf("await refuseDriftedSharedDb(");
    const firstStatement = body.indexOf("makeDb(DB_URL)");
    expect(door).toBeGreaterThan(-1);
    expect(firstStatement).toBeGreaterThan(-1);
    expect(door).toBeLessThan(firstStatement);
  });
});
