import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brandDialect } from "../src/dialect/index.js";
import { readJournalOf, type JournalEntry, type JournalSpec } from "../src/baseline.js";
import { admittedDriftLines, journalProblems, journalStatuses } from "../src/setup-prod.js";
import { classifyDrift, gitProvenanceReader, type ProvenanceReader } from "../src/migration-provenance.js";
import { prePublicationVersionFor, type PrePublicationVersion } from "../src/migration-provenance-record.js";
import { normalizeSql } from "../src/sql-normalize.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE 2026-10-16 REFUSAL, FROM A CLONE OF THIS REPOSITORY.
 *
 * The setup's verification refused twenty applied entries of a production database as
 * MISDESCRIBED: their rows record versions of those files from the project's development history
 * before publication, and the classifier identifies what ran from the deploying checkout's git
 * history, which a clone of this repository does not carry. Nothing had drifted — from that older
 * history the same database reads nineteen comment-only drifts and mail 0037's allowance. The
 * provenance record names those versions; these arms prove it identifies them, refuses everything
 * else it did before, and decides nothing on its own. Eleven more (mail 0006-0027: nine
 * comment-only, 0021 and 0022 by their allowances) sat above the 20-line log; the 0.27.0 GO-DB
 * refusal printed them, and they are held here the same way: thirty-one in all.
 *
 * {@link PRODUCTION} is the independent side: the hashes production's tables record, copied from
 * the refusal's own lines. The record under test was derived from history; these were read off the
 * database. Neither is computed from the other.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIRS = { mail: join(HERE, "..", "..", "db-mail", "drizzle"), cloud: join(HERE, "..", "drizzle-cloud") } as const;
type Journal = keyof typeof DIRS;

const PRODUCTION: ReadonlyArray<{
  journal: Journal; tag: string; recorded: string; verdict: "comment-only" | "allowed";
}> = [
  // The eleven the 20-line deploy log hid at 0.26.0 (the 0.27.0 GO-DB refusal printed them whole).
  { journal: "mail", tag: "0006_idempotency_keys", recorded: "90fd292bc0820b9e7abf8b7c063d30ea59e5b371943ecda271cda0bd76abf448", verdict: "comment-only" },
  { journal: "mail", tag: "0015_workflow_step_dedup", recorded: "fccf1e354500b9c0d55a3b0c5c0ede3305927c4eac12897fe948c7d652b3cd9f", verdict: "comment-only" },
  { journal: "mail", tag: "0016_workflow_proposals", recorded: "4f0f2c39fcdbde2a67529eac6e5ce262458ced19cc3cefb2fbf4cd7d9bde4622", verdict: "comment-only" },
  { journal: "mail", tag: "0017_enrollment", recorded: "4aca9b1f59c90975cb0ae34eab683743e223ceb7758a8e93c123c6a17dfdc89b", verdict: "comment-only" },
  { journal: "mail", tag: "0021_mailbox_address_unique", recorded: "7201608975888466d3fdc2b95ec472a50e272c30b322ad3071100e909aeb2c57", verdict: "allowed" },
  { journal: "mail", tag: "0022_message_body_html_cap", recorded: "6c8d15b02a2fbaeece3b5aacab167566ae4aa43f43f41468bc278ccb61905d34", verdict: "allowed" },
  { journal: "mail", tag: "0023_mailbox_failure_reason", recorded: "dbc15fae438882a2c8005f6605d66bd576db513a2eb657fea196f0a454e444ee", verdict: "comment-only" },
  { journal: "mail", tag: "0024_flag_state", recorded: "28372bb0cb85a434480cfbc9901a378eb59f495798279475139c8955bb1403a5", verdict: "comment-only" },
  { journal: "mail", tag: "0025_mailbox_kickstart", recorded: "c1fcd9dd449648bcde5894cb775733f3ca784b2b3130f2af18114735cf41844e", verdict: "comment-only" },
  { journal: "mail", tag: "0026_thread_resolution", recorded: "20572b3b6ba1d5a872756ea0378387126138f373c7c42b13077f311f484b9c83", verdict: "comment-only" },
  { journal: "mail", tag: "0027_organizer_lease", recorded: "559044c0f5a4622043321f5a1fe890b3d13817f3ea5fd6ff81b1ed125b246aef", verdict: "comment-only" },
  { journal: "mail", tag: "0028_message_instances", recorded: "82b0e2c9ce4d758f665caade9c68b757c2b23ed9d3c8790e8bde1b3c56f4dc05", verdict: "comment-only" },
  { journal: "mail", tag: "0029_mailbox_sync_block", recorded: "38a14344f094e951662f736a316b1732544619bde158dcfd5be777af258710c3", verdict: "comment-only" },
  { journal: "mail", tag: "0030_sensitive_rescreen", recorded: "f938b6eaa871b83976817e50f2bc242a8d9c85c0bbf2b21b3f2b8c542087d0dd", verdict: "comment-only" },
  { journal: "mail", tag: "0032_unsubscribe_records", recorded: "5ac32e8e1dbc7224bdf1e0ea0478359bf3de05cabfc0bcf8a5c6e626c8ce5084", verdict: "comment-only" },
  { journal: "mail", tag: "0033_workflow_run_claim", recorded: "f94ff5e1d1f27db85ae7b351f653a05afaa4ee3c6a1d68e7a48ebf5a6825434e", verdict: "comment-only" },
  { journal: "mail", tag: "0034_rule_retro", recorded: "e93e94879e8725ea0ad677abd62d321056ad971a51d26333e34c2ad83b97a50b", verdict: "comment-only" },
  { journal: "mail", tag: "0035_account_settings", recorded: "d5824b7286bb9c1452a596a6f984a783e22c07406c76ef6825614b79b419f843", verdict: "comment-only" },
  { journal: "mail", tag: "0036_sensitive_fp_backfill", recorded: "a7e1b60faddd2a56f28537cc507eadfe5ed0abde42536e1d5f171c92014b6a8b", verdict: "comment-only" },
  { journal: "mail", tag: "0037_draft_html", recorded: "7237cafe837fe1cd50c567f2e2de8fbd4ac57370970a9b437c79d4a61cd1ae0f", verdict: "allowed" },
  { journal: "mail", tag: "0038_initial_import_completed", recorded: "96108996ae39f92c83f80abaffb958ed846396b07551a65949e884ba21e4830f", verdict: "comment-only" },
  { journal: "mail", tag: "0039_mailbox_retry_after", recorded: "a73d0420bece3eee966752f284ceb3c0e893ba265dc7f6bd4b01844d6d82e7ee", verdict: "comment-only" },
  { journal: "mail", tag: "0040_auto_suggest", recorded: "f0c90bfce57e2b8f674eecec384ca55ce6b8f5d0f612f255262dabbec83071bd", verdict: "comment-only" },
  { journal: "mail", tag: "0042_screening_preference", recorded: "d0ebddb6db6fc5ee8e844669c2391797d4a14a281ef72e467267dfe138247b0e", verdict: "comment-only" },
  { journal: "mail", tag: "0043_ohbox_tidy", recorded: "78ed7d3e46380942dad8fc7d2c20dfd82afd82bb8175806b09f6bf319d2b3cf2", verdict: "comment-only" },
  { journal: "mail", tag: "0051_away_responder", recorded: "2fbd6faa50c8e2332ea00d116fd25547b435c88cedffc6adb1acf43d24d5d1d2", verdict: "comment-only" },
  { journal: "mail", tag: "0076_junk_sweep_request", recorded: "e58f7a5bb0d132a275dc04b1015c35c9cd83abef1b351fd693340384ac0a9cc8", verdict: "comment-only" },
  { journal: "cloud", tag: "0003_observability", recorded: "3a51cf24c18aaf3c719424f039ef422e2a7a24a7700652047d49561eea130841", verdict: "comment-only" },
  { journal: "cloud", tag: "0004_waitlist_invites", recorded: "7bccabc24e8136cc1fe079aeb213f0109dfa080a713cc6aac236e94805822496", verdict: "comment-only" },
  { journal: "cloud", tag: "0007_staff_users", recorded: "38420eef2df9959405ea2f4cfe5e52c7c10c657b73b2942efe5f8ccc64bed56a", verdict: "comment-only" },
  { journal: "cloud", tag: "0009_mailbox_oauth", recorded: "3340bdb8c316ad148d73751190d0df2d7ce6cfbde3bccdbcf24ad6d76dfd1672", verdict: "comment-only" },
];

const sha256Utf8 = (s: string): string => createHash("sha256").update(s).digest("hex");
const ENTRIES: Record<Journal, JournalEntry[]> = {
  mail: readJournalOf({ name: "mail", dir: DIRS.mail, migrationsSchema: "drizzle_mail" }),
  cloud: readJournalOf({ name: "cloud", dir: DIRS.cloud, migrationsSchema: "drizzle_cloud" }),
};
const whenOf = (journal: Journal, tag: string): number => {
  const e = ENTRIES[journal].find((x) => x.tag === tag);
  if (!e) throw new Error(`the ${journal} journal no longer names ${tag}`);
  return e.when;
};
const shippedOf = (journal: Journal, tag: string): string => readFileSync(join(DIRS[journal], `${tag}.sql`), "utf8");

/** The REAL reader on this checkout — the history a clone of this repository has. */
const READER = gitProvenanceReader();

/** The mismatch `digestMismatches` hands over for one row: the shipped hash against the recorded one. */
const mismatch = (journal: Journal, tag: string, recorded: string) => ({
  tag, when: whenOf(journal, tag), expected: sha256Utf8(shippedOf(journal, tag)), recorded, rowsAtWhen: 1,
});

/** One planted record row, for the arms that must reach a hit whose facts they choose. */
const planted = (over: Partial<PrePublicationVersion> & Pick<PrePublicationVersion, "tag" | "recorded">): PrePublicationVersion[] => [{
  journal: "mail", executable: "f".repeat(64), introducedBy: "a".repeat(40), label: "pre-publication version", ...over,
}];

describe("production's thirty-one, classified from a clone of this repository", () => {
  it.each(PRODUCTION.map((p) => [`${p.journal} ${p.tag}`, p] as const))(
    "%s: the record names exactly this version, and it reads its verdict via the record",
    (_name, p) => {
      expect(prePublicationVersionFor(p.journal, p.tag, p.recorded), "the record does not name production's hash").not.toBeNull();
      const d = classifyDrift(p.journal, DIRS[p.journal], mismatch(p.journal, p.tag, p.recorded), shippedOf(p.journal, p.tag), READER);
      expect(`${d.kind} via ${d.provenance?.source ?? "nothing"}`).toBe(`${p.verdict} via record`);
    },
  );

  it("none of them is a version this checkout's history carries — which is the whole gap", () => {
    for (const p of PRODUCTION) {
      const carried = READER.history(DIRS[p.journal], p.tag).some((h) => sha256Utf8(h.sql) === p.recorded);
      expect(carried, `${p.journal} ${p.tag} is in this history after all`).toBe(false);
    }
  });

  it("each is identified by the provenance record and earns the verdict its SQL does", () => {
    const read = PRODUCTION.map((p) => {
      const d = classifyDrift(p.journal, DIRS[p.journal], mismatch(p.journal, p.tag, p.recorded), shippedOf(p.journal, p.tag), READER);
      return `${p.journal} ${p.tag}: ${d.kind}${d.provenance ? ` via ${d.provenance.source}` : ""}`;
    });
    expect(read).toEqual(PRODUCTION.map((p) => `${p.journal} ${p.tag}: ${p.verdict} via record`));
  });

  it("mail 0037 is admitted by its allowance and by nothing else — the record does not decide", () => {
    const p = PRODUCTION.find((x) => x.tag === "0037_draft_html")!;
    const m = { ...mismatch("mail", p.tag, p.recorded), expected: "e".repeat(64) }; // a shipped hash no allowance names
    expect(classifyDrift("mail", DIRS.mail, m, shippedOf("mail", p.tag), READER).kind).toBe("executable");
  });
});

describe("the record identifies exactly what it names, and nothing else", () => {
  const first = PRODUCTION[0]!;

  it("the same tag with a hash nothing names stays unknown provenance", () => {
    const d = classifyDrift("mail", DIRS.mail, mismatch("mail", first.tag, "0".repeat(63) + "1"), shippedOf("mail", first.tag), READER);
    expect(d.kind).toBe("unknown-provenance");
  });

  it("a hash the record names, asked for under ANOTHER tag, stays unknown provenance", () => {
    const tag = "0005_warm_black_bird";
    expect(PRODUCTION.some((p) => p.tag === tag), "pick a tag the record does not name").toBe(false);
    const d = classifyDrift("mail", DIRS.mail, mismatch("mail", tag, first.recorded), shippedOf("mail", tag), READER);
    expect(d.kind).toBe("unknown-provenance");
  });

  it("a hash and tag the record names, asked for under the OTHER journal, stays unknown provenance", () => {
    const d = classifyDrift("cloud", DIRS.mail, mismatch("mail", first.tag, first.recorded), shippedOf("mail", first.tag), READER);
    expect(d.kind).toBe("unknown-provenance");
  });

  it("a hit whose executable SQL differs from the shipped file's is EXECUTABLE — the comparison stays live", () => {
    const tag = "0043_ohbox_tidy";
    const recorded = PRODUCTION.find((p) => p.tag === tag)!.recorded;
    const differs = classifyDrift("mail", DIRS.mail, mismatch("mail", tag, recorded), shippedOf("mail", tag), READER,
      planted({ tag, recorded, executable: "f".repeat(64) }));
    expect(differs.kind).toBe("executable");
    // The control: the same planted row, carrying the shipped file's executable SQL.
    const same = classifyDrift("mail", DIRS.mail, mismatch("mail", tag, recorded), shippedOf("mail", tag), READER,
      planted({ tag, recorded, executable: sha256Utf8(normalizeSql(shippedOf("mail", tag))) }));
    expect(same.kind).toBe("comment-only");
  });

  it("history that cannot be read: a hit is still identified, a miss is still refused as unreadable", () => {
    const broken: ProvenanceReader = { history() { throw new Error("not a git repository"); } };
    const hit = classifyDrift("mail", DIRS.mail, mismatch("mail", first.tag, first.recorded), shippedOf("mail", first.tag), broken);
    expect(hit.kind).toBe("comment-only");
    expect(hit.provenance?.source).toBe("record");
    const miss = classifyDrift("mail", DIRS.mail, mismatch("mail", first.tag, "0".repeat(64)), shippedOf("mail", first.tag), broken);
    expect(miss.kind).toBe("unreadable");
    expect(miss.note).toContain("not a git repository");
  });

  it("two rows at one `when` stay a collision, even for a tag the record names", () => {
    const d = classifyDrift("mail", DIRS.mail, { ...mismatch("mail", first.tag, first.recorded), recorded: null, rowsAtWhen: 2 },
      shippedOf("mail", first.tag), READER);
    expect(d.kind).toBe("rows-collide");
  });
});

const PG_UP = await realPgAvailable(PG_TEST_URL);
const SUFFIX = randomBytes(4).toString("hex");
const SPECS: Record<Journal, JournalSpec> = {
  mail: { name: "mail", dir: DIRS.mail, migrationsSchema: `drizzle_pp_mail_${SUFFIX}` },
  cloud: { name: "cloud", dir: DIRS.cloud, migrationsSchema: `drizzle_pp_cloud_${SUFFIX}` },
};

describe.skipIf(!PG_UP)("the setup's verification over production's rows, on a lane database", () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<Record<string, never>>;
  const table = (j: Journal): string => `"${SPECS[j].migrationsSchema}"."__drizzle_migrations"`;

  /** Honest rows carry DRIZZLE'S OWN hash, from the migrator's reader — never the code under test's. */
  const drizzleHash = (j: Journal): Map<number, string> =>
    new Map(readMigrationFiles({ migrationsFolder: DIRS[j] }).map((m) => [Number(m.folderMillis), m.hash]));

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    for (const j of ["mail", "cloud"] as const) {
      await client.unsafe(`create schema if not exists "${SPECS[j].migrationsSchema}"`);
      await client.unsafe(`create table if not exists ${table(j)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    }
  }, 60_000);

  afterAll(async () => {
    for (const j of ["mail", "cloud"] as const) {
      await client?.unsafe(`drop schema if exists "${SPECS[j].migrationsSchema}" cascade`).catch(() => {});
    }
    await client?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  /** Every entry applied honestly, then production's thirty-one rows written over theirs. */
  const seed = async (rows: ReadonlyArray<{ journal: Journal; tag: string; recorded: string }>): Promise<void> => {
    for (const j of ["mail", "cloud"] as const) {
      await client.unsafe(`truncate ${table(j)}`);
      const honest = drizzleHash(j);
      const values = ENTRIES[j].map((e) => {
        const p = rows.find((r) => r.journal === j && r.tag === e.tag);
        const hash = p ? p.recorded : honest.get(e.when)!;
        expect(hash, `${j} ${e.tag}: no hash to seed`).toMatch(/^[0-9a-f]{64}$/);
        return `('${hash}', ${e.when})`;
      });
      await client.unsafe(`insert into ${table(j)} ("hash", "created_at") values ${values.join(", ")}`);
    }
  };
  const statuses = async () => journalStatuses(db, new Map(), [
    { spec: SPECS.mail, entries: ENTRIES.mail },
    { spec: SPECS.cloud, entries: ENTRIES.cloud },
  ]);

  beforeEach(async () => { await seed(PRODUCTION); });

  it("passes, and names every one of the thirty-one it admits", async () => {
    const s = await statuses();
    expect(s.map((x) => `${x.name} ${x.applied}/${x.expected} missing ${x.missing.length}`))
      .toEqual([`mail ${ENTRIES.mail.length}/${ENTRIES.mail.length} missing 0`, `cloud ${ENTRIES.cloud.length}/${ENTRIES.cloud.length} missing 0`]);
    // The bytes still differ — that reading is unchanged, and it is the reason any of this runs.
    expect(s.flatMap((x) => x.mismatched.map((m) => `${x.name} ${m.tag}`)).sort())
      .toEqual(PRODUCTION.map((p) => `${p.journal} ${p.tag}`).sort());
    expect(s.flatMap((x) => x.drift.map((d) => `${d.journal} ${d.tag}: ${d.kind}`)).sort())
      .toEqual(PRODUCTION.map((p) => `${p.journal} ${p.tag}: ${p.verdict}`).sort());
    expect(journalProblems(s), "the setup refused production's own rows").toEqual([]);

    const admitted = admittedDriftLines(s);
    expect(admitted).toHaveLength(PRODUCTION.length);
    for (const p of PRODUCTION) {
      const line = admitted.find((l) => l.startsWith(`${p.journal} ${p.tag}:`));
      expect(line, `${p.journal} ${p.tag} was admitted without being named`).toBeDefined();
      expect(line).toContain("the provenance record names");
    }
  });

  it("a row the record does not name is still refused, naming both readings", async () => {
    const odd = { ...PRODUCTION[1]!, recorded: "0".repeat(63) + "1" };
    await seed(PRODUCTION.map((p) => (p.tag === odd.tag ? odd : p)));
    const problems = journalProblems(await statuses());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("MISDESCRIBED");
    expect(problems[0]).toContain(odd.tag);
    expect(problems[0]).toContain(odd.recorded);
    expect(problems[0]).toContain("No version this file has ever held");
    expect(problems[0]).toContain("nothing may be deployed over it");
  });
});
