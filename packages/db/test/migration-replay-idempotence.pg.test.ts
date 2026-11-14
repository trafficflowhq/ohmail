/* @postpush: alone — this census RE-EXECUTES every migration against the live database, so a row
 * a CO-TENANT leaves can make an older migration refuse. Measured at this batch's tip beside 866
 * co-tenants: mail 0062's CHECK on message_bodies.withheld_reason admits only 'storage_cap' and
 * mail 0065 widened it with 'junk_filed' and 'expunged', so a withheld body stored under either of
 * the newer two made 0062 unreplayable. The same file passes alone on a lane database created from
 * empty, which is the reading. The driver reads this marker and runs the file by itself. */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGACY_CUTOFF_WHEN, OLD_HEADS, migrateToOldHeads, runMigrations, type ServerJournal } from "../src/admin.js";
import {
  journalDrift, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import {
  allMigrations, keyOf, outsideTheWindow, refusedByForm, replayFloorWhen, type MigrationFile,
} from "./_migration-forms.js";

/**
 * EVERY MIGRATION IN BOTH JOURNALS, APPLIED A SECOND TIME — the reading `journal-reissue.pg` and
 * `mailbox-dedup.pg` make for one span, made at every entry separately and over the whole span.
 * Twice in five days a released migration shipped in a form that cannot be applied twice (0118's
 * indexes, then 0120's CHECK) and the guards found it on the shared box AFTER it had landed. The
 * state is not exotic: `adoptBaseline` records the entries below {@link LEGACY_CUTOFF_WHEN}
 * without running them, so the migrator re-executes EVERYTHING above that watermark against a
 * schema that already has it.
 *
 * TWO ROADS, TWO STORES. The 1.0 road (every entry at or below `OLD_HEADS`) is only ever replayed
 * on a store that stands on it: a store below the old head walks the journals cut at the heads
 * before anything of 2.0 runs (`runMigrations`), so those entries are re-executed here against a
 * store AT the old heads, made from empty by that same road. An entry past the 2.0 transition's
 * window is re-executed against this tree's whole schema, as before. The window itself is applied
 * once by construction and is judged by neither half (`outsideTheWindow`).
 */

/**
 * TECHNIQUE, taken from the guards so this measures what they measure: the file is split on
 * `--> statement-breakpoint` as drizzle's `readMigrationFiles` splits it and each statement runs
 * through `unsafe` inside ONE transaction, exactly as the migrator's `tx.execute(sql.raw(stmt))`
 * does. Only the COMMIT is withheld — the effect is read inside the transaction, before the
 * rollback — so this file leaves the lane database as it found it.
 */

/**
 * TWO PROPERTIES, BECAUSE ONLY ONE OF THEM IS PER MIGRATION — measured, not assumed. RAISES
 * NOTHING is per migration: an error aborts the migrator's whole transaction. SCHEMA IDENTITY is
 * not — thirteen entries move a catalog alone because a LATER one retires what they build (0067
 * builds the function 0068 drops), and the migrator never replays one without the rest of the
 * span — so identity is asserted over the WHOLE span the adoption creates, once, and the
 * per-migration move is recorded beside each row rather than refused.
 */

/** Thrown after the measurement to roll the transaction back; never an error about the subject. */
class Rollback extends Error {}

/** One ordered text per catalog class, so a drift names the class and the rows that moved. */
const CATALOG_SQL = `
select
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' '
            || coalesce(column_default, '') || ' ' || coalesce(character_maximum_length::text, '')
            || ' ' || coalesce(numeric_precision::text, '') as x
     from information_schema.columns where table_schema = 'public') s) as columns,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) as x
     from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where n.nspname = 'public') s) as constraints,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select indexname || ' ' || indexdef as x from pg_indexes where schemaname = 'public') s) as indexes,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select t.typname || ' ' || e.enumlabel || ' ' || e.enumsortorder::text as x
     from pg_enum e join pg_type t on t.oid = e.enumtypid
     join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public') s) as enums,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select c.relname || ' ' || t.tgname || ' ' || pg_get_triggerdef(t.oid) as x
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal) s) as triggers,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select p.proname || ' ' || md5(pg_get_functiondef(p.oid)) as x
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f') s) as functions,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select sequence_name as x from information_schema.sequences
     where sequence_schema = 'public') s) as sequences,
  (select coalesce(string_agg(x, chr(10) order by x), '') from (
     select extname || ' ' || extversion as x from pg_extension) s) as extensions
`;

type Catalog = Record<string, string>;

/** What happened when one span of statements was applied a second time. */
interface Replay {
  /** The first statement's error, or `null` when every statement returned. */
  readonly raised: string | null;
  /** `"constraints +1 -0"` per moved class, or `""` when nothing moved. */
  readonly moved: string;
  /** `"constraints <row>"` for every catalog row the replay created. */
  readonly added: string[];
  /** …and for every one it removed. */
  readonly removed: string[];
}

/** How the census reports one migration. */
interface Reading extends Replay {
  readonly key: string;
  /** Is this entry above the replay floor — the only side where a refusal is a defect? */
  readonly above: boolean;
}

const readings: Reading[] = [];
let PG_UP = false;
/** The store the replay under way runs against; the census points it at one road's store at a time. */
let client: ReturnType<typeof postgres> | null = null;
let atOldHeads: ReturnType<typeof postgres> | null = null;
let atHead: ReturnType<typeof postgres> | null = null;
const OLD_STORE = throwawayDb("replay_old_heads");
const onOldRoad = (m: MigrationFile): boolean => m.when <= OLD_HEADS[m.journal as ServerJournal].when;
/** `select 'x' as t, count(*) as n from "x" union all …`, built once from the live catalog. */
let countsSql = "";

/**
 * Counts of every public table as one ordered text — a second application that SEEDS or DELETES
 * rows moves it. Values are deliberately not hashed: an UPDATE rewriting a column it already
 * wrote is invisible here, and that is the static half's review class rather than this file's.
 */
async function countsOf(tx: postgres.TransactionSql): Promise<string> {
  const rows = await tx.unsafe(countsSql) as unknown as Array<{ t: string; n: string }>;
  return rows.map((r) => `${r.t}=${r.n}`).sort().join(",");
}

async function catalogOf(tx: postgres.TransactionSql): Promise<Catalog> {
  const rows = await tx.unsafe(CATALOG_SQL) as unknown as Catalog[];
  return rows[0]!;
}

/** `constraints +1 -2` per moved class, and the rows themselves — a count alone names nothing. */
function movedBetween(before: Catalog, after: Catalog):
    { moved: string; added: string[]; removed: string[] } {
  const parts: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const cls of Object.keys(before)) {
    if (before[cls] === after[cls]) continue;
    const was = new Set((before[cls] ?? "").split("\n").filter(Boolean));
    const now = new Set((after[cls] ?? "").split("\n").filter(Boolean));
    const plus = [...now].filter((x) => !was.has(x));
    const minus = [...was].filter((x) => !now.has(x));
    for (const x of plus) added.push(`${cls} ${x}`);
    for (const x of minus) removed.push(`${cls} ${x}`);
    parts.push(`${cls} +${plus.length} -${minus.length}`);
  }
  return { moved: parts.join(", "), added, removed };
}

/**
 * Apply `statements` a SECOND time against the migrated database and answer what happened. The
 * `prelude` runs BEFORE the first reading, so a control can put its subject in the state a
 * released migration is already in without that setup counting as the change under test.
 */
async function replay(statements: readonly string[], prelude: readonly string[] = []): Promise<Replay> {
  let raised: string | null = null;
  let moved = "";
  let added: string[] = [];
  let removed: string[] = [];
  try {
    await client!.begin(async (tx) => {
      for (const p of prelude) await tx.unsafe(p);
      const before = await catalogOf(tx);
      const countsBefore = await countsOf(tx);
      for (const statement of statements) {
        if (statement.trim() === "") continue;
        try {
          await tx.unsafe(statement);
        } catch (e) {
          raised = e instanceof Error ? e.message.split("\n")[0]! : String(e);
          throw new Rollback();
        }
      }
      const after = await catalogOf(tx);
      ({ moved, added, removed } = movedBetween(before, after));
      const countsAfter = await countsOf(tx);
      if (countsAfter !== countsBefore) moved = `${moved ? `${moved}, ` : ""}row counts`;
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return { raised, moved, added, removed };
}

/**
 * THE ONE CATALOG DIFFERENCE BETWEEN THE TWO POPULATIONS, named rather than tolerated.
 *
 * `refresh_tokens` is built by mail 0060 with these two single-column keys inline, and mail 0118
 * drops them for their account-scoped replacements. A FRESH replay gets them back, because the
 * CLOUD pass runs after the whole mail pass and cloud 0000 re-adds them; the adoption population
 * does not, because cloud 0000 is below the cutoff and is recorded rather than run. So the
 * superseded keys survive on a fresh install and not on an adopted one — 0118's own intent on the
 * adopted side. Asserted as an exact pair so anything else that drifts is red.
 */
const SPAN_KNOWN_DRIFT = [
  "constraints refresh_tokens refresh_tokens_session_id_sessions_id_fk "
  + "FOREIGN KEY (session_id) REFERENCES sessions(id)",
  "constraints refresh_tokens refresh_tokens_user_id_users_id_fk "
  + "FOREIGN KEY (user_id) REFERENCES users(id)",
];

/**
 * MIGRATIONS THIS CENSUS READS NO AND THE TREE DOES NOT EDIT, each with its reason and its class.
 *
 * BELOW THE FLOOR nothing re-executes them, so a refusal is a fact about the file and not about a
 * database: all six are below {@link LEGACY_CUTOFF_WHEN} too, adopted without ever running and
 * sha256-pinned against the pre-split original by `journal-split.test.ts`'s permutation oracle,
 * which reads an edit as a loss AND an invention. ABOVE the floor an entry may not be named here
 * at all — see the arm below.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "mail/0001_cute_black_queen": "below the floor, below the cutoff — bare ADD CONSTRAINT UNIQUE (42P07)",
  "mail/0002_wet_thunderball": "below the floor, below the cutoff — thirteen bare ADD COLUMN (42701)",
  "mail/0007_amusing_nextwave": "below the floor, below the cutoff — four bare ADD COLUMN (42701)",
  "mail/0008_hybrid_search": "below the floor, below the cutoff — two bare ADD COLUMN (42701)",
  "mail/0010_optimal_roland_deschain": "below the floor, below the cutoff — one bare ADD COLUMN (42701)",
  "mail/0015_workflow_step_dedup":
    "below the floor, below the cutoff — two ADD CONSTRAINT UNIQUE inside a DO block that catches "
    + "duplicate_object only, and a UNIQUE constraint's backing index raises duplicate_table (42P07)",
};

/**
 * The allow-list entries the floor does NOT excuse. An above-floor refusal is the 0118/0120 class
 * — a migration the skip window really does re-execute — so naming one here is a statement that a
 * fix is in flight, not that it is tolerable. When that fix lands, the both-directions check
 * above removes its ALLOWED line and this list must go to zero with it.
 */
const ABOVE_FLOOR_ALLOWED: string[] = [];

describe.skipIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")(
  "every migration in both journals is a no-op the second time", () => {
  beforeAll(async () => {
    PG_UP = await realPgAvailable();
    if (!PG_UP) {
      /* A SKIP THAT MEANS DRIFT IS NOT A SKIP. `realPgAvailable` answers false both for "no
       * Postgres here" and for "this database is not this tree's schema", and the second is
       * exactly what editing a migration produces — the state this file's own work creates. A
       * census that passes three arms while measuring nothing is the worst reading of the two, so
       * a reachable server that was refused REFUSES here, with the remedy named. */
      const drift = await journalDrift(PG_TEST_URL).catch(() => null);
      if (drift !== null) {
        throw new Error(`[census] ${drift} Recreate the lane database: scripts/lane-db.sh --drop `
          + `"$PWD" && scripts/lane-db.sh "$PWD".`);
      }
      return;
    }
    await runMigrations(PG_TEST_URL);
    await OLD_STORE.create(migrateToOldHeads);
    atHead = postgres(PG_TEST_URL, { max: 1, onnotice: () => { /* a replay re-raises notices */ } });
    atOldHeads = postgres(OLD_STORE.url, { max: 1, onnotice: () => { /* a replay re-raises notices */ } });
    client = atOldHeads;
    const tables = await client`select table_name from information_schema.tables
                                where table_schema = 'public' and table_type = 'BASE TABLE'
                                order by table_name` as unknown as Array<{ table_name: string }>;
    countsSql = tables
      .map((t) => `select '${t.table_name}' as t, count(*)::text as n from "${t.table_name}"`)
      .join(" union all ");
    expect(tables.length, "the store at the old heads carries the 1.0 schema").toBeGreaterThan(50);
  }, 480_000);

  afterAll(async () => {
    await atHead?.end({ timeout: 5 });
    await atOldHeads?.end({ timeout: 5 });
    await OLD_STORE.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** The count query for whichever store `client` points at: the two stores hold different tables. */
  const pointAt = async (store: ReturnType<typeof postgres>): Promise<void> => {
    client = store;
    const tables = await store`select table_name from information_schema.tables
                               where table_schema = 'public' and table_type = 'BASE TABLE'
                               order by table_name` as unknown as Array<{ table_name: string }>;
    countsSql = tables
      .map((t) => `select '${t.table_name}' as t, count(*)::text as n from "${t.table_name}"`)
      .join(" union all ");
  };

  it("the census: every migration re-executed once against the migrated schema", async () => {
    if (!PG_UP) return;
    const migrations: MigrationFile[] = outsideTheWindow(allMigrations());
    expect(migrations.length, "both journals are present").toBeGreaterThan(100);
    expect(migrations.filter(onOldRoad).length, "the 1.0 road is read").toBeGreaterThan(100);
    for (const [store, road] of [[atOldHeads!, migrations.filter(onOldRoad)], [atHead!, migrations.filter((m) => !onOldRoad(m))]] as const) {
      await pointAt(store);
      for (const m of road) {
        const r = await replay(m.text.split("--> statement-breakpoint"));
        readings.push({ ...r, key: keyOf(m), above: m.when > replayFloorWhen() });
      }
    }
    if (process.env.OHMAIL_MIGRATION_CENSUS === "print") {
      for (const r of readings) {
        const verdict = r.raised === null ? (r.moved === "" ? "YES" : "YES*") : "NO ";
        process.stdout.write(`CENSUS ${verdict} ${r.above ? "above-floor" : "below-floor"} ${r.key}`
          + `${r.raised ?? r.moved ? ` :: ${r.raised ?? r.moved}` : ""}\n`);
      }
    }
    const raisers = readings.filter((r) => r.raised !== null);
    expect(raisers.filter((r) => ALLOWED[r.key] === undefined).map((r) => `${r.key} — ${r.raised}`),
      "migrations that REFUSE a second application").toEqual([]);
    // BOTH DIRECTIONS: an allow-list entry whose migration no longer raises is a line that has
    // stopped being about anything, and it would hide the next one added under it.
    expect(Object.keys(ALLOWED).filter((k) => !raisers.some((r) => r.key === k)),
      "allow-list entries whose migration is idempotent now — remove them").toEqual([]);
    // THE TWO HALVES, HELD TOGETHER HERE because this is the only side that has both: what
    // `migration-idempotent-forms.test.ts` refuses from the TEXT must be exactly what a second
    // application RAISES. A rule that refuses more is a false gate; one that refuses less is the
    // hole 0118 and 0120 came through — 0015's DO block looked wrapped and was not.
    expect(refusedByForm(), "the static rules and the live replay name the same migrations")
      .toEqual(raisers.map((r) => r.key).sort());
    // THE HARD ARM: below the floor a refusal is a fact about a file nothing re-executes; ABOVE it
    // the skip window really does, and that is the 0118/0120 failure. Only a fix in flight may be
    // named there, and it is named twice so neither list can quietly grow.
    const floor = replayFloorWhen();
    const whenOf = new Map(migrations.map((m) => [keyOf(m), m.when]));
    expect(Object.keys(ALLOWED).filter((k) => (whenOf.get(k) ?? 0) > floor).sort(),
      "allow-list entries ABOVE the replay floor — each needs a fix, not a line")
      .toEqual([...ABOVE_FLOOR_ALLOWED].sort());
  }, 900_000);

  it("the skip window's whole span, re-executed in order, leaves the schema identical", async () => {
    if (!PG_UP) return;
    expect(readings.length, "the census ran first").toBeGreaterThan(100);
    const floor = replayFloorWhen();
    expect(floor, "the floor sits above the baseline cutoff").toBeGreaterThan(LEGACY_CUTOFF_WHEN);
    const span = allMigrations().filter((m) => onOldRoad(m) && m.when > floor && ALLOWED[keyOf(m)] === undefined);
    expect(span.length, "the skip window replays everything above the reissue").toBeGreaterThan(40);
    await pointAt(atOldHeads!);
    const r = await replay(span.flatMap((m) => m.text.split("--> statement-breakpoint")));
    expect(r.raised, "the span the adoption replays raises nothing").toBe(null);
    expect(r.added, "…and creates no catalog row a fresh replay does not have").toEqual([]);
    expect(r.removed.sort(), "…and removes only the pair the two populations have always differed by")
      .toEqual(SPAN_KNOWN_DRIFT);
  }, 900_000);

  /**
   * THE CONTROL, on the pair that cost 0.20.1 a red tier: the CHECK constraint the held-release
   * dismissal migration adds. Its prelude puts the constraint in the state a released migration
   * leaves it in; the bare form is then refused, and the same statement with a `DROP CONSTRAINT
   * IF EXISTS` in front of it is admitted and moves nothing. The two arms differ in exactly that
   * one statement, so this watches the deciding line rather than the fixture.
   */
  const BARE = `ALTER TABLE "account_settings" ADD CONSTRAINT "ohmail_census_probe_len" `
    + `CHECK ("held_release_dismissed" IS NULL OR char_length("held_release_dismissed") <= 128)`;
  const DROP = `ALTER TABLE "account_settings" DROP CONSTRAINT IF EXISTS "ohmail_census_probe_len"`;
  const PROBE_SHA = createHash("sha256").update(BARE).digest("hex").slice(0, 8);

  it("control: the bare ADD CONSTRAINT refuses a second application, the flat form does not", async () => {
    if (!PG_UP) return;
    expect(PROBE_SHA).toHaveLength(8);
    await pointAt(atHead!);
    const bare = await replay([BARE], [DROP, BARE]);
    expect(bare.raised, "a bare ADD CONSTRAINT over one that exists").toMatch(/already exists/);

    const flat = await replay([DROP, BARE], [DROP, BARE]);
    expect(flat.raised, "the flat form over one that exists").toBe(null);
    expect(flat.moved, "…and it moves no catalog").toBe("");
  }, 300_000);
});
