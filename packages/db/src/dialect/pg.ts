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
import { assertComparable, assertDistinct, type Dialect, type LockOptions, type SearchArm, type SearchCorpus } from "./index.js";

// Re-exported because it was defined here first and the server arm's tests import it by this
// path; the refusal itself belongs to both arms and now lives in the contract.
export { assertDistinct };


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

    // The backslashes are DOUBLED so the text Postgres receives is byte-identical to the text in
    // the migration's CHECK — a tagged template cooks `\t` into a literal tab, which means the same
    // thing to the regex engine but makes the two definitions of one predicate impossible to diff.
    hasNonBlank: (column) => sql`${column} ~ '[^ \\t\\n\\r\\f\\v]'`,

    ilike: (column, pattern) => sql`${column} ilike ${pattern}`,

    interval: (ms: number) => sql`(${`${Math.trunc(ms)} milliseconds`}::interval)`,

    greatest: (...values) => {
      assertComparable(values.length);
      return sql`greatest(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
    },

    // SQL syntax, not a function: the separator is a keyword, which is why no list of function
    // names ever caught this construct.
    strpos: (hay, needle) => sql`position(${needle} in ${hay})`,

    substr: (x, from, length) => (length === undefined
      ? sql`substring(${x} from ${from})`
      : sql`substring(${x} from ${from} for ${length})`),

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
      const result = (await handle.execute(statement)) as
        { rows?: unknown[]; fields?: { name: string }[] } | unknown[];
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      const fields = Array.isArray(result) ? undefined : result.fields;
      if (!fields) return rows.map((r) => (Array.isArray(r) ? r : Object.values(r as object)));
      // ORDERED BY THE DRIVER'S FIELD LIST, never by the row object's keys. A row is an object and
      // JavaScript enumerates integer-like keys NUMERICALLY before the rest, so
      // `select 'left' as "2", 'right' as "1"` comes back from `Object.values` as
      // ["right","left"] — the wrong order, silently, for any statement whose aliases happen to
      // look like numbers.
      assertDistinct(fields.map((f) => f.name));
      return rows.map((r) =>
        Array.isArray(r) ? r : fields.map((f) => (r as Record<string, unknown>)[f.name]));
    },

    search: {
      lexical: (q: string, corpus: SearchCorpus): SearchArm => {
        const tsq = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${q})`;
        if (corpus === "kb") {
          return { pred: sql`kb_tsv @@ ${tsq}`, rank: sql`ts_rank(kb_tsv, ${tsq})` };
        }
        return {
          pred: sql`(m.subject_tsv @@ ${tsq} or b.body_tsv @@ ${tsq})`,
          rank: sql`greatest(ts_rank(m.subject_tsv, ${tsq}), ts_rank(coalesce(b.body_tsv, to_tsvector('')), ${tsq}))`,
        };
      },
      fuzzy: (q: string, corpus: SearchCorpus, opts): SearchArm => {
        const like = `%${q}%`;
        if (corpus === "kb") {
          if (opts.trigram) {
            return {
              pred: sql`(word_similarity(${q}, title) >= ${opts.threshold} or word_similarity(${q}, content) >= ${opts.threshold})`,
              rank: sql`greatest(word_similarity(${q}, title), word_similarity(${q}, content))`,
            };
          }
          // A constant, because this corpus's query already breaks ties on `updated_at`. See the
          // contract: the two corpora degrade differently and that is preserved, not smoothed.
          return { pred: sql`(title ilike ${like} or content ilike ${like})`, rank: sql`0` };
        }
        if (opts.trigram) {
          return {
            pred: sql`(word_similarity(${q}, m.subject) >= ${opts.threshold} or word_similarity(${q}, m.from_address) >= ${opts.threshold})`,
            rank: sql`greatest(word_similarity(${q}, m.subject), word_similarity(${q}, m.from_address))`,
          };
        }
        // The degrade, for a deployment without the trigram index: the same shape, no index, and
        // it still answers rather than pretending the arm does not exist. RECENCY is the rank —
        // there is no relevance signal left, and a constant here would have thrown away the one
        // ordering the caller still had.
        return {
          pred: sql`(m.subject ilike ${like} or m.from_address ilike ${like})`,
          rank: sql`coalesce(extract(epoch from m.date), 0)`,
        };
      },
    },
  };
}
