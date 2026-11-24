import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandDialect } from "../src/dialect/index.js";
import { migrationSqlHash, readJournalOf, type JournalEntry, type JournalSpec } from "../src/baseline.js";
import { journalProblems, journalStatuses, admittedDriftLines, setupProdDatabase } from "../src/setup-prod.js";
import {
  classifyDrift, gitProvenanceReader, type HistoricalSql, type ProvenanceReader,
} from "../src/migration-provenance.js";
import { allowanceFor, MIGRATION_ALLOWANCES } from "../src/migration-allowances.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb } from "../src/testing.js";

/**
 * A JOURNAL ROW IS VERIFIED AGAINST THE SQL THAT RAN, AND WHAT RAN IS PROVED FROM HISTORY.
 *
 * A deployment refused with 35 `MISDESCRIBED` lines while nothing had drifted: comments had been
 * reworded inside 34 already-applied migrations, and mail 0037 had gained an idempotency wrapper
 * after it ran. The verifier hashed raw bytes and could tell neither from a real edit.
 *
 * The admitted arms that read the hashes production recorded need a version of 0006 that the
 * history of this repository does not hold, so they left this file; the refusal arms here use a
 * synthetic history, which is the only place a real drift can exist, and the GIT_DIR arm reads a
 * repository it plants itself.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const SCHEMA = `drizzle_pv_${randomBytes(4).toString("hex")}`;
const PG_UP = await realPgAvailable(PG_TEST_URL);

const sha256Utf8 = (s: string): string => createHash("sha256").update(s).digest("hex");
const shippedSqlOf = (tag: string): string => readFileSync(join(MAIL_DIR, `${tag}.sql`), "utf8");

const ALL: JournalEntry[] = readJournalOf({ name: "mail", dir: MAIL_DIR, migrationsSchema: "drizzle_mail" });
const SPEC: JournalSpec = { name: "mail", dir: MAIL_DIR, migrationsSchema: SCHEMA };
const entryFor = (tag: string): JournalEntry => {
  const e = ALL.find((x) => x.tag === tag);
  if (!e) throw new Error(`the mail journal no longer names ${tag}`);
  return e;
};

/** The one allowance, and the tag it names. Read from the module so the two cannot drift. */
const ALLOWANCE = MIGRATION_ALLOWANCES[0]!;

/**
 * A tag whose earlier versions differ from today's in comments only. The arms that derived the hash
 * production recorded for it read a version of it this repository's history does not hold, so they
 * left this file; the arms here never read history beyond a hash no version carries.
 */
const COMMENT_ONLY_TAG = "0006_idempotency_keys";

const RECORDED_BEFORE_REPLAY_FIX = [
  ["0214_invitation_proposals", "7343a3baa62f050aba6c4fb2027735853825e819c1158c968857ad7cb4761b9d"],
  ["0215_calendar_removed_occurrences", "10686a3b7e8baff72f2fa5cb58c5b374681c6d12348fe9f3980970cd6ff8f9d5"],
  ["0216_calendar_native_move", "cb4e271d2635f17eedc180dc4cb1da3341afd2ddeba0077cca6efb8685097d21"],
  ["0217_calendar_portable_copy", "3eb593144386ac280eb8a9917ca32cc9615d0eccddd24ede4b05fd32eecd7f7c"],
  ["0219_hosted_invitation_details", "ba48747593712fda9ccc22919c19c97fa0b9058939658e50be688bce4f4b2149"],
] as const;

/** A history that answers whatever an arm needs it to, so a refusal can be reached at all. */
const fakeHistory = (versions: string[]): ProvenanceReader => ({
  history(): HistoricalSql[] {
    return versions.map((sql, i) => ({ commit: `${i}`.padStart(40, "0"), at: "2026-01-01T00:00:00+00:00", sql }));
  },
});

describe("the allowance is keyed on the pair of texts, not on the tag", () => {
  it("admits exactly the (journal, tag, recorded, shipped) it names", () => {
    expect(allowanceFor(ALLOWANCE.journal, ALLOWANCE.tag, ALLOWANCE.recorded, ALLOWANCE.shipped)).not.toBeNull();
  });

  it("does not admit the same tag with a different shipped hash", () => {
    expect(allowanceFor(ALLOWANCE.journal, ALLOWANCE.tag, ALLOWANCE.recorded, "f".repeat(64))).toBeNull();
  });

  it("does not admit the same tag with a different recorded hash", () => {
    expect(allowanceFor(ALLOWANCE.journal, ALLOWANCE.tag, "f".repeat(64), ALLOWANCE.shipped)).toBeNull();
  });

  it("does not admit the same tag in the other journal", () => {
    expect(allowanceFor("cloud", ALLOWANCE.tag, ALLOWANCE.recorded, ALLOWANCE.shipped)).toBeNull();
  });

  /** The allowance is a record of a HAND comparison, so it states what it compared and why. */
  it("carries a reason and two 64-hex hashes", () => {
    for (const a of MIGRATION_ALLOWANCES) {
      expect(a.recorded).toMatch(/^[0-9a-f]{64}$/);
      expect(a.shipped).toMatch(/^[0-9a-f]{64}$/);
      expect(a.reason.length).toBeGreaterThan(30);
    }
  });

  /** The shipped side of an allowance must still be what this tree ships, or it is stale. */
  it("the 0037 allowance names the hash this tree actually ships", () => {
    expect(migrationSqlHash(SPEC, ALLOWANCE.tag)).toBe(ALLOWANCE.shipped);
  });
});

describe("the history read itself", () => {
  /**
   * git exports `GIT_DIR` to every hook and it OVERRIDES `git -C <path>` in any child — three
   * arms, because a reader that silently answers about another repository is worse than one that
   * refuses: unset, set the way a hook sets it, and set-then-cleared. The repository is planted with
   * two versions of one migration, so the read has something to find; the plant's own git calls
   * strip the same variables, so a GIT_DIR this test runs under cannot redirect the plant either.
   */
  it("an exported GIT_DIR does not redirect the history read", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ohmail-provenance-"));
    try {
      const repo = join(scratch, "repo");
      const foreign = join(scratch, "foreign");
      const dir = join(repo, "drizzle");
      mkdirSync(dir, { recursive: true });
      mkdirSync(foreign);
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
      const git = (cwd: string, ...args: string[]): void => {
        execFileSync("git", ["-C", cwd, "-c", "user.name=rig", "-c", "user.email=rig@rig.test",
          "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { stdio: "pipe", env });
      };
      git(foreign, "init", "-q");
      git(repo, "init", "-q");
      for (const sql of ["-- first\nSELECT 1;\n", "-- second\nSELECT 1;\n"]) {
        writeFileSync(join(dir, "0001_planted.sql"), sql);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "a version");
      }
      const read = (): number => gitProvenanceReader().history(dir, "0001_planted").length;

      const unset = read();
      expect(unset, "the planted history did not read as two versions").toBe(2);
      const before = process.env["GIT_DIR"];
      try {
        process.env["GIT_DIR"] = join(foreign, ".git");
        expect(read(), "an exported GIT_DIR redirected the read to another repository").toBe(unset);
      } finally {
        if (before === undefined) delete process.env["GIT_DIR"];
        else process.env["GIT_DIR"] = before;
      }
      expect(read()).toBe(unset);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("classifyDrift refuses everything it cannot prove", () => {
  const mismatch = (tag: string, recorded: string) => ({
    tag, when: entryFor(tag).when, expected: migrationSqlHash(SPEC, tag), recorded, rowsAtWhen: 1,
  });

  it.each(RECORDED_BEFORE_REPLAY_FIX)("%s admits the exact previously applied SQL", (tag, recorded) => {
    const shipped = shippedSqlOf(tag);
    const oldSql = shipped.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN");
    expect(sha256Utf8(oldSql)).toBe(recorded);
    const drift = classifyDrift("mail", MAIL_DIR, mismatch(tag, recorded), shipped, fakeHistory([oldSql]));
    expect(drift).toMatchObject({ kind: "allowed", provenance: { source: "history" } });
  });

  it.each(["recorded", "shipped"] as const)(
    "refuses an unlisted %s hash when Git history is unavailable",
    (side) => {
      const [tag, recorded] = RECORDED_BEFORE_REPLAY_FIX[0];
      const control = mismatch(tag, recorded);
      const shipped = shippedSqlOf(tag);
      const reader: ProvenanceReader = {
        history() { throw new Error("not a git repository"); },
      };
      const otherSql = `-- different shipped bytes\n${shipped}`;
      const drift = side === "recorded"
        ? classifyDrift("mail", MAIL_DIR, { ...control, recorded: "f".repeat(64) }, shipped, reader)
        : classifyDrift("mail", MAIL_DIR, { ...control, expected: sha256Utf8(otherSql) }, otherSql, reader);
      expect(drift).toMatchObject({ kind: "unreadable", provenance: null, note: "not a git repository" });
    },
  );

  it("EXECUTABLE drift with no allowance is refused, naming the version that ran", () => {
    const ran = "ALTER TABLE t ADD COLUMN x text;";
    const d = classifyDrift(
      "mail", MAIL_DIR, mismatch("0043_ohbox_tidy", sha256Utf8(ran)),
      "ALTER TABLE t ADD COLUMN x integer;", fakeHistory([ran]),
    );
    expect(d.kind).toBe("executable");
    expect(d.provenance).not.toBeNull();
  });

  it("the SAME pair is admitted when only comments differ — the control for the arm above", () => {
    const ran = "-- old wording\nALTER TABLE t ADD COLUMN x text;";
    const d = classifyDrift(
      "mail", MAIL_DIR, mismatch("0043_ohbox_tidy", sha256Utf8(ran)),
      "-- new wording\nALTER TABLE t ADD COLUMN x text;", fakeHistory([ran]),
    );
    expect(d.kind).toBe("comment-only");
  });

  it("a hash NO version carries is refused as unknown provenance", () => {
    const d = classifyDrift(
      "mail", MAIL_DIR, mismatch(COMMENT_ONLY_TAG, "0".repeat(63) + "1"),
      shippedSqlOf(COMMENT_ONLY_TAG), gitProvenanceReader(),
    );
    expect(d.kind).toBe("unknown-provenance");
    expect(d.provenance).toBeNull();
  });

  it("history that cannot be read is refused, not skipped", () => {
    const broken: ProvenanceReader = { history() { throw new Error("not a git repository"); } };
    const d = classifyDrift(
      "mail", MAIL_DIR, mismatch(COMMENT_ONLY_TAG, "0".repeat(64)),
      shippedSqlOf(COMMENT_ONLY_TAG), broken,
    );
    expect(d.kind).toBe("unreadable");
    expect(d.note).toContain("not a git repository");
  });

  it("two rows at one `when` stay a collision — there is no single hash to resolve", () => {
    const d = classifyDrift(
      "mail", MAIL_DIR,
      { ...mismatch(COMMENT_ONLY_TAG, "x"), recorded: null, rowsAtWhen: 2 },
      shippedSqlOf(COMMENT_ONLY_TAG), gitProvenanceReader(),
    );
    expect(d.kind).toBe("rows-collide");
  });
});

describe.skipIf(!PG_UP)("the 2026-09-16 refusal, on a lane database", () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<Record<string, never>>;
  const TABLE = `"${SCHEMA}"."__drizzle_migrations"`;
  const ENTRIES = [entryFor(COMMENT_ONLY_TAG), entryFor(ALLOWANCE.tag), entryFor("0043_ohbox_tidy")];

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await client.unsafe(`create schema if not exists "${SCHEMA}"`);
    await client.unsafe(
      `create table if not exists ${TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
  }, 60_000);

  afterAll(async () => {
    await client?.unsafe(`drop schema if exists "${SCHEMA}" cascade`).catch(() => {});
    await client?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  beforeEach(async () => { await client.unsafe(`truncate ${TABLE}`); });

  const record = async (entry: JournalEntry, hash: string): Promise<void> => {
    await client.unsafe(`insert into ${TABLE} ("hash", "created_at") values ('${hash}', ${entry.when})`);
  };
  const statuses = async (reader?: ProvenanceReader) =>
    journalStatuses(db, new Map(), [{ spec: SPEC, entries: ENTRIES }], reader ?? gitProvenanceReader());

  it("a row whose SQL genuinely differs is still REFUSED, and the sentence is unchanged", async () => {
    const ran = "ALTER TABLE t ADD COLUMN x text;";
    await record(entryFor("0043_ohbox_tidy"), sha256Utf8(ran));
    await record(entryFor(COMMENT_ONLY_TAG), migrationSqlHash(SPEC, COMMENT_ONLY_TAG));
    await record(entryFor(ALLOWANCE.tag), migrationSqlHash(SPEC, ALLOWANCE.tag));

    const [status] = await statuses(fakeHistory([ran]));
    expect(status!.drift.map((d) => d.kind)).toEqual(["executable"]);
    const problems = journalProblems([status!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("MISDESCRIBED");
    expect(problems[0]).toContain("0043_ohbox_tidy");
    expect(problems[0]).toContain(migrationSqlHash(SPEC, "0043_ohbox_tidy"));
    expect(problems[0]).toContain(sha256Utf8(ran));
    expect(problems[0]).toContain("EXECUTABLE SQL");
    expect(problems[0]).toContain("nothing may be deployed over it");
    expect(admittedDriftLines([status!]), "a refused drift was also reported as admitted").toEqual([]);
  });

  it("a hash nothing in history carries is REFUSED, naming unknown provenance", async () => {
    for (const e of ENTRIES) await record(e, migrationSqlHash(SPEC, e.tag));
    await client.unsafe(`update ${TABLE} set "hash" = '${"0".repeat(63)}1' where created_at = ${entryFor(COMMENT_ONLY_TAG).when}`);

    const problems = journalProblems([(await statuses())[0]!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("No version this file has ever held");
  });

  it("an honest deployment is still silent — no drift, no problems, nothing admitted", async () => {
    for (const e of ENTRIES) await record(e, migrationSqlHash(SPEC, e.tag));
    const [status] = await statuses();
    expect(status!.mismatched).toEqual([]);
    expect(status!.drift).toEqual([]);
    expect(journalProblems([status!])).toEqual([]);
    expect(admittedDriftLines([status!])).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("setup from a source archive", () => {
  const archiveDb = throwawayDb("setup_archive");
  afterAll(() => archiveDb.drop(), MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("starts over the exact previously applied fingerprints without Git history", async () => {
    const previouslyApplied = [
      ["0120_held_release_dismissed", "a6103bca59c94c095b92b5fd59e52b608c6fb34fce486ff02cf4d311e703bb65"],
      RECORDED_BEFORE_REPLAY_FIX[0],
    ] as const;
    await archiveDb.createFromTemplate();
    const client = postgres(archiveDb.url, { max: 1, onnotice: () => {} });
    try {
      for (const [tag, recorded] of previouslyApplied) {
        const rows = await client`update drizzle_mail.__drizzle_migrations set hash = ${recorded}
                                  where created_at = ${entryFor(tag).when} returning hash`;
        expect(rows).toHaveLength(1);
      }
    } finally {
      await client.end({ timeout: 5 });
    }

    const logged: string[] = [];
    // Keep Git from discovering the repository above the migration directory, as in an archive.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", realpathSync(join(MAIL_DIR, "..")));
    try {
      expect(() => gitProvenanceReader().history(MAIL_DIR, previouslyApplied[0][0])).toThrow();
      await setupProdDatabase(archiveDb.url, { log: (line) => logged.push(line) });
    } finally {
      vi.unstubAllEnvs();
    }
    for (const [tag] of previouslyApplied) {
      expect(logged.some((line) => line.includes(`ADMITTED: mail ${tag}:`))).toBe(true);
    }
  }, 120_000);
});
