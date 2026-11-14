import { sql } from "drizzle-orm";
import {
  ensureConcurrentIndexes, type ConcurrentIndexSpec, type SqlExecutor,
} from "./concurrent-index.js";
import { pgDialect } from "./dialect/pg.js";
import { MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS } from "./migration-lock.js";

const rowsOf = <T,>(r: unknown): T[] =>
  Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);

/**
 * Search EXTENSION setup, kept deliberately OUT of the shared migrator. `makeTestDb()` replays
 * the journal into PGlite for every unit test, and PGlite has no `pg_trgm`, so a `CREATE
 * EXTENSION` there would take the whole suite red. This runs ONLY against a real Postgres: the
 * search pg tests call it in `beforeAll`, and production setup calls it once after migrating.
 * Idempotent — `IF NOT EXISTS` throughout. The tsvector columns and their GIN indexes are NOT
 * here: they are core-Postgres generated columns in migration 0008 and replay fine into PGlite.
 * This file adds only the `pg_trgm` extension plus the trigram GIN indexes on the search
 * document's substring corpus, whole and each of its two sides.
 */

/**
 * The search document's trigram GIN indexes, built CONCURRENTLY: setup runs on the live database,
 * where a plain build holds every write for the whole scan. So it needs an autocommit session,
 * like every other prebuild here. The two on `messages` (subject, sender) served the arm for
 * letters without a document; mail 0200 drops them with the old search and nothing builds them
 * again. Where the old search still stands they stand too, built by an earlier setup.
 */
export const TRIGRAM_INDEX_SPECS: readonly ConcurrentIndexSpec[] = [
  {
    // The typo arm over the search document's substring corpus (mail 0125): subject, senders,
    // recipients and file names in one column. The ACCOUNT leads (btree_gin): a trigram's candidates
    // are then one account's, where the plain index handed a smaller account every account's
    // candidates to re-check, and its typo page ran past the budget. The pending list is bounded as
    // mail 0152 bounds the journal's two: every search reads it whole.
    name: "message_search_terms_trgm_idx",
    table: "message_search",
    ddl: sql`create index concurrently if not exists "message_search_terms_trgm_idx"
      on public.message_search using gin ("account_id", "terms" gin_trgm_ops) with (gin_pending_list_limit = 256)`,
  },
  {
    // The substring arm: the corpus's header text (subject, people), before the names' mark (U+001F),
    // so `axa` inside `myAXA` or inside a recipient's domain is one index read. The expression is the
    // dialect's own (`split_part`, the mark inline as `chr(31)`); a test holds the two equal.
    name: "message_search_head_terms_trgm_idx",
    table: "message_search",
    ddl: sql`create index concurrently if not exists "message_search_head_terms_trgm_idx"
      on public.message_search using gin ("account_id", (split_part("terms", chr(31), 1)) gin_trgm_ops) with (gin_pending_list_limit = 256)`,
  },
  {
    // The file names after the mark: the branch of the arm that reads a body word's start.
    name: "message_search_names_trgm_idx",
    table: "message_search",
    ddl: sql`create index concurrently if not exists "message_search_names_trgm_idx"
      on public.message_search using gin ("account_id", (split_part("terms", chr(31), 2)) gin_trgm_ops) with (gin_pending_list_limit = 256)`,
  },
];

/**
 * `concurrently: false` — a store nothing else writes to while it builds; see `plainIndexDdl`. The
 * desktop's PGlite, and every test hook: a concurrent build waits on every snapshot older than it
 * in the whole database, and a test database has no live writer to protect.
 */
export async function ensureSearchExtensions(
  db: SqlExecutor, opts: { log?: (msg: string) => void; concurrently?: boolean } = {},
): Promise<void> {
  // The fuzzy arm's word_similarity()/`<%` operator lives in pg_trgm; btree_gin lets a trigram
  // index lead with the account.
  await db.execute(sql`create extension if not exists pg_trgm`);
  await db.execute(sql`create extension if not exists btree_gin`);
  await ensureConcurrentIndexes(db, TRIGRAM_INDEX_SPECS, {
    label: "the trigram index build",
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.concurrently === false ? { concurrently: false } : {}),
  });
}

/**
 * THE WORD ARMS' ACCOUNT-KEYED INDEX: the account as an expression no other index carries, so a
 * keyed word read (`search.wordKey`) is one GIN AND inside this index. Keyed by the column, the
 * planner read the account off `message_search_terms_trgm_idx` and asked every one of its vectors.
 * One index over both vectors: two would offer the planner a key-only scan. Partial on its own key,
 * which every row has: only a keyed read implies the predicate, so an unkeyed word read never takes
 * this index over the plain GINs. It needs btree_gin
 * ({@link ensureSearchExtensions}) and is never built on the desktop's store.
 */
export const WORD_INDEX_SPEC: ConcurrentIndexSpec = {
  name: "message_search_words_idx",
  table: "message_search",
  ddl: sql`create index concurrently if not exists "message_search_words_idx"
      on public.message_search using gin (((account_id)::text), head_tsv, text_tsv) with (gin_pending_list_limit = 256)
      where ((account_id)::text) is not null`,
};

/** Builds {@link WORD_INDEX_SPEC}, after {@link ensureSearchExtensions}; `concurrently: false` as there. */
export async function ensureWordIndex(
  db: SqlExecutor, opts: { log?: (msg: string) => void; concurrently?: boolean } = {},
): Promise<void> {
  await ensureConcurrentIndexes(db, [WORD_INDEX_SPEC], {
    label: "the word index build",
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.concurrently === false ? { concurrently: false } : {}),
  });
}

/**
 * THE OLD SEARCH, RETIRED WHERE NOTHING IS FOUND BY IT ALONE. Mail 0200 drops it under a guard: no
 * living letter without a search document in an account whose index was never stamped built. A
 * store that still held one keeps the whole old search (`messages.subject_tsv`,
 * `message_bodies.body_tsv`, the trigger, its functions, four indexes) and its search goes on
 * reading it; this step, after the journals at every setup, runs 0200's own statements once that
 * count is zero. Until then it does what it did before 0200: 0140's trigger is re-pointed at a
 * function that stores no vector, and the body GIN goes once no account searches by it.
 *
 * It never creates the trigger or its function on a store without `body_tsv`: `new.body_tsv :=
 * null` would then fail every body insert.
 */
export const BODY_VECTOR_CLEARED_FUNCTION_DDL = sql`create or replace function public.message_bodies_body_tsv_cleared() returns trigger language plpgsql as $$ begin new.body_tsv := null; return new; end; $$`;

/** SHARE ROW EXCLUSIVE on `message_bodies` (measured): reads go on, a body write waits for it. */
export const BODY_VECTOR_TRIGGER_DDL = sql`create or replace trigger message_bodies_body_tsv_tg before insert or update of "text" on public.message_bodies for each row execute function public.message_bodies_body_tsv_cleared()`;

export const BODY_VECTOR_INDEX = "message_bodies_body_tsv_idx";
const BOUNDED_FN = "message_bodies_body_tsv_bounded";
const CLEARED_FN = "message_bodies_body_tsv_cleared";

/**
 * Mail 0200's retirement, statement by statement: what its guarded block runs, in its order. A
 * test holds the two equal. `index` statements may run CONCURRENTLY outside a transaction.
 */
export const OLD_SEARCH_RETIREMENT: ReadonlyArray<{ kind: "ddl" | "index"; sql: string }> = [
  { kind: "ddl", sql: `DROP TRIGGER IF EXISTS "message_bodies_body_tsv_tg" ON "message_bodies"` },
  { kind: "ddl", sql: `DROP FUNCTION IF EXISTS "message_bodies_body_tsv_bounded"()` },
  { kind: "ddl", sql: `DROP FUNCTION IF EXISTS "message_bodies_body_tsv_cleared"()` },
  { kind: "index", sql: `DROP INDEX IF EXISTS "message_bodies_body_tsv_idx"` },
  { kind: "ddl", sql: `ALTER TABLE "message_bodies" DROP COLUMN IF EXISTS "body_tsv"` },
  { kind: "index", sql: `DROP INDEX IF EXISTS "messages_subject_tsv_idx"` },
  { kind: "index", sql: `DROP INDEX IF EXISTS "messages_subject_trgm_idx"` },
  { kind: "index", sql: `DROP INDEX IF EXISTS "messages_from_address_trgm_idx"` },
  { kind: "ddl", sql: `ALTER TABLE "messages" DROP COLUMN IF EXISTS "subject_tsv"` },
];

/** A statement could not take its lock within its bounded waits; what ran before it stays done, and a re-run finishes. */
export class BodyVectorLockTimeout extends Error {
  override name = "BodyVectorLockTimeout";
}

export interface OldSearchRetirement {
  /** Do the two old columns stand after the step? `gone` on a store 0200 or an earlier run retired. */
  columns: "standing" | "gone";
  /** What the trigger runs after the step; `other` is a function this step does not know, left alone. */
  trigger: "cleared" | "bounded" | "absent" | "other";
  gin: "dropped" | "kept" | "absent";
  /** Accounts with living mail and no built search index: their search still reads the old vector. */
  owedAccounts: number;
  /** Living letters only the old search finds: 0200's own count. The old search goes when it is zero. */
  owedLetters: number;
}

/**
 * The pass whose done mark says an account's search documents are all built (`pass_progress`,
 * mail 0203; `account_settings.search_index_built_at` until then, which mail 0200's own guard
 * still reads: it runs before 0203). Spelled here because this module may not reach the door:
 * the desktop engine loads it with the journal alone.
 */
const SEARCH_INDEX_JOB = "search_index_backfill";

type OldSearchState = { column: boolean; runs: string | null; valid: boolean | null; owed: number; letters: number };

async function oldSearchState(db: SqlExecutor): Promise<OldSearchState> {
  const [r] = rowsOf<{ col: boolean; runs: string | null; valid: boolean | null; owed: number; letters: number }>(await db.execute(sql`
    select exists (select 1 from information_schema.columns c where c.table_schema = 'public'
                    and ((c.table_name = 'message_bodies' and c.column_name = 'body_tsv')
                      or (c.table_name = 'messages' and c.column_name = 'subject_tsv'))) as col,
           (select p.proname::text from pg_trigger t join pg_proc p on p.oid = t.tgfoid
             where t.tgrelid = to_regclass('public.message_bodies') and t.tgname = 'message_bodies_body_tsv_tg') as runs,
           (select i.indisvalid from pg_index i where i.indexrelid = to_regclass(${`public.${BODY_VECTOR_INDEX}`})) as valid,
           (select count(*)::int from (select distinct mb.account_id from public.mailboxes mb) a
             where exists (select 1 from public.messages m where m.account_id = a.account_id and m.deleted_at is null)
               and not exists (select 1 from public.pass_progress p
                                where p.account_id = a.account_id and p.subject_id = a.account_id
                                  and p.job = ${SEARCH_INDEX_JOB} and p.done_at is not null)) as owed,
           (select count(*)::int from public.messages m
             where m.deleted_at is null
               and not exists (select 1 from public.message_search s where s.message_id = m.id)
               and not exists (select 1 from public.pass_progress p
                                where p.account_id = m.account_id and p.subject_id = m.account_id
                                  and p.job = ${SEARCH_INDEX_JOB} and p.done_at is not null)) as letters`));
  return { column: Boolean(r?.col), runs: r?.runs ?? null, valid: r?.valid ?? null, owed: Number(r?.owed ?? 0), letters: Number(r?.letters ?? 0) };
}

const triggerVerdict = (s: OldSearchState): OldSearchRetirement["trigger"] =>
  s.runs === null ? "absent" : s.runs === BOUNDED_FN ? "bounded" : s.runs === CLEARED_FN ? "cleared" : "other";
/** An invalid leftover serves no read, so it goes whatever is owed. */
const ginGoes = (s: OldSearchState): boolean => s.valid === false || (s.valid === true && s.owed === 0);

function sqlStateOf(err: unknown): unknown {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (code !== undefined) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Retires the old search where the state above owes it; a run with nothing owed reads the catalog
 * and takes no lock. `concurrently: false` as {@link ensureSearchExtensions}.
 */
export async function retireOldSearch(
  db: SqlExecutor,
  opts: { log?: (msg: string) => void; concurrently?: boolean; lockTimeoutMs?: number; attempts?: number; pauseMs?: number } = {},
): Promise<OldSearchRetirement> {
  const { log, concurrently = true, lockTimeoutMs = 2_000, attempts = 20, pauseMs = 500 } = opts;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) throw new Error("lockTimeoutMs must be a positive integer");
  const first = await oldSearchState(db);
  const verdict = (s: OldSearchState, gin: OldSearchRetirement["gin"]): OldSearchRetirement =>
    ({ columns: s.column ? "standing" : "gone", trigger: triggerVerdict(s), gin, owedAccounts: s.owed, owedLetters: s.letters });
  // Nothing of the old search stands: 0200 took it, or an earlier run of this step did.
  if (!first.column) return verdict(first, "absent");
  const kept = (s: OldSearchState): OldSearchRetirement["gin"] => {
    if (s.valid === null) return "absent";
    log?.(`${BODY_VECTOR_INDEX}: kept, ${s.owed} account(s) still search by the old body vector`);
    return "kept";
  };
  if (first.letters > 0 && first.runs !== BOUNDED_FN && !ginGoes(first)) return verdict(first, kept(first));

  const [prev] = rowsOf<{ v: string }>(await db.execute(sql`select current_setting('lock_timeout') as v`));
  const restore = sql`select set_config('lock_timeout', ${prev?.v ?? "0"}, false)`;
  /** One statement under a bounded lock wait, tried again while its table is busy. */
  const bounded = async (what: string, statement: ReturnType<typeof sql.raw> | typeof BODY_VECTOR_TRIGGER_DDL): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.execute(sql.raw(`set lock_timeout = ${lockTimeoutMs}`));
        await db.execute(statement);
        return;
      } catch (err) {
        if (sqlStateOf(err) !== "55P03") throw err;
        if (attempt >= attempts) {
          throw new BodyVectorLockTimeout(
            `${what}: ${attempts} waits of ${lockTimeoutMs}ms on the table's writers each ran out. Re-run the setup; this step is idempotent.`,
          );
        }
        log?.(`${what}: the table is busy (attempt ${attempt} of ${attempts}), retrying`);
        await new Promise((r) => setTimeout(r, pauseMs));
      } finally {
        await db.execute(restore);
      }
    }
  };
  const key = MIGRATION_LOCK_KEY as unknown as number;
  await db.execute(sql.raw(`set lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`));
  try {
    await db.execute(sql`select pg_advisory_lock(${key})`);
  } catch (err) {
    await db.execute(restore);
    throw new Error(`could not take the migration advisory lock within ${MIGRATION_LOCK_TIMEOUT_MS}ms to retire the old search — re-run; this step is idempotent. Cause: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await db.execute(restore);
    const s = await oldSearchState(db);
    if (!s.column) return verdict(s, "absent");
    if (s.letters === 0) {
      // 0200's own statements, in its order. Each is IF EXISTS, so a run cut short is finished by the next.
      log?.("the old search: nothing is found by it alone — retiring its columns, trigger and indexes");
      for (const step of OLD_SEARCH_RETIREMENT) {
        const text = step.kind === "index" && concurrently ? step.sql.replace(/^DROP INDEX /, "DROP INDEX CONCURRENTLY ") : step.sql;
        await bounded(step.sql, sql.raw(text));
      }
      return verdict(await oldSearchState(db), s.valid === null ? "absent" : "dropped");
    }
    if (s.runs === BOUNDED_FN) {
      await db.execute(BODY_VECTOR_CLEARED_FUNCTION_DDL);
      await bounded("message_bodies_body_tsv_tg", BODY_VECTOR_TRIGGER_DDL);
      log?.("message_bodies_body_tsv_tg: re-pointed, a new body stores no vector");
    }
    let gin: OldSearchRetirement["gin"];
    if (ginGoes(s)) {
      log?.(`${BODY_VECTOR_INDEX}: ${s.valid === false ? "an INVALID leftover" : "no account searches by it"} — dropping${concurrently ? " concurrently" : ""}`);
      await db.execute(sql.raw(`drop index ${concurrently ? "concurrently " : ""}if exists public."${BODY_VECTOR_INDEX}"`));
      gin = "dropped";
    } else {
      gin = kept(s);
    }
    return verdict(await oldSearchState(db), gin);
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${key})`);
  }
}

/**
 * The pre-migration build of mail 0071's partial index, CONCURRENTLY.
 *
 * Mail 0071 carries the same statement with `IF NOT EXISTS`, so this step — before the migrator,
 * on an autocommit connection — builds without blocking writes and the journal statement no-ops;
 * the two must stay byte-equivalent. THE PREREQUISITE IS THE COLUMN, NOT THE TABLE: `withheld_reason` arrives with mail 0062, so a
 * database in 0002–0061 has the table and not the column, and throwing there would abort the setup
 * before the migrator could reach 0062 — bricking the upgrade it runs ahead of.
 */
const WITHHELD_PROVENANCE_SPEC: ConcurrentIndexSpec = {
  name: "message_bodies_withheld_idx",
  table: "message_bodies",
  requiresColumn: "withheld_reason",
  // `ON public.message_bodies`, so a like-named index in some OTHER schema can neither satisfy
  // this build nor be touched by it.
  ddl: sql`create index concurrently if not exists "message_bodies_withheld_idx"
    on public.message_bodies using btree ("withheld_reason","message_id")
    where "withheld_reason" is not null`,
};

/**
 * The pre-migration build of mail 0125's History index, CONCURRENTLY — 0071's pattern. Mail 0125
 * carries this statement minus `concurrently` so a PGlite store replays it; here, ahead of the
 * migrator, a server whose `messages` is already large builds it without a write lock and the
 * journal statement no-ops. The same spelling as `HOT_PATH_INDEX_SPECS`' entry (a test holds the
 * three equal). The prerequisite is the column the predicate names.
 */
export const HISTORY_ORDER_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "messages_account_msg_order_idx",
  table: "messages",
  requiresColumn: "deleted_at",
  ddl: sql`create index concurrently if not exists "messages_account_msg_order_idx"
      on public.messages using btree ("account_id","date" desc nulls last,"id" desc)
      where "deleted_at" is null`,
};

/**
 * The journal statements the setup command builds CONCURRENTLY ahead of the migrator, so the
 * journal's own `if not exists` copy no-ops wherever the table already holds rows. The lock-cost
 * rule admits exactly these, and only in their spec's spelling minus `concurrently`.
 */
/**
 * Mail 0171's arrival index, spelled ONCE: the key is the dialect's own text (no parameter, so the
 * planner matches the query's expression), and both journals carry it byte-equal (a test). It
 * replaces 0139's `messages_account_arrival_order_idx`, whose key let a header up to 48 h after
 * its arrival decide; a later migration drops that one on Postgres.
 */
export const ARRIVAL_ORDER_INDEX_DDL = sql`create index concurrently if not exists "messages_account_arrival_key_idx"
      on public.messages using btree ("account_id",${pgDialect().arrivalKey(sql`"date"`, sql`"arrived_at"`)} desc,"id" desc)
      where "deleted_at" is null`;

/**
 * Mail 0171's arrival index, built CONCURRENTLY ahead of the migrator on 0125's pattern, from the
 * one DDL the hot-path spec also builds. The prerequisite is the column the key reads.
 */
export const ARRIVAL_ORDER_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "messages_account_arrival_key_idx",
  table: "messages",
  requiresColumn: "arrived_at",
  ddl: ARRIVAL_ORDER_INDEX_DDL,
};

/**
 * Mail 0139's arrival index on its own (superseded) key. No reader walks it since 0171 and mail
 * 0200 drops it; nothing builds it any more ({@link RETIRED_PREBUILD_SPECS}).
 */
export const ARRIVAL_ORDER_0139_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "messages_account_arrival_order_idx",
  table: "messages",
  requiresColumn: "arrived_at",
  ddl: sql`create index concurrently if not exists "messages_account_arrival_order_idx"
      on public.messages using btree ("account_id",(case when "arrived_at" is null then coalesce("date", 'epoch'::timestamptz) when "date" is null then "arrived_at" when "date" - "arrived_at" <= interval '48 hours' and "arrived_at" - "date" <= interval '48 hours' then "date" else "arrived_at" end) desc,"id" desc)
      where "deleted_at" is null`,
};

/**
 * Mail 0154's recipient keys, spelled ONCE: the function and its index, byte-equal to the journal
 * (a test). The function is frozen once shipped: another meaning is a new name and a new index.
 */
export const RECIPIENT_KEYS_FUNCTION_DDL = sql`CREATE OR REPLACE FUNCTION messages_recipient_keys(account_id uuid, to_addresses jsonb, cc_addresses jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select coalesce(array_agg(distinct account_id::text || ':' || lower(e.addr)), '{}'::text[])
    from (select v ->> 'address' as addr from jsonb_array_elements(case when jsonb_typeof(to_addresses) = 'array' then to_addresses else '[]'::jsonb end) v
          union all
          select v ->> 'address' from jsonb_array_elements(case when jsonb_typeof(cc_addresses) = 'array' then cc_addresses else '[]'::jsonb end) v) e
   where e.addr is not null and e.addr <> '' and length(e.addr) <= 254
$$`;

export const RECIPIENT_KEYS_INDEX_DDL = sql`create index concurrently if not exists "messages_recipient_keys_idx" on public.messages using gin (messages_recipient_keys("account_id","to_addresses","cc_addresses")) with (gin_pending_list_limit = 256)`;

/**
 * Mail 0154's index, built CONCURRENTLY ahead of the migrator on 0139's pattern. On a database at
 * 0153 the function does not exist yet, so the prelude creates it first under the lock; without it
 * the build is 42883 and the setup stops before the migrator.
 */
export const RECIPIENT_KEYS_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "messages_recipient_keys_idx",
  table: "messages",
  prelude: [RECIPIENT_KEYS_FUNCTION_DDL],
  ddl: RECIPIENT_KEYS_INDEX_DDL,
};

/**
 * Mail 0157's sender-date index: the Screener cutline probe's own key, a held sender's mail dated by
 * `cutlineInstant` (`screener-cutline.ts`). Written out rather than imported, which would pull
 * `screener-apply.ts` into this module; `sender-date-index.test.ts` pins it to that rendering.
 */
export const SENDER_DATE_INDEX_DDL = sql`create index concurrently if not exists "messages_account_sender_date_idx" on public.messages using btree ("account_id",lower("from_address"),(coalesce("date", "created_at")))`;

/** Mail 0157's index, built CONCURRENTLY ahead of the migrator. Every column exists since the baseline. */
export const SENDER_DATE_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "messages_account_sender_date_idx",
  table: "messages",
  ddl: SENDER_DATE_INDEX_DDL,
};

/**
 * Mail 0160's column, added only where it is missing: on a database that has it the block reads the
 * catalog and takes no table lock. Byte-equal to the journal's first statement (a test).
 */
export const FOLDER_STATE_OUTSTANDING_COLUMN_DDL = sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'folder_state' AND column_name = 'outstanding_account_id') THEN
    ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "outstanding_account_id" uuid;
  END IF;
END $$`;

/** Mail 0160's index: the outstanding filings by account, the WHERE `ourOutstandingFiling` spells. */
export const FOLDER_STATE_OUTSTANDING_INDEX_DDL = sql`create index concurrently if not exists "folder_state_outstanding_idx" on public.folder_state using btree ("outstanding_account_id","message_id") where "reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder"`;

/**
 * Mail 0160's index, built CONCURRENTLY ahead of the migrator. The column is the prelude's, not a
 * `requiresColumn`: on a database below 0160 that would defer the build to the journal, a plain
 * build that holds `folder_state`'s writes for the whole scan. The index stays empty of keys until
 * the journal's trigger and backfill fill the column; nothing reads it before.
 */
export const FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "folder_state_outstanding_idx",
  table: "folder_state",
  prelude: [FOLDER_STATE_OUTSTANDING_COLUMN_DDL],
  ddl: FOLDER_STATE_OUTSTANDING_INDEX_DDL,
};

/** Mail 0161's index: the mailbox list read, the caller's mailboxes in id order. */
export const MAILBOXES_ACCOUNT_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "mailboxes_account_idx",
  table: "mailboxes",
  ddl: sql`create index concurrently if not exists "mailboxes_account_idx" on public.mailboxes using btree ("account_id","id")`,
};

/**
 * Mail 0181's reconcile queues: each poll's pending rows by the message's account, then in the poll's
 * own order, `(updated_at, message_id)`, so a poll reads its own account's queue, never another
 * account's, and a queue with nothing due reads nothing. The account is the column a trigger keeps
 * on every pending row: here mail 0160's, whose prelude this spec repeats. Neither table has a
 * mailbox column; the poll joins `messages` for that.
 */
export const FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "folder_state_pending_queue_idx",
  table: "folder_state",
  prelude: [FOLDER_STATE_OUTSTANDING_COLUMN_DDL],
  ddl: sql`create index concurrently if not exists "folder_state_pending_queue_idx" on public.folder_state using btree ("outstanding_account_id","updated_at","message_id") where "reconcile_status" = 'pending'`,
};

/**
 * Mail 0181's read-state queue column, added only where it is missing: on a database that has it the
 * block reads the catalog and takes no table lock. The journal carries the same block, so after the
 * prebuild it does nothing.
 */
export const FLAG_STATE_PENDING_ACCOUNT_COLUMN_DDL = sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'flag_state' AND column_name = 'pending_account_id') THEN
    ALTER TABLE "flag_state" ADD COLUMN IF NOT EXISTS "pending_account_id" uuid;
  END IF;
END $$`;

/**
 * Mail 0181's `\Seen` queue: the folder queue's twin on `flag_state`, by `pending_account_id`. The
 * column is the prelude's; the index holds its rows under no account until the journal's trigger and
 * backfill fill it, and nothing reads it before.
 */
export const FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC: ConcurrentIndexSpec = {
  name: "flag_state_pending_queue_idx",
  table: "flag_state",
  prelude: [FLAG_STATE_PENDING_ACCOUNT_COLUMN_DDL],
  ddl: sql`create index concurrently if not exists "flag_state_pending_queue_idx" on public.flag_state using btree ("pending_account_id","updated_at","message_id") where "reconcile_status" = 'pending'`,
};

export const PREMIGRATION_PREBUILD_SPECS: readonly ConcurrentIndexSpec[] = [
  WITHHELD_PROVENANCE_SPEC, HISTORY_ORDER_PREBUILD_SPEC, ARRIVAL_ORDER_PREBUILD_SPEC,
  RECIPIENT_KEYS_PREBUILD_SPEC,
  SENDER_DATE_PREBUILD_SPEC, MAILBOXES_ACCOUNT_PREBUILD_SPEC,
];

/**
 * WHAT A SETUP ONCE BUILT AHEAD OF THE 1.0 ROAD AND BUILDS NO MORE: an index a 2.0 entry drops or
 * builds again on another column. A setup that still ran one would put back what the entry took at
 * its next run: mail 0200 drops the 0139 arrival index, and mail 0201 drops the two columns the
 * three queue specs add in their preludes and key their indexes on (the indexes keep their names,
 * on `account_id`, built by 0201 itself). Kept as the record of how the 1.0 road's entries were
 * written: each carries its statement minus `concurrently`, and the lock-cost census reads the
 * old entries against these spellings too.
 */
export const RETIRED_PREBUILD_SPECS: readonly ConcurrentIndexSpec[] = [
  ARRIVAL_ORDER_0139_PREBUILD_SPEC,
  FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC, FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC, FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC,
];

export async function ensureWithheldProvenanceIndex(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  await ensureConcurrentIndexes(db, PREMIGRATION_PREBUILD_SPECS, {
    label: "the pre-migration index prebuild",
    ...(opts.log ? { log: opts.log } : {}),
  });
}
