import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";

/**
 * BASELINE ADOPTION — teaching an already-migrated database that it is already migrated.
 *
 * The schema split cut one migration journal into two: a publishable
 * mail-domain half and a private Cloud half. Production, the docker test database and every
 * developer's database all took the SINGLE journal and already carry all 55 tables. Point the
 * two-journal migrator at one of them and it finds an empty `drizzle_mail.__drizzle_migrations`,
 * concludes nothing has ever been applied, and replays the whole mail journal over a live
 * database.
 *
 * That replay does not fail cleanly, which is the dangerous part. Nearly every statement in the
 * history is `IF NOT EXISTS`, and the foreign keys are
 * `DO $$ … EXCEPTION WHEN duplicate_object`, so most of it SUCCEEDS silently. It happens to die
 * at `0002_wealthy…`'s bare `ALTER TABLE "messages" ADD COLUMN "thread_id"` — the one statement
 * in the journal without `IF NOT EXISTS` — and because drizzle runs all pending migrations in a
 * single transaction, that rolls the pass back. Loud and recoverable, but only by the accident
 * of one statement's spelling, and the Cloud pass would need its own separate luck.
 *
 * So adoption runs FIRST and writes the bookkeeping rows the two new journals would have
 * written, without executing their DDL.
 *
 * ── WHY THE LEGACY TABLE IS SUFFICIENT EVIDENCE ──
 *
 * `drizzle.__drizzle_migrations` with all {@link LEGACY_JOURNAL_WHENS} present does not merely
 * suggest the pre-split journal ran — it PROVES it, because `PgDialect.migrate` applies every
 * pending migration inside ONE transaction. There is no state in which 24 rows exist and the
 * 24th file's statements did not run. Short of somebody hand-inserting rows, which is not a
 * failure mode a program can defend against, that is a complete proof.
 *
 * The object probe below is therefore a second, independent check rather than the primary one —
 * it catches a schema that has been altered by hand since (a table dropped as "cleanup"), and
 * it is DERIVED FROM THE JOURNAL SQL rather than hand-maintained, so it can never drift from
 * what the baseline actually creates.
 *
 * ── THE FAILURE THIS FILE MUST NEVER HAVE ──
 *
 * Marking a migration applied whose effects are absent. That is permanent: the entry is skipped
 * forever, and because production ran the original journal it keeps the object while every
 * database created afterwards lacks it. Two rules close it:
 *
 *  1. **The baseline is frozen by a CUTOFF, not by "this journal's entries."** If the insert set
 *     were "every entry in the journal", the moment somebody appends migration 22 to the mail
 *     journal the next production run would mark it applied without running it. It is
 *     `when <= LEGACY_CUTOFF_WHEN` and nothing else.
 *  2. **The insert set and the verification set are the SAME computed set.** Both come from
 *     {@link baselineEntries}. A hand-maintained marker list beside a journal-derived insert
 *     list is exactly how the two drift.
 */

/**
 * The `when` of the LAST entry of the pre-split journal (`0023_email_verification`).
 *
 * Everything at or below this timestamp existed before the split and is therefore adoptable;
 * everything above it is a migration written AFTER the split and must actually run. Frozen as a
 * literal on purpose — deriving it from a journal's length or last entry would make it move
 * every time somebody adds a migration, which is the precise bug it exists to prevent.
 */
export const LEGACY_CUTOFF_WHEN = 1786006486206;

/**
 * Every `when` in the pre-split journal, in order. Committed as data because it is EVIDENCE:
 * this is the fingerprint of a database that took the single-journal path, and the pre-split
 * journal's own metadata file is retained alongside it for the same reason.
 */
export const LEGACY_JOURNAL_WHENS: readonly number[] = [
  1785184187039, 1785185425588, 1785189005449, 1785190651291, 1785192935050, 1785194204180,
  1785197635203, 1785207104501, 1785209590445, 1785211170579, 1785212770816, 1785214381004,
  1785216438278, 1785219327084, 1785221291809, 1785221291810, 1785225286206, 1785570886206,
  1785574486206, 1785660886206, 1785747286206, 1785833686206, 1785920086206, LEGACY_CUTOFF_WHEN,
] as const;

/** One of the two live journals. */
export interface JournalSpec {
  /** `mail` | `cloud` — used in messages and nowhere else. */
  readonly name: string;
  /** Absolute path to the drizzle folder. */
  readonly dir: string;
  /** The schema its `__drizzle_migrations` table lives in. Pinned, never discovered. */
  readonly migrationsSchema: string;
}

export interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

export function readJournalOf(spec: JournalSpec): JournalEntry[] {
  const raw = readFileSync(join(spec.dir, "meta", "_journal.json"), "utf8");
  const entries = (JSON.parse(raw) as { entries?: JournalEntry[] }).entries ?? [];
  if (entries.length === 0) {
    throw new Error(`${spec.name} journal is empty — refusing to 'set up' nothing`);
  }
  return entries;
}

/**
 * The entries of `spec` that predate the split — the ADOPTABLE set, and the set the object
 * probe is derived from. One filter, two uses, deliberately.
 */
export function baselineEntries(spec: JournalSpec): JournalEntry[] {
  return readJournalOf(spec).filter((e) => e.when <= LEGACY_CUTOFF_WHEN);
}

/** Objects a journal's baseline creates. Parsed from its own SQL, so it cannot drift. */
export interface BaselineObjects {
  tables: string[];
  /** `[table, column]` pairs added by `ALTER TABLE … ADD COLUMN`. */
  columns: Array<[string, string]>;
  indexes: string[];
  triggers: string[];
}

/**
 * Objects the CLOUD baseline created that the MAIL journal now ALSO creates — `refresh_tokens`
 * and its two indexes, adopted by mail 0060 (Phase 3: a paired device's refresh family
 * rotates against the store that serves it; `journal-split.test.ts` pins the arbitration).
 *
 * They are EXCLUDED from the cloud baseline's object probe because their presence stopped
 * discriminating provenance, and the adoption verdict is a provenance question: a database
 * built by the two-journal path holds them the moment the mail journal has run, so counting
 * them puts every ordinary fresh setup into the "some objects, no evidence" cell — the exact
 * refusal the verdict's step 0 note says must not fire on the ordinary path. The cost is one
 * table's worth of the altered-by-hand check on a genuine adoption, and mail 0060's guarded
 * CREATE restores the object on the next migrate anyway.
 */
const CLOUD_OBJECTS_ADOPTED_BY_MAIL = {
  tables: new Set(["refresh_tokens"]),
  indexes: new Set(["refresh_tokens_family_idx", "refresh_tokens_session_idx"]),
};

export function baselineObjects(spec: JournalSpec): BaselineObjects {
  const tables = new Set<string>();
  const columns = new Map<string, [string, string]>();
  const indexes = new Set<string>();
  const triggers = new Set<string>();

  for (const entry of baselineEntries(spec)) {
    const sqlText = readFileSync(join(spec.dir, `${entry.tag}.sql`), "utf8")
      .replace(/^\s*--[^\n]*$/gm, "");
    let m: RegExpExecArray | null;

    const tableRe = /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/gi;
    while ((m = tableRe.exec(sqlText))) tables.add(m[1]!);

    const colRe = /ALTER TABLE "([a-z_]+)" ADD COLUMN (?:IF NOT EXISTS )?"([a-z_]+)"/gi;
    while ((m = colRe.exec(sqlText))) columns.set(`${m[1]}.${m[2]}`, [m[1]!, m[2]!]);

    const idxRe = /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([a-z_]+)"/gi;
    while ((m = idxRe.exec(sqlText))) indexes.add(m[1]!);

    const trgRe = /CREATE (?:CONSTRAINT )?TRIGGER\s+"?([a-z_]+)"?/gi;
    while ((m = trgRe.exec(sqlText))) triggers.add(m[1]!);
  }

  // A `DROP INDEX` later in the same baseline un-creates an index the probe would otherwise
  // demand. `0021` dropped `users_email_idx` after `0003` created it, so requiring it would
  // make adoption refuse every correctly-migrated database.
  for (const entry of baselineEntries(spec)) {
    const sqlText = readFileSync(join(spec.dir, `${entry.tag}.sql`), "utf8");
    const dropRe = /DROP INDEX IF EXISTS "([a-z_]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = dropRe.exec(sqlText))) indexes.delete(m[1]!);
  }

  // The adopted table — see {@link CLOUD_OBJECTS_ADOPTED_BY_MAIL}.
  if (spec.name === "cloud") {
    for (const t of CLOUD_OBJECTS_ADOPTED_BY_MAIL.tables) tables.delete(t);
    for (const i of CLOUD_OBJECTS_ADOPTED_BY_MAIL.indexes) indexes.delete(i);
  }

  return {
    tables: [...tables].sort(),
    columns: [...columns.values()].sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`)),
    indexes: [...indexes].sort(),
    triggers: [...triggers].sort(),
  };
}

/** Anything that can run a statement. Both postgres-js and PGlite handles satisfy it. */
export interface Executor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Normalize the driver-specific `execute` shape: postgres-js returns an ARRAY, PGlite returns
 * `{ rows }`. Same helper as `health.ts` / `search-service.ts`, and it is not optional
 * here — adoption runs on BOTH drivers. `makeTestDb()` adopts into PGlite (where the verdict is
 * always `fresh`), and without this every probe below would call `.map` on an object.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  return rowsOf<T>(await db.execute(query));
}

/**
 * Locate the LEGACY migrations table by NAME, across schemas.
 *
 * Deliberately name-based, and the only place in the split that still is: `setup-prod.ts`
 * records that `__drizzle_migrations` "has lived in `public` in older versions", and finding it
 * somewhere unexpected is the entire point here. If it were addressed as `drizzle.…` and an old
 * environment kept it in `public`, adoption would read "absent ⇒ fresh database", and the
 * migrator would replay the journal over a populated one.
 *
 * The two NEW tables are the opposite case and are always addressed by their pinned schema —
 * name-based discovery there is what made `setup-prod`'s verification vacuously true.
 */
export async function findLegacyMigrationsTable(db: Executor): Promise<string | null> {
  const found = await rows<{ table_schema: string }>(db, sql`
    select table_schema from information_schema.tables
     where table_name = '__drizzle_migrations'
       and table_schema not in ('drizzle_mail', 'drizzle_cloud')
     order by (table_schema = 'drizzle') desc, table_schema
     limit 1`);
  return found[0]?.table_schema ?? null;
}

export type AdoptionVerdict =
  /** This half already has bookkeeping — nothing to adopt. */
  | { kind: "already_tracked"; rows: number }
  /** No legacy evidence and none of this half's objects: a virgin database. Let the migrator run. */
  | { kind: "fresh" }
  /** Legacy evidence is complete and so is the schema: write the baseline rows. */
  | { kind: "adopt"; entries: JournalEntry[] };

export class AdoptionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptionRefused";
  }
}

/** Which of the baseline's objects are MISSING from `public`. */
export async function missingObjects(db: Executor, spec: JournalSpec): Promise<string[]> {
  const want = baselineObjects(spec);
  const missing: string[] = [];

  if (want.tables.length > 0) {
    const present = new Set((await rows<{ table_name: string }>(db, sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
         and table_name in ${sql.raw(`(${want.tables.map((t) => `'${t}'`).join(", ")})`)}`))
      .map((r) => r.table_name));
    for (const t of want.tables) if (!present.has(t)) missing.push(`table ${t}`);
  }

  if (want.columns.length > 0) {
    const pairs = want.columns.map(([t, c]) => `('${t}','${c}')`).join(", ");
    const present = new Set((await rows<{ table_name: string; column_name: string }>(db, sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in ${sql.raw(`(${pairs})`)}`))
      .map((r) => `${r.table_name}.${r.column_name}`));
    for (const [t, c] of want.columns) if (!present.has(`${t}.${c}`)) missing.push(`column ${t}.${c}`);
  }

  if (want.indexes.length > 0) {
    const present = new Set((await rows<{ indexname: string }>(db, sql`
      select indexname from pg_indexes where schemaname = 'public'
         and indexname in ${sql.raw(`(${want.indexes.map((i) => `'${i}'`).join(", ")})`)}`))
      .map((r) => r.indexname));
    for (const i of want.indexes) if (!present.has(i)) missing.push(`index ${i}`);
  }

  if (want.triggers.length > 0) {
    const present = new Set((await rows<{ tgname: string }>(db, sql`
      select g.tgname from pg_trigger g
        join pg_class t on t.oid = g.tgrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public' and not g.tgisinternal
         and g.tgname in ${sql.raw(`(${want.triggers.map((t) => `'${t}'`).join(", ")})`)}`))
      .map((r) => r.tgname));
    for (const t of want.triggers) if (!present.has(t)) missing.push(`trigger ${t}`);
  }

  return missing;
}

/**
 * Decide what to do about `spec` on this database, WITHOUT writing anything.
 *
 * The order of the questions is the design. Step 0 comes first because a database built by the
 * two-journal path has no legacy table and DOES have the objects — which is the "unknown
 * provenance" cell below, and it would otherwise refuse every ordinary re-run.
 *
 * | this half tracked | legacy evidence | this half's objects | verdict |
 * |---|---|---|---|
 * | yes               | any             | any                 | `already_tracked` |
 * | no                | all 24 whens    | complete            | `adopt` |
 * | no                | absent          | none                | `fresh` |
 * | no                | absent          | some                | **THROW** — unknown provenance |
 * | no                | incomplete      | any                 | **THROW** — mid-migration |
 * | no                | all 24 whens    | incomplete          | **THROW** — schema altered by hand |
 */
export async function adoptionVerdict(db: Executor, spec: JournalSpec): Promise<AdoptionVerdict> {
  const tracked = await rows<{ n: number | string }>(db, sql`
    select count(*)::int as n from information_schema.tables
     where table_schema = ${spec.migrationsSchema} and table_name = '__drizzle_migrations'`);
  if (Number(tracked[0]?.n ?? 0) > 0) {
    const counted = await rows<{ n: number | string }>(db, sql`
      select count(*)::int as n from ${sql.raw(`"${spec.migrationsSchema}"."__drizzle_migrations"`)}`);
    const n = Number(counted[0]?.n ?? 0);
    if (n > 0) return { kind: "already_tracked", rows: n };
  }

  const legacySchema = await findLegacyMigrationsTable(db);
  const missing = await missingObjects(db, spec);
  const objects = baselineObjects(spec);
  const total = objects.tables.length + objects.columns.length + objects.indexes.length
    + objects.triggers.length;

  if (legacySchema === null) {
    if (missing.length === total) return { kind: "fresh" };
    throw new AdoptionRefused(
      `refusing to adopt the ${spec.name} baseline: this database has ${total - missing.length} of ` +
      `${total} pre-split objects but NO \`__drizzle_migrations\` table anywhere, so there is no ` +
      `evidence of how it was built. Adopting could mark a migration applied that never ran, and ` +
      `migrating would replay DDL over live objects. If this is a scratch database, drop it ` +
      `(\`docker compose down -v\`, or \`drop database\`); if it is not, restore its migrations ` +
      `table before going further.`,
    );
  }

  const applied = new Set((await rows<{ created_at: string | number }>(db, sql`
    select created_at from ${sql.raw(`"${legacySchema}"."__drizzle_migrations"`)}`))
    .map((r) => Number(r.created_at)));
  const absent = LEGACY_JOURNAL_WHENS.filter((w) => !applied.has(w));
  if (absent.length > 0) {
    throw new AdoptionRefused(
      `refusing to adopt the ${spec.name} baseline: \`${legacySchema}.__drizzle_migrations\` is ` +
      `missing ${absent.length} of the ${LEGACY_JOURNAL_WHENS.length} pre-split entries ` +
      `(${absent.join(", ")}). This database stopped part-way through the single-journal era and ` +
      `the migrations it still needs no longer exist in that form. A human has to decide: for a ` +
      `scratch database, drop it; for anything else, migrate it with the pre-split code first.`,
    );
  }

  if (missing.length > 0) {
    throw new AdoptionRefused(
      `refusing to adopt the ${spec.name} baseline: the pre-split journal is complete but ` +
      `${missing.length} object(s) it creates are absent — ${missing.slice(0, 10).join(", ")}` +
      `${missing.length > 10 ? `, and ${missing.length - 10} more` : ""}. Something altered this ` +
      `schema outside the migrator. Adopting would record those migrations as applied and they ` +
      `would never run again.`,
    );
  }

  return { kind: "adopt", entries: baselineEntries(spec) };
}

/** A transactional handle — both drivers' `db.transaction` give one. */
export interface TxRunner {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}

/**
 * The sha256 drizzle would have stored for a migration file. It is never re-verified after
 * apply, so this is cosmetic — but a row whose hash is a lie is a row that misleads whoever
 * reads it during an incident, so it is computed properly.
 */
async function hashOf(spec: JournalSpec, tag: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(readFileSync(join(spec.dir, `${tag}.sql`))).digest("hex");
}

/**
 * ENTRIES THAT EXIST TWICE IN ONE JOURNAL — a reissue re-running an original's statement from a
 * fresh position — and the bookkeeping row the original is owed wherever only the reissue ran.
 *
 * The one case so far: mail `0066_folders_enabled` was first minted BETWEEN two entries another
 * lane had already landed and applied, and drizzle's single-watermark migrator skips an entry at
 * or below `max(created_at)` forever, silently. `0069_folders_enabled_reissue` re-runs the same
 * idempotent statement from above the maximum (the file is a BYTE COPY of 0066's, deliberately:
 * drizzle records the sha256 of the file it applied, and a database that ran the intermediate
 * retimed repair holds a row at the reissue's `when` whose hash is 0066's file — identical bytes
 * make that row describe the current journal entry exactly).
 *
 * What the reissue cannot do is give the SKIPPED population 0066's own bookkeeping row: such a
 * database records the reissue's `when` and still has a hole at the original's, so
 * `journalStatuses()` — which requires every journal `when` — would report the journal
 * incomplete and abort the canonical setup path over a column the reissue just created. This
 * adoption closes exactly that hole: once the REISSUE's row exists, the ORIGINAL's row is
 * recorded too (same hash — the files are byte-identical), idempotently, under the same unique
 * index on `created_at` that turns a race into a loud failure. It never runs ahead of the
 * reissue, so a database that has genuinely applied neither stays honestly incomplete.
 */
const REISSUED_ORIGINALS: ReadonlyArray<{
  journal: string;
  original: { tag: string; when: number };
  reissue: {
    when: number;
    /**
     * FULL-FILE sha256s the reissue's row may carry from SUPERSEDED forms of the file — the
     * one so far is the review-round intermediate whose file carried its own explanatory
     * header before the byte-copy ruling. A row holding one of these is rewritten to the
     * canonical hash (the byte-copy's, which is also the original file's), so every supported
     * migration history ends with bookkeeping that describes the shipped journal — the same
     * claim the adoption makes for the missing row, applied to the mis-described one.
     */
    priorHashes: readonly string[];
  };
}> = [
  {
    journal: "mail",
    original: { tag: "0066_folders_enabled", when: 1790982140530 },
    reissue: {
      when: 1791154940527,
      priorHashes: ["ac41c89e9a966ad47bba888d5e867cd8950650ed842f61b4d6852cae487bd111"],
    },
  },
];

/**
 * Record the original entry's row wherever only its reissue ran — see {@link REISSUED_ORIGINALS}.
 * Runs AFTER the migrator pass (the reissue's row must exist first) and is a no-op everywhere
 * else. Returns the tags recorded, `adoptBaseline`'s idempotency-proof shape.
 */
export async function adoptReissuedOriginals(
  db: Executor & TxRunner,
  spec: JournalSpec,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const mine = REISSUED_ORIGINALS.filter((r) => r.journal === spec.name);
  if (mine.length === 0) return [];
  const tableId = sql.raw(`"${spec.migrationsSchema}"."__drizzle_migrations"`);
  // The unique index the ON CONFLICT below needs. `adoptBaseline` creates it on the adoption
  // path, but a VIRGIN replay skips adoption entirely and drizzle's own table ships with no
  // constraint at all — so it is ensured here too, idempotently, and it carries the same
  // second job everywhere: a duplicate-`when` collision fails LOUDLY instead of the migrator
  // skipping it in silence.
  await db.execute(sql`create unique index if not exists
    ${sql.raw(`"__drizzle_migrations_created_at_uq_${spec.migrationsSchema}"`)}
    on ${tableId} (created_at)`);
  const took: string[] = [];
  for (const r of mine) {
    const reissued = await rows<{ n: number | string }>(db, sql`
      select count(*)::int as n from ${tableId} where created_at = ${r.reissue.when}`);
    if (Number(reissued[0]?.n ?? 0) === 0) continue;
    const hash = await hashOf(spec, r.original.tag);
    // A row written by a SUPERSEDED form of the reissue file carries that form's hash; rewrite
    // it to the canonical one (see `priorHashes`), so the row describes the shipped journal.
    for (const prior of r.reissue.priorHashes) {
      const healed = await db.execute(sql`
        update ${tableId} set "hash" = ${hash}
        where created_at = ${r.reissue.when} and "hash" = ${prior}
        returning id`);
      if (rowsOf(healed).length > 0) {
        log(`${spec.name}: canonicalized the reissue row's hash at ${r.reissue.when}`);
      }
    }
    const res = await db.execute(sql`
      insert into ${tableId} ("hash", "created_at") values (${hash}, ${r.original.when})
      on conflict (created_at) do nothing returning id`);
    if (rowsOf(res).length > 0) {
      took.push(r.original.tag);
      log(`${spec.name}: recorded ${r.original.tag} — its reissue ran here, the original's row was owed`);
    }
  }
  return took;
}

/**
 * Write the baseline rows for `spec`, idempotently. Returns the tags adopted (empty on a
 * re-run, which is the idempotency proof `setupProdDatabase` reports).
 *
 * The UNIQUE INDEX on `created_at` is not decoration. drizzle's own table is
 * `(id SERIAL, hash text, created_at bigint)` with no constraint at all, so a plain
 * `WHERE NOT EXISTS` races two concurrent adopters into duplicate rows. It also converts a
 * duplicate-`when` collision — which the migrator's `<` comparison would otherwise skip in
 * SILENCE — into a loud failure.
 */
export async function adoptBaseline(
  db: Executor & TxRunner,
  spec: JournalSpec,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const verdict = await adoptionVerdict(db, spec);
  if (verdict.kind === "already_tracked") {
    log(`${spec.name}: already tracked (${verdict.rows} rows) — nothing to adopt`);
    return [];
  }
  if (verdict.kind === "fresh") {
    log(`${spec.name}: virgin database — the migrator will apply the whole journal`);
    return [];
  }

  const schemaId = sql.raw(`"${spec.migrationsSchema}"`);
  const tableId = sql.raw(`"${spec.migrationsSchema}"."__drizzle_migrations"`);
  const hashes = await Promise.all(verdict.entries.map(async (e) => [e, await hashOf(spec, e.tag)] as const));

  const adopted = await db.transaction(async (tx) => {
    await tx.execute(sql`create schema if not exists ${schemaId}`);
    await tx.execute(sql`create table if not exists ${tableId} (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await tx.execute(sql`create unique index if not exists
      ${sql.raw(`"__drizzle_migrations_created_at_uq_${spec.migrationsSchema}"`)}
      on ${tableId} (created_at)`);
    const took: string[] = [];
    for (const [entry, hash] of hashes) {
      const res = await tx.execute(sql`
        insert into ${tableId} ("hash", "created_at") values (${hash}, ${entry.when})
        on conflict (created_at) do nothing returning id`);
      if (rowsOf(res).length > 0) took.push(entry.tag);
    }
    return took;
  });

  log(
    adopted.length === 0
      ? `${spec.name}: baseline already adopted — no rows written`
      : `${spec.name}: adopted ${adopted.length} pre-split entries (${adopted[0]} … ${adopted.at(-1)})`,
  );
  return adopted;
}
