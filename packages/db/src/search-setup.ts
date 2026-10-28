import { sql } from "drizzle-orm";
import {
  ensureConcurrentIndexes, type ConcurrentIndexSpec, type SqlExecutor,
} from "./concurrent-index.js";
import { pgDialect } from "./dialect/pg.js";

/**
 * Search EXTENSION setup, kept deliberately OUT of the shared migrator. `makeTestDb()` replays
 * the journal into PGlite for every unit test, and PGlite has no `pg_trgm`, so a `CREATE
 * EXTENSION` there would take the whole suite red. This runs ONLY against a real Postgres: the
 * search pg tests call it in `beforeAll`, and production setup calls it once after migrating.
 * Idempotent — `IF NOT EXISTS` throughout. The tsvector columns and their GIN indexes are NOT
 * here: they are core-Postgres generated columns in migration 0008 and replay fine into PGlite.
 * This file adds only the `pg_trgm` extension plus the trigram GIN indexes on subject,
 * from_address and the search document's header corpus.
 */

/**
 * The fuzzy arm's trigram GIN indexes (subject + sender), built CONCURRENTLY: setup runs on the
 * live database, where a plain build over `messages`, the schema's largest table, holds every
 * write for the whole scan. So it needs an autocommit session, like every other prebuild here.
 */
export const TRIGRAM_INDEX_SPECS: readonly ConcurrentIndexSpec[] = [
  {
    name: "messages_subject_trgm_idx",
    table: "messages",
    ddl: sql`create index concurrently if not exists "messages_subject_trgm_idx"
      on public.messages using gin ("subject" gin_trgm_ops)`,
  },
  {
    name: "messages_from_address_trgm_idx",
    table: "messages",
    ddl: sql`create index concurrently if not exists "messages_from_address_trgm_idx"
      on public.messages using gin ("from_address" gin_trgm_ops)`,
  },
  {
    // The substring and typo arms over the search document's header corpus (mail 0125): subject,
    // senders, recipients and attachment names in one column, so `axa` inside `myAXA` or inside a
    // recipient's domain is one index read. The ACCOUNT leads (btree_gin): a trigram's candidates
    // are then one account's, where the plain index handed a smaller account every account's
    // candidates to re-check, and its typo page ran past the budget. The pending list is bounded as
    // mail 0152 bounds the journal's two: every search reads it whole.
    name: "message_search_terms_trgm_idx",
    table: "message_search",
    ddl: sql`create index concurrently if not exists "message_search_terms_trgm_idx"
      on public.message_search using gin ("account_id", "terms" gin_trgm_ops) with (gin_pending_list_limit = 256)`,
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
 * Mail 0139's arrival index on its own (superseded) key, still built ahead of the migrator so a
 * store below 0139 does not build it blocking in the journal. No reader walks it since 0171.
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

export const PREMIGRATION_PREBUILD_SPECS: readonly ConcurrentIndexSpec[] = [
  WITHHELD_PROVENANCE_SPEC, HISTORY_ORDER_PREBUILD_SPEC, ARRIVAL_ORDER_0139_PREBUILD_SPEC, ARRIVAL_ORDER_PREBUILD_SPEC,
  RECIPIENT_KEYS_PREBUILD_SPEC,
  SENDER_DATE_PREBUILD_SPEC, FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC, MAILBOXES_ACCOUNT_PREBUILD_SPEC,
];

export async function ensureWithheldProvenanceIndex(
  db: SqlExecutor, opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  await ensureConcurrentIndexes(db, PREMIGRATION_PREBUILD_SPECS, {
    label: "the pre-migration index prebuild",
    ...(opts.log ? { log: opts.log } : {}),
  });
}
