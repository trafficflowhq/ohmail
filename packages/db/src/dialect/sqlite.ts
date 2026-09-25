/**
 * The SQLite arm — a device's answer to each question, and why it is right. Two of these are
 * no-ops, and a no-op is the most dangerous thing this file can contain: it compiles, runs, and
 * protects nothing. Both are safe for the same structural reason, written beside each rather than
 * assumed — the engine store is reached through ONE serialized connection: no second writer to
 * exclude, and a second connection to the same file fails outright, so the ordering the server
 * buys with locks is already true here. The two translations that change meaning are named: text
 * search moves to an external-content full-text index, and case-insensitive matching is folded
 * explicitly because this dialect's `like` folds ASCII only.
 */
import { sql, type SQL } from "drizzle-orm";
import { assertComparable, assertJsonKey, PART_PREFIX_MIN_CHARS, partWordsOf } from "./index.js";
import type { Dialect, LockOptions, MailWordArms, SearchArm, SearchCorpus } from "./index.js";

/**
 * The oldest SQLite this schema can be opened on, and what each digit buys.
 *
 * Stated as three separate reasons rather than one number so a future reader can tell which
 * feature a bump would be for: `RETURNING` arrived in 3.35, window functions — which the ranked
 * reads use in place of the server's `DISTINCT ON` — in 3.25, sub-second `unixepoch` in 3.42, and
 * `octet_length`, which a CHECK in the schema itself uses, in 3.43. The highest of the FOUR is the
 * floor, and it is 3.43.
 */
export const SQLITE_MINIMUM = {
  returning: "3.35.0", unixepochSubsec: "3.42.0", windowFunctions: "3.25.0",
  /** `octet_length`, which a CHECK in the schema itself uses — the highest of the four. */
  octetLength: "3.43.0",
} as const;

/** The floor as a comparable tuple: the highest of the four requirements above. */
const MINIMUM_TUPLE = [3, 43, 0] as const;

function versionTuple(version: string): [number, number, number] {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Refuse a build of SQLite that cannot run this schema, BEFORE the first statement.
 *
 * The alternative is discovering it from a syntax error inside a drain, which names a query and
 * not the library — and full-text search is worse than that, because a build without it fails only
 * when somebody searches, long after the store was written.
 */
export function assertSqliteCapabilities(probe: { version: string; compileOptions: readonly string[] }): void {
  const [major, minor, patch] = versionTuple(probe.version);
  const [minMajor, minMinor, minPatch] = MINIMUM_TUPLE;
  const tooOld = major < minMajor
    || (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)));
  if (tooOld) {
    throw new Error(
      `this store needs SQLite ${minMajor}.${minMinor}.${minPatch} or newer and found ${probe.version}: ` +
        `RETURNING needs ${SQLITE_MINIMUM.returning}, unixepoch('subsec') needs ` +
        `${SQLITE_MINIMUM.unixepochSubsec}, window functions need ${SQLITE_MINIMUM.windowFunctions}, ` +
        `octet_length needs ${SQLITE_MINIMUM.octetLength}.`,
    );
  }
  if (!probe.compileOptions.some((o) => o.toUpperCase().includes("ENABLE_FTS5"))) {
    throw new Error(
      "this build of SQLite has no FTS5, so the mail index cannot be built. Searching would " +
        "return nothing on a store that looks complete, which is why this refuses at open time " +
        "rather than at the first query.",
    );
  }
}

/** Milliseconds since the epoch, which is how every timestamp column stores an instant here. */
const NOW_MS = sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * Announcements for a program that is its own only listener.
 *
 * The server's notification crosses connections; this one cannot and does not pretend to. On a
 * device the writer and the reader are the same process, so an in-process emitter delivers to the
 * whole audience — and a caller that assumed otherwise would be assuming a second process that is
 * not there.
 */
type ChannelListener = (payload: string) => void;
const listeners = new Map<string, Set<ChannelListener>>();

/** Listen for local announcements on a channel. Returns the function that stops listening. */
export function onLocalNotify(channel: string, listener: ChannelListener): () => void {
  const set = listeners.get(channel) ?? new Set<ChannelListener>();
  set.add(listener);
  listeners.set(channel, set);
  return () => { set.delete(listener); };
}

/** One announcement, held until the transaction that made it commits. */
interface Announcement { readonly channel: string; readonly payload: string }

/**
 * WHICH QUEUE A TRANSACTION'S ANNOUNCEMENTS GO INTO — the half that makes the contract true here.
 *
 * The contract says a notification is delivered at COMMIT, and the server honours it by handing
 * `pg_notify` to the transaction. This store has no such queue, so one is kept beside it, keyed by
 * the transaction object the driver hands the body. A SAVEPOINT gets its own object and shares its
 * parent's queue: releasing a savepoint is not a commit. A `tx` nobody registered — the handle
 * itself, or a caller outside any transaction — has no commit to wait for and delivers at once.
 */
const queues = new WeakMap<object, Announcement[]>();

function deliverLocal(channel: string, payload: string): void {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

/** Register `tx` against `queue`, and every savepoint opened on it. */
function joinQueue(tx: object, queue: Announcement[]): void {
  queues.set(tx, queue);
  const nested = (tx as { transaction?: (f: (t: object) => Promise<unknown>) => Promise<unknown> })
    .transaction;
  if (typeof nested !== "function") return;
  (tx as { transaction: unknown }).transaction = function savepoint(
    body: (t: object) => Promise<unknown>,
  ): Promise<unknown> {
    // A savepoint that rolls back takes its OWN announcements with it and leaves the ones made
    // before it standing — which is what the mark is for. The list is contiguous because this
    // store has one serialized connection.
    const mark = queue.length;
    return nested.call(tx, async (inner: object) => { joinQueue(inner, queue); return body(inner); })
      .catch((err: unknown) => { queue.length = mark; throw err; });
  };
}

/**
 * Hold this handle's announcements until its transaction COMMITS, and drop them if it does not.
 *
 * Applied where the device store is composed, outermost, so the delivery happens after the write
 * is durable and outside whatever queue serialized it. Without it a listener is woken by a write
 * that later rolls back — and on a device the listener and the writer are one program, so it acts
 * on state the store does not hold.
 */
export function deliverLocalNotifyAtCommit<T extends object>(db: T): T {
  const handle = db as T & {
    transaction?: (f: (t: object) => Promise<unknown>, cfg?: unknown) => Promise<unknown>;
  };
  const inner = handle.transaction;
  if (typeof inner !== "function") return db;
  handle.transaction = function delivering(
    body: (t: object) => Promise<unknown>, cfg?: unknown,
  ): Promise<unknown> {
    const queue: Announcement[] = [];
    return inner.call(handle, async (tx: object) => { joinQueue(tx, queue); return body(tx); }, cfg)
      .then(
        (value: unknown) => {
          for (const a of queue) deliverLocal(a.channel, a.payload);
          return value;
        },
        (err: unknown) => { queue.length = 0; throw err; },
      );
  };
  return db;
}

export function sqliteDialect(): Dialect {
  return {
    name: "sqlite",

    now: () => NOW_MS,
    ts: (at: Date) => sql`${at.getTime()}`,
    tsOrNull: (at: Date | null) => (at === null ? sql`null` : sql`${at.getTime()}`),

    castInt: (v) => sql`CAST(${v} AS INTEGER)`,
    castText: (v) => sql`CAST(${v} AS TEXT)`,
    // Identifiers are text here and are generated by the application on both dialects, so this is
    // a widening to the storage type rather than a conversion.
    castUuid: (v) => sql`CAST(${v} AS TEXT)`,
    // JSON is stored as text and read back through the JSON functions, so the cast is to text and
    // the shape is the caller's business, exactly as it is on the server.
    castJsonb: (v) => sql`CAST(${v} AS TEXT)`,

    // See the header: one serialized connection is the ordering guarantee, so there is nothing
    // for a row lock to add.
    forUpdate: <Q>(q: Q, _opts?: LockOptions): Q => q,
    skipLocked: <Q>(q: Q, _opts?: Omit<LockOptions, "skipLocked">): Q => q,
    advisoryLock: async () => {},

    // At COMMIT, like the server's, and for the server's reason: a listener is never woken for a
    // row that rolled back. See {@link deliverLocalNotifyAtCommit} for where the queue comes from;
    // a caller outside any transaction has no commit to wait for and is delivered at once.
    notify: async (tx, channel, payload) => {
      const queue = typeof tx === "object" && tx !== null ? queues.get(tx) : undefined;
      if (queue !== undefined) { queue.push({ channel, payload }); return; }
      deliverLocal(channel, payload);
    },

    // Folded on both sides so the comparison is at least symmetric — but NOT equivalent to the
    // server's, and the difference is worth knowing before it is relied on: this store's `lower()`
    // folds ASCII and nothing else, so `Ä` and `ä` remain distinct here and do not on Postgres. A
    // search for a name in any other alphabet therefore matches less on a device. Closing that gap
    // needs a folded column or an ICU build, neither of which this store has; naming it is what
    // stops the next reader assuming the two are the same comparison.
    /**
     * `trim(X, Y)` removes any of Y's characters from both ends, so what is left is empty exactly
     * when every character of X was one of them — the same question the server's regex asks, put
     * the only way this store can ask it. The class is built with `char()` rather than written as
     * escapes because this store's string literals do not interpret backslash escapes at all: a
     * literal '\t' here is a backslash and a t, and the predicate would then trim neither tabs nor
     * anything else it was meant to.
     */
    hasNonBlank: (column) =>
      sql`trim(coalesce(${column}, ''), ' ' || char(9) || char(10) || char(13) || char(12) || char(11)) <> ''`,

    ilike: (column, pattern) => sql`lower(${column}) like lower(${pattern})`,

    /* `instr`/`substr`, this store's spelling of the server's `position`/`substring`. Both are
       1-based and both answer the FIRST separator, so the two return the same string for the same
       address — including an address carrying two `@`, where the naive spellings part company.
       An address with no `@` gives `instr` 0, so `substr(x, 1)` returns the WHOLE string; the
       server's `position` answers 0 for the same input and its `substring … from 1` does the same.
       Equal, and equally harmless: a rule's match never contains an address. */
    domainOf: (address) =>
      sql`substr(lower(${address}), instr(lower(${address}), '@') + 1)`,

    interval: (ms: number) => sql`${Math.trunc(ms)}`,

    /* THE IDENTITY, and that is a fact rather than a shrug: this store keeps epoch MILLISECONDS,
       so a timestamp here is already truncated to the precision the member names. Deleting the
       call at the site instead would have been correct here and silently wrong on the server,
       where the microseconds it drops are what a keyset cursor cannot carry. */
    truncMs: (at) => sql`${at}`,

    /* EMPTY, and it must be a fragment rather than an omission at the site: the caller writes it
       into the middle of a statement, so the seam has to hand back something that renders to
       nothing rather than leaving the caller to decide whether to include it. */
    lockClause: () => sql.raw(""),

    /* This store's version yields a TABLE, whose element is its `value` column — so the alias
       carries no column list and the element is named through it. Same fragments, different shapes
       behind them, which is the whole reason the member hands back all four.

       `value` here is already an SQL value, so the element's type comes from `json_each`'s own
       `type` column — `json_type(value)` over a bare string is a malformed-JSON error — and its
       text is the value itself. `'text'` is this store's word for the server's `'string'`. */
    jsonArrayElements: (source, alias) => {
      const value = sql.raw(`${alias}.value`);
      return {
        from: sql`json_each(${source}) as ${sql.raw(alias)}`,
        value,
        isString: sql`${sql.raw(`${alias}.type`)} = 'text'`,
        text: value,
      };
    },

    /* A quoted PATH, not a key: this store's `->` takes `$."<key>"`, and the bare shorthand would
       read a key holding `.` or `[` as a path into something else. The quote-and-backslash refusal
       is the contract's, one level up. */
    jsonGet: (document, key) => sql`(${document} -> ${`$."${assertJsonKey(key)}"`})`,
    jsonIsArray: (value) => sql`json_type(${value}) = 'array'`,

    /**
     * The shallow merge, spelled out — neither of this store's two candidates is it.
     *
     * `||` is string CONCATENATION here, so the server's operator would produce two documents stuck
     * end to end. `json_patch` is RFC 7396: it merges a nested object instead of replacing it and
     * DELETES a key whose patch value is null. So the keys are taken apart and put back: the
     * document's keys the patch does not mention, then all of the patch's. `-> fullkey` re-encodes
     * each value as JSON (a bare `value` would re-quote a string), and `json()` puts it back as
     * structure rather than as text.
     */
    jsonMergeShallow: (document, patch) => sql`(select json_group_object(k, json(v)) from (
      select je.key as k, (coalesce(${document}, '{}') -> je.fullkey) as v
        from json_each(coalesce(${document}, '{}')) je
       where je.key not in (select key from json_each(${patch}))
      union all
      select je.key as k, (${patch} -> je.fullkey) as v from json_each(${patch}) je
    ))`,

    jsonObject: (entries) => sql`json_object(${sql.join(
      Object.entries(entries).flatMap(([k, v]) => [sql`${k}`, sql`${v}`]), sql`, `)})`,

    /**
     * `max`, and the argument count is load-bearing.
     *
     * This store gives ONE name to two different things: `max(a, b)` compares values within a
     * row, `max(a)` is the aggregate over a result set. A single-argument call would therefore
     * run and answer a different question — collapsing the rows instead of comparing — with no
     * error anywhere. The contract refuses it, and this is the arm that would have suffered.
     */
    greatest: (...values) => {
      assertComparable(values.length);
      return sql`max(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
    },

    // Arguments in the opposite order to the server's syntax, which is the whole reason this is
    // a member rather than a shared spelling.
    strpos: (hay, needle) => sql`instr(${hay}, ${needle})`,

    substr: (x, from, length) => (length === undefined
      ? sql`substr(${x}, ${from})`
      : sql`substr(${x}, ${from}, ${length})`),

    /** As the server's, and for the same reason: an array is one parameter, not a list. */
    jsonHasAny: (column, keys) => {
      if (keys.length === 0) return sql`0`;
      const members = keys.map((k) => sql`${k}`);
      return sql`EXISTS (
        SELECT 1 FROM json_each(${column}) WHERE json_each.key IN (${sql.join(members, sql`, `)})
      )`;
    },

    /**
     * ARMED ONCE, then the store's own checkpointer holds the bound. SQLite has one and it counts
     * PAGES, so the bytes become `bytes / page_size` pages — the same quantity the server's arm
     * measures in log bytes, asked of the only unit this store's knob takes. There is no reading
     * of the current log to gate on (`pragma wal_checkpoint` IS the checkpoint, so asking would
     * be doing), which is why the mark is the arming rather than a position.
     */
    foldLog: async (db, bounds, mark) => {
      /* ARMED ONCE, AND THEN THE STORE FOLDS ITSELF. This one has a checkpointer of its own and
         counts PAGES, so the caller's bound in bytes is spelt as `wal_autocheckpoint` at the first
         call and every later call is the identity. Said here rather than left to a reader. */
      if (mark.folded !== null) return { folded: false, grewBytes: null, mark };
      const [row] = await sqliteDialect().exec(db, sql`pragma page_size`);
      const pageSize = Number(row?.[0]);
      const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 4096;
      const pages = Math.max(1, Math.ceil(bounds.foldBytes / size));
      await sqliteDialect().exec(db, sql.raw(`pragma wal_autocheckpoint = ${pages}`));
      return { folded: false, grewBytes: null, mark: { folded: `pages:${pages}` } };
    },

    exec: async (db, statement) => {
      const handle = db as { all?: (s: SQL) => Promise<unknown[]>; run?: (s: SQL) => Promise<unknown> };
      if (typeof handle.all === "function") {
        const rows = await handle.all(statement);
        return rows.map((r) => (Array.isArray(r) ? r : Object.values(r as object)));
      }
      await handle.run?.(statement);
      return [];
    },

    // The instant is milliseconds here.
    monthBucket: (instant: SQL): SQL => sql`strftime('%Y-%m', ${instant} / 1000, 'unixepoch')`,

    search: {
      // Full-text lives in external-content tables kept beside the rows by triggers, rather than
      // in a generated column on the row itself: this dialect has no stored generated column of
      // that kind, and duplicating the text into the row would double what a mailbox costs on a
      // device. `bm25` returns a smaller number for a better match, so it is negated to rank the
      // same direction the server's does.
      //
      // The knowledge base has its own table and no alias — its caller selects `from kb_entries`
      // with nothing else in the statement — so `rowid` there is unqualified, while the mail
      // corpus qualifies against the `m` and `b` its caller joins.
      lexical: (q: string, corpus: SearchCorpus): SearchArm => {
        if (corpus === "kb") {
          return {
            pred: sql`rowid IN (SELECT rowid FROM kb_entries_fts WHERE kb_entries_fts MATCH ${q})`,
            rank: sql`-COALESCE((SELECT bm25(kb_entries_fts) FROM kb_entries_fts WHERE kb_entries_fts MATCH ${q} AND rowid = kb_entries.rowid), 0)`,
          };
        }
        return {
          pred: sql`(m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${q})
                  or b.rowid IN (SELECT rowid FROM message_bodies_fts WHERE message_bodies_fts MATCH ${q}))`,
          rank: sql`-COALESCE((SELECT bm25(messages_fts) FROM messages_fts WHERE messages_fts MATCH ${q} AND rowid = m.rowid), 0)`,
        };
      },
      lexicalArms: (q: string, from: SQL, where: SQL): SQL[] => [
        sql`select m.id, m.date ${from} where ${where}
              and m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${q})`,
        sql`select m.id, m.date ${from} join message_bodies b on b.message_id = m.id where ${where}
              and b.rowid IN (SELECT rowid FROM message_bodies_fts WHERE message_bodies_fts MATCH ${q})`,
      ],
      fuzzy: (q: string, corpus: SearchCorpus, _opts): SearchArm => {
        // There is no trigram index to have, so this is the degrade the server also falls back to
        // — one shape on both dialects rather than a device-only third behaviour.
        const like = `%${q}%`;
        if (corpus === "kb") {
          return {
            pred: sql`(lower(title) like lower(${like}) or lower(content) like lower(${like}))`,
            rank: sql`0`,
          };
        }
        return {
          pred: sql`(lower(m.subject) like lower(${like}) or lower(m.from_address) like lower(${like})
                  or lower(coalesce(s.terms, '')) like lower(${like}))`,
          // RECENCY, as the server's degrade ranks. The instant is already a count of
          // milliseconds in this store, so there is no epoch to extract — the column IS the
          // number, and `extract(epoch …)` would not parse here at all.
          rank: sql`coalesce(m.date, 0)`,
        };
      },
      // The two FTS5 tables as the two word arms: subject/sender ranked by bm25, the body by
      // recency, as the server's arms rank. FTS5 reads a quoted span as a phrase.
      words: (q: string): MailWordArms => ({
        head: {
          pred: sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${q})`,
          rank: sql`-COALESCE((SELECT bm25(messages_fts) FROM messages_fts WHERE messages_fts MATCH ${q} AND rowid = m.rowid), 0)`,
        },
        text: {
          pred: sql`b.rowid IN (SELECT rowid FROM message_bodies_fts WHERE message_bodies_fts MATCH ${q})`,
          rank: sql`coalesce(m.date, 0)`,
        },
      }),
      // The same two FTS5 tables as `words`, each word as itself and, from four letters, as the
      // start of a longer one (`"elevat"*`). No stemmer here, so a prefix IS the whole-word reach.
      partWords: (q: string): MailWordArms | null => {
        const words = partWordsOf(q);
        if (words === null) return null;
        const match = words.map((w) => ([...w].length >= PART_PREFIX_MIN_CHARS ? `"${w}"*` : `"${w}"`)).join(" ");
        const recency = sql`coalesce(m.date, 0)`;
        return {
          head: { pred: sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match})`, rank: recency },
          text: { pred: sql`b.rowid IN (SELECT rowid FROM message_bodies_fts WHERE message_bodies_fts MATCH ${match})`, rank: recency },
        };
      },
      substring: (q: string): SearchArm => {
        // Every row, whether or not it has a search document yet: this store has no index for a
        // substring either way, so the header columns and the recipients' `terms` are one scan.
        const like = `%${q}%`;
        return {
          pred: sql`(lower(m.subject) like lower(${like}) or lower(m.from_address) like lower(${like})
                  or lower(coalesce(s.terms, '')) like lower(${like}))`,
          rank: sql`coalesce(m.date, 0)`,
        };
      },
      // A LIKE, not an index operator, and one planner: there is nothing to set.
      searchSession: (): null => null,
      // The FTS5 tables are kept by triggers over every row, so nothing here is unindexed.
      unindexed: (): null => null,
      // No planner statistics to ask; this store's exact count is its own scan anyway.
      estimateRows: async (): Promise<null> => null,
      // No INSERT inside a WITH on this store.
      withDocument: (): null => null,
      // No `tsv` column on this store (see the migration's twin).
      document: (): null => null,
    },
  };
}
