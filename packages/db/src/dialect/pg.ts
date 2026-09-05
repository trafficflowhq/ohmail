/**
 * The Postgres arm — what every one of these constructs meant before there was a second dialect.
 *
 * Nothing here is new behaviour. Each member emits the SQL the callers already wrote inline, moved
 * to one place so the SQLite arm has something to be checked against rather than invented beside.
 * That is why the expressions are spelled out rather than parameterised: a reader comparing the
 * two files should be able to see that the server's meaning did not drift while the phone's was
 * being written.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Dialect, LockOptions, SearchArm } from "./index.js";

/** Fed to `to_tsvector`/`websearch_to_tsquery`; the literal is required for an immutable index. */
const TEXT_SEARCH_CONFIG = "english";

export function pgDialect(): Dialect {
  return {
    name: "pg",

    now: () => sql`now()`,
    ts: (at: Date) => sql`${at.toISOString()}::timestamptz`,

    castInt: (v) => sql`(${v})::int`,
    castText: (v) => sql`(${v})::text`,
    castUuid: (v) => sql`(${v})::uuid`,
    castJsonb: (v) => sql`(${v})::jsonb`,

    forUpdate: <Q>(q: Q, opts: LockOptions = {}): Q => {
      const builder = q as { for?: (mode: "update", cfg?: object) => Q };
      if (typeof builder.for !== "function") return q;
      const cfg: Record<string, unknown> = {};
      if (opts.of !== undefined) cfg.of = opts.of;
      if (opts.skipLocked === true) cfg.skipLocked = true;
      return builder.for("update", Object.keys(cfg).length > 0 ? cfg : undefined);
    },

    skipLocked: <Q>(q: Q, opts: Omit<LockOptions, "skipLocked"> = {}): Q =>
      pgDialect().forUpdate(q, { ...opts, skipLocked: true }),

    advisoryLock: async (tx, lockClass, key) => {
      const run = tx as { execute: (s: SQL) => Promise<unknown> };
      // Transaction-scoped: it is released at commit or rollback and never by a caller who
      // forgot. A session-scoped lock survives a failed statement and outlives the work it
      // guarded, which is how a pool leaks a lock nobody can name.
      await run.execute(sql`select pg_advisory_xact_lock(${Number(lockClass)}, hashtext(${key}))`);
    },

    notify: async (tx, channel, payload) => {
      const run = tx as { execute: (s: SQL) => Promise<unknown> };
      // Inside the transaction on purpose: the server queues it and delivers at COMMIT, so a
      // listener is never woken for a row that rolled back, and never before the row it names
      // is readable.
      await run.execute(sql`select pg_notify(${channel}, ${payload})`);
    },

    ilike: (column, pattern) => sql`${column} ilike ${pattern}`,

    interval: (ms: number) => sql`(${`${Math.trunc(ms)} milliseconds`}::interval)`,

    /**
     * `?|` takes a text ARRAY, and an array handed to the builder as one parameter is rendered as
     * a list of placeholders — valid-looking SQL that the server rejects. Spelled as an explicit
     * array constructor so each key is still bound rather than inlined.
     */
    jsonHasAny: (column, keys) => {
      if (keys.length === 0) return sql`false`;
      const members = keys.map((k) => sql`${k}`);
      return sql`${column} ?| array[${sql.join(members, sql`, `)}]::text[]`;
    },

    exec: async (db, statement) => {
      const handle = db as { execute: (s: SQL) => Promise<unknown> };
      const result = (await handle.execute(statement)) as { rows?: unknown[] } | unknown[];
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      // Positional, to match the other arm — see the contract on `Dialect.exec`.
      return rows.map((r) => (Array.isArray(r) ? r : Object.values(r as object)));
    },

    search: {
      lexical: (q: string): SearchArm => {
        const tsq = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${q})`;
        return {
          pred: sql`(m.subject_tsv @@ ${tsq} or b.body_tsv @@ ${tsq})`,
          rank: sql`greatest(ts_rank(m.subject_tsv, ${tsq}), ts_rank(coalesce(b.body_tsv, to_tsvector('')), ${tsq}))`,
        };
      },
      fuzzy: (q: string, opts): SearchArm => {
        if (opts.trigram) {
          return {
            pred: sql`(word_similarity(${q}, m.subject) >= ${opts.threshold} or word_similarity(${q}, m.from_address) >= ${opts.threshold})`,
            rank: sql`greatest(word_similarity(${q}, m.subject), word_similarity(${q}, m.from_address))`,
          };
        }
        // The degrade, for a deployment without the trigram index: the same shape, no index, and
        // it still answers rather than pretending the arm does not exist.
        const like = `%${q}%`;
        return {
          pred: sql`(m.subject ilike ${like} or m.from_address ilike ${like})`,
          rank: sql`0`,
        };
      },
    },
  };
}
