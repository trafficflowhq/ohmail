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
import { anyPartArms, assertComparable, assertJsonKey, eszettForms, PART_PREFIX_MIN_CHARS, partOperandsOf, partSidesOf, partWordKept, partWordsOf, ENGLISH_STOPWORDS, operandRuns, queryOperandsOf, straddlesParts, type QueryOperands } from "./index.js";
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

// Re-exported because it was defined here first and its test imports it by this path.
export { ENGLISH_STOPWORDS };

/** One typed operand as an FTS5 phrase of its letter-and-digit runs ({@link operandRuns}), or null. */
function phraseOf(text: string): string | null {
  const runs = operandRuns(text);
  return runs === null ? null : `"${runs.join(" ")}"`;
}

/**
 * A typed query as FTS5 syntax that cannot refuse, read the way `websearch_to_tsquery` reads it:
 * a quoted span or a punctuated word is a phrase, `-` before a word excludes it (`--` does not), a
 * bare `or` between words is OR, and the server's stopwords are dropped. The part-word arm reads a
 * query twice, its kept words ANDed: `"stems"`, each word whole, which the porter tables stem;
 * `"starts"`, from four letters the start of a word, which only the unstemmed tables (mail 0175)
 * may be asked, because porter stems a prefix too (`ines`* reads `in`*). `match` is null when only
 * exclusions are left (then `exclude` names them) or nothing is. `stops` asks the stopword table
 * (mail 0176) whether a word shares a stopword's stem; null for `"starts"` or where an operand is no one word.
 */
export function ftsQueryOf(q: string, mode: "words" | "stems" | "starts" = "words"): { match: string | null; exclude: string | null; stops: string | null } {
  if (mode !== "words") {
    const words = partWordsOf(q) ?? [];
    const kept = words.filter((_, i) => partWordKept(words, i));
    const terms = kept.map(mode === "stems" ? stemOf : startOf);
    const match = terms.length === 0 || terms.includes(null) ? null : terms.join(" AND ");
    return { match, exclude: null, stops: mode === "stems" && match !== null ? stopsOf(kept) : null };
  }
  const ops = queryOperandsOf(q);
  const stops = stopsOf([...ops.any.flat(), ...ops.none].map((o) => operandRuns(o.text)!).map((r) => (r.length === 1 ? r[0]! : null)));
  const groups = ops.any.map((g) => g.map((o) => phraseOf(o.text)!).join(" "));
  const excluded = ops.none.map((o) => phraseOf(o.text)!);
  if (groups.length === 0) return { match: null, exclude: excluded.length === 0 ? null : excluded.join(" OR "), stops };
  const head = groups.length > 1 ? `(${groups.join(" OR ")})` : groups[0]!;
  return { match: [head, ...excluded.map((e) => `NOT ${e}`)].join(" "), exclude: null, stops };
}

/** A porter table's reading: its expression, and its words OR-ed as the stopword table is asked them ({@link stopsOf}). */
interface Reading { readonly match: string; readonly stops: string | null }

/** Words OR-ed for the stopword table (mail 0177); null when one may not be one token on every store. */
function stopsOf(words: ReadonlyArray<string | null>): string | null {
  return words.length > 0 && words.every((w) => w !== null && ONE_TOKEN.test(w)) ? [...new Set(words.map((w) => `"${w}"`))].join(" OR ") : null;
}

/**
 * Letters and digits of scripts every SQLite's `unicode61` has long read as word characters. The
 * unstemmed tables keep no positions (`detail=none`) and refuse a phrase, so a word this device's
 * tokenizer might split is asked of them not at all: its part is read by its stem alone.
 */
const ONE_TOKEN = /^[0-9A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u037E\u0384-\u03FF\u0400-\u0527\u0531-\u0556\u0561-\u0587\u05D0-\u05EA\u0620-\u064A\u0660-\u0669\u0E01-\u0E30\u1E00-\u1EFF\u3041-\u3096\u30A1-\u30FA\u3400-\u4DB5\u4E00-\u9FCC\uAC00-\uD7A3]+$/;

/** Is `w` one of the server's stopwords, which its documents never hold whole? */
const isStopword = (w: string): boolean => ENGLISH_STOPWORDS.has(w.toLowerCase());

/** One kept part-word as the porter tables read it: whole, and they stem it; a kept stopword has no whole reading. */
const stemOf = (w: string): string | null => (isStopword(w) ? null : `"${w}"`);

/** What follows a start in a longer word of the unstemmed tables (folded); a letter of another script is not asked. */
const NEXT_CHARS = [..."abcdefghijklmnopqrstuvwxyz0123456789"];

/** Does a stopword start with `p` (or is it one)? */
const startsAStopword = (p: string): boolean => {
  const l = p.toLowerCase();
  for (const s of ENGLISH_STOPWORDS) if (s.startsWith(l)) return true;
  return false;
};

/** The longer words `w` starts, but never a stopword (`your`: not `yours`, `yourself`, `yourselves`). */
function longerThan(w: string): string[] {
  return NEXT_CHARS.flatMap((c) => {
    const p = w + c;
    if (!startsAStopword(p)) return [`"${p}"*`];
    return [...(isStopword(p) ? [] : [`"${p}"`]), ...longerThan(p)];
  });
}

/**
 * One kept part-word as the unstemmed tables read it: from four letters the start of a word, else the
 * word. A start of a stopword (`over`, `agai`) never reaches that stopword, as the server's `'over':*`
 * reads its documents, which hold `overview` and never `over` or `again`.
 */
function startOf(w: string): string | null {
  if (!ONE_TOKEN.test(w)) return null;
  if ([...w].length < PART_PREFIX_MIN_CHARS) return `"${w}"`;
  if (!startsAStopword(w)) return `"${w}"*`;
  return `(${[...(isStopword(w) ? [] : [`"${w}"`]), ...longerThan(w)].join(" OR ")})`;
}

/** Part-words ANDed, each in every ß/ss form OR-ed; null with no word, or where one has no reading. */
function readingOf(words: readonly string[], term: (w: string) => string | null): string | null {
  const groups = words.map((w) => {
    const forms = eszettForms(w).map(term);
    return forms.includes(null) ? null : forms.length === 1 ? forms[0]! : `(${forms.join(" OR ")})`;
  });
  return groups.length === 0 || groups.includes(null) ? null : groups.join(" AND ");
}

/** One operand as an FTS5 reading over every ß/ss form of it; an excluded one as typed. */
function operandMatch(text: string, fold: boolean): Reading {
  const forms = fold ? eszettForms(text) : [text];
  const phrases = [...new Set(forms.map(phraseOf).filter((p): p is string => p !== null))];
  const runs = forms.map(operandRuns).filter((r): r is string[] => r !== null);
  return { match: phrases.length === 1 ? phrases[0]! : `(${phrases.join(" OR ")})`, stops: stopsOf(runs.map((r) => (r.length === 1 ? r[0]! : null))) };
}

/**
 * `match` in the subject and sender (`m`), the people's or the file names' words (mail 0173) or the
 * body (`b`): one operand anywhere in the letter. A letter with no body row has a null `b.rowid`,
 * whose `IN` is null, never false: coalesced, so `NOT` of it keeps that letter, as the server's
 * `not coalesce(b.body_tsv @@ t, false)` does.
 */
function inLetter(r: Reading): SQL {
  return sql`(m.rowid IN (${matchRows("messages_fts", r)})
    OR ${wordRows("message_people_fts", r)} OR ${wordRows("message_files_fts", r)}
    OR coalesce(b.rowid IN (${matchRows("message_bodies_fts", r)}), 0))`;
}

/** One query's part-word arms ({@link Dialect.search.partWords}); it has {@link partWordsOf}'s words. */
function partArmsOf(q: string): MailWordArms {
  const words = partWordsOf(q)!;
  const recency = sql`coalesce(m.date, 0)`;
  const ops = partOperandsOf(q);
  if (ops !== null) {
    // Each typed operand's kept words together in one table, each word in every ß/ss form, in both readings.
    const letter = sql`(${sql.join(ops.map((op) => {
      const kept = op.map((i) => words[i]!);
      const stems = readingOf(kept, stemOf);
      return partRows(stems === null ? null : { match: stems, stops: stopsOf(kept.flatMap(eszettForms)) }, readingOf(kept, startOf), "letter");
    }), sql` AND `)})`;
    return { head: { pred: letter, rank: recency }, text: { pred: letter, rank: recency }, across: true };
  }
  const f = ftsFoldedQueryOf(q, "stems");
  const stems = f.match === null ? null : { match: f.match, stops: f.stops };
  const starts = ftsFoldedQueryOf(q, "starts").match;
  return {
    head: { pred: partRows(stems, starts, "head"), rank: recency },
    text: { pred: partRows(stems, starts, "text"), rank: recency },
  };
}

/**
 * The part-word arm's reads: `stems` in the porter tables (the subject and sender, the body, the
 * file names), `starts` in the unstemmed ones (mail 0175) and the people's; the header's, the text's,
 * or the whole letter's. The reads keyed by one rowid are one set, so a row is asked once per key.
 */
function partRows(stems: Reading | null, starts: string | null, of: "head" | "text" | "letter"): SQL {
  const letters: SQL[] = [];
  const bodies: SQL[] = [];
  if (of !== "text" && stems !== null) letters.push(matchRows("messages_fts", stems));
  if (of !== "text" && starts !== null) letters.push(matchRows("messages_part_fts", { match: starts, stops: null }), matchRows("message_people_fts", { match: starts, stops: null }));
  if (of !== "head" && stems !== null) {
    letters.push(matchRows("message_files_fts", stems));
    bodies.push(matchRows("message_bodies_fts", stems));
  }
  if (of !== "head" && starts !== null) {
    letters.push(matchRows("message_files_part_fts", { match: starts, stops: null }));
    bodies.push(matchRows("message_bodies_part_fts", { match: starts, stops: null }));
  }
  const sets = [
    ...(letters.length === 0 ? [] : [sql`m.rowid IN (${sql.join(letters, sql` UNION ALL `)})`]),
    ...(bodies.length === 0 ? [] : [sql`b.rowid IN (${sql.join(bodies, sql` UNION ALL `)})`]),
  ];
  return sets.length === 0 ? sql`0` : sql`(${sql.join(sets, sql` OR `)})`;
}

/** Each porter table's unstemmed twin (mail 0175). */
const TWIN: Readonly<Record<string, string>> = { messages_fts: "messages_part_fts", message_bodies_fts: "message_bodies_part_fts", message_files_fts: "message_files_part_fts" };

/**
 * The rowids `table` holds for `r`. A porter reading whose words share a stopword's stem (mail 0176:
 * `ines` reads `in`, which the server never indexes) is read whole in the unstemmed twin instead; the
 * table not asked reads the empty phrase, so one is read.
 */
function matchRows(
  table: "messages_fts" | "message_bodies_fts" | "message_people_fts" | "message_files_fts"
    | "messages_part_fts" | "message_bodies_part_fts" | "message_files_part_fts" | "kb_entries_fts",
  r: Reading,
): SQL {
  const t = sql.raw(table);
  const twin = TWIN[table];
  if (twin === undefined || r.stops === null) return sql`SELECT rowid FROM ${t} WHERE ${t} MATCH ${r.match}`;
  const shared = sql`EXISTS (SELECT 1 FROM stopwords_fts WHERE stopwords_fts MATCH ${r.stops})`;
  const u = sql.raw(twin);
  return sql`SELECT rowid FROM ${t} WHERE ${t} MATCH (CASE WHEN ${shared} THEN '""' ELSE ${r.match} END)
    UNION ALL SELECT rowid FROM ${u} WHERE ${u} MATCH (CASE WHEN ${shared} THEN ${r.match} ELSE '""' END)`;
}

/**
 * The letters whose people's or file names' words (mail 0173) match `match`: tables keyed by the
 * letter's own rowid, read as one set on `m` (no lookup of the document, per match or per letter), never null.
 */
function wordRows(table: "message_people_fts" | "message_files_fts", r: Reading): SQL {
  return sql`m.rowid IN (${matchRows(table, r)})`;
}

/**
 * One word arm's rows: `own` (the subject and sender, or the body) or `table`'s words, either
 * matching; for a query of exclusions only, neither holding them.
 */
function armRows(own: SQL, table: "message_people_fts" | "message_files_fts", q: string): SQL {
  const f = ftsFoldedQueryOf(q);
  if (f.match !== null) return sql`(${own} OR ${wordRows(table, { match: f.match, stops: f.stops })})`;
  if (f.exclude !== null) return sql`(${own} AND NOT ${wordRows(table, { match: f.exclude, stops: f.stops })})`;
  return own;
}

/** The header arm's rows: the subject and sender, or the people's names and addresses. */
function headRows(q: string): SQL {
  return armRows(ftsRows(sql`m.rowid`, "messages_fts", q), "message_people_fts", q);
}

/**
 * The header arm's rank: the subject's and sender's bm25 where they hold the query, else 0 with no
 * read of `messages_fts`: a name in every letter's recipients would cost one read a letter.
 */
function headRank(q: string): SQL {
  const f = ftsFoldedQueryOf(q);
  return f.match === null ? sql`0` : sql`(CASE WHEN m.rowid IN (${matchRows("messages_fts", { match: f.match, stops: f.stops })})
    THEN ${ftsRank(sql`m.rowid`, "messages_fts", q)} ELSE 0 END)`;
}

/** The text arm's rows: the body, or the file names' words, which rank as a body word does. */
function textRows(q: string): SQL {
  return armRows(ftsRows(sql`b.rowid`, "message_bodies_fts", q), "message_files_fts", q);
}

/** No excluded operand anywhere in the letter, each table read once for all of them; undefined when nothing is excluded. */
function noneOf(ops: QueryOperands): SQL | undefined {
  if (ops.none.length === 0) return undefined;
  const rs = ops.none.map((o) => operandMatch(o.text, false));
  const stops = rs.every((r) => r.stops !== null) ? rs.map((r) => r.stops).join(" OR ") : null;
  return sql`(NOT ${inLetter({ match: rs.map((r) => r.match).join(" OR "), stops })})`;
}

/**
 * The query over the whole letter once it straddles its parts ({@link straddlesParts}), as the
 * server's: every operand of a group in either table, `head` held to it; no excluded one in either
 * is `excluded`, which the caller holds every arm to.
 */
function acrossOf(q: string, head: SearchArm, recency: SQL): MailWordArms | null {
  const ops = queryOperandsOf(q);
  if (!straddlesParts(ops)) return null;
  const groups = ops.any.map((g) => sql`(${sql.join(g.map((o) => inLetter(operandMatch(o.text, true))), sql` AND `)})`);
  const none = noneOf(ops);
  const letter = groups.length === 0 ? sql`1` : sql`(${sql.join(groups, sql` OR `)})`;
  return {
    head: { pred: sql`(${head.pred} AND ${letter})`, rank: head.rank }, text: { pred: letter, rank: recency },
    across: true, ...(none ? { excluded: none } : {}),
  };
}

/**
 * {@link ftsQueryOf} over every ß/ss form of the query (`eszettForms`), each form's expression
 * parenthesised and OR-ed; a query with one form is exactly its own expression.
 */
export function ftsFoldedQueryOf(q: string, mode: "words" | "stems" | "starts" = "words"): { match: string | null; exclude: string | null; stops: string | null } {
  const forms = eszettForms(q);
  if (forms.length === 1) return ftsQueryOf(q, mode);
  const reads = forms.map((f) => ftsQueryOf(f, mode)).filter((f) => f.match !== null);
  const stops = reads.every((f) => f.stops !== null) ? [...new Set(reads.map((f) => f.stops))].join(" OR ") : null;
  return reads.length === 0 ? ftsQueryOf(q, mode) : { match: reads.map((f) => `(${f.match})`).join(" OR "), exclude: null, stops };
}

/** The header columns and the recipients' `terms` LIKE every ß/ss form of `q` (`eszettForms`). */
function headLike(q: string): SQL {
  const one = (f: string): SQL => {
    const like = `%${f}%`;
    return sql`lower(m.subject) like lower(${like}) or lower(m.from_address) like lower(${like})
                  or lower(coalesce(s.terms, '')) like lower(${like})`;
  };
  return sql`(${sql.join(eszettForms(q).map(one), sql` or `)})`;
}

/**
 * The query inside the letter's subject or people, as `terms` holds them beside the file names: the
 * sender's and each recipient's name and address, never a recipient list's keys. Every ß/ss form.
 * A list is parsed only when its text holds the query at all.
 */
function peopleLike(q: string): SQL {
  const one = (f: string): SQL => {
    const like = `%${f}%`;
    const listed = (col: SQL): SQL => sql`(lower(coalesce(${col}, '')) like lower(${like})
      and exists (select 1 from json_each(case when json_valid(${col}) then ${col} else '[]' end) e
        where e.type = 'object' and (lower(coalesce(json_extract(e.value, '$.name'), '')) like lower(${like})
          or lower(coalesce(json_extract(e.value, '$.address'), '')) like lower(${like}))))`;
    return sql`lower(coalesce(m.subject, '')) like lower(${like}) or lower(coalesce(m.from_name, '')) like lower(${like})
      or lower(coalesce(m.from_address, '')) like lower(${like}) or ${listed(sql`m.to_addresses`)} or ${listed(sql`m.cc_addresses`)}`;
  };
  return sql`(${sql.join(eszettForms(q).map(one), sql` or `)})`;
}

/**
 * The letters whose file names' words (mail 0173) hold the query as a word or as the start of one:
 * the text arms find them so, by the same reads. One read of each table, a list of letters.
 */
function filesHold(q: string): SQL {
  const stems = [...new Map([ftsFoldedQueryOf(q), ftsFoldedQueryOf(q, "stems")].filter((f) => f.match !== null).map((f) => [f.match!, f])).values()];
  const starts = ftsFoldedQueryOf(q, "starts").match;
  const reads = [
    ...(stems.length === 0 ? [] : [matchRows("message_files_fts", {
      match: stems.length === 1 ? stems[0]!.match! : stems.map((f) => `(${f.match})`).join(" OR "),
      stops: stems.every((f) => f.stops !== null) ? [...new Set(stems.map((f) => f.stops))].join(" OR ") : null,
    })]),
    ...(starts === null ? [] : [matchRows("message_files_part_fts", { match: starts, stops: null })]),
  ];
  return reads.length === 0 ? sql`0` : sql`m.rowid IN (${sql.join(reads, sql` UNION ALL `)})`;
}

/** `col` among the rows `table` holds for this query — never a syntax error, whatever was typed. */
function ftsRows(col: SQL, table: "messages_fts" | "message_bodies_fts" | "kb_entries_fts", q: string): SQL {
  const f = ftsFoldedQueryOf(q);
  if (f.match !== null) return sql`${col} IN (${matchRows(table, { match: f.match, stops: f.stops })})`;
  if (f.exclude !== null) return sql`${col} NOT IN (${matchRows(table, { match: f.exclude, stops: f.stops })})`;
  return sql`0`;
}

/** The bm25 rank of one row for this query, negated to rank as the server's does; 0 with no match. */
function ftsRank(rowid: SQL, table: "messages_fts" | "kb_entries_fts", q: string): SQL {
  const f = ftsFoldedQueryOf(q);
  const t = sql.raw(table);
  return f.match === null ? sql`0`
    : sql`-COALESCE((SELECT bm25(${t}) FROM ${t} WHERE ${t} MATCH ${f.match} AND rowid = ${rowid}), 0)`;
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
    jsonText: (document, key) => sql`(${document} ->> ${`$."${assertJsonKey(key)}"`})`,
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

    // Epoch milliseconds here, so the tolerance is 48 h in ms and the undated floor is 0.
    arrivalKey: (date: SQL, arrivedAt: SQL): SQL => sql`(case when ${arrivedAt} is null then coalesce(${date}, 0) when ${date} is null then ${arrivedAt} when ${date} <= ${arrivedAt} and ${arrivedAt} - ${date} <= 172800000 then ${date} else ${arrivedAt} end)`,

    keysetBelow: (key: SQL, id: SQL, at: Date, atId: string, inclusive = false): SQL =>
      sql`${key} <= ${at.getTime()} and (${key} < ${at.getTime()} or ${id} ${sql.raw(inclusive ? "<=" : "<")} ${atId})`,

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
          return { pred: ftsRows(sql`rowid`, "kb_entries_fts", q), rank: ftsRank(sql`kb_entries.rowid`, "kb_entries_fts", q) };
        }
        return {
          pred: sql`(${ftsRows(sql`m.rowid`, "messages_fts", q)} or ${ftsRows(sql`b.rowid`, "message_bodies_fts", q)})`,
          rank: ftsRank(sql`m.rowid`, "messages_fts", q),
        };
      },
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
      // The FTS5 tables as the two word arms: the header (subject/sender, ranked by their bm25, or the
      // people's words) and the text (the body or the file names' words) by recency, as the server's
      // arms rank. FTS5 reads a quoted span as a phrase.
      words: (q: string): MailWordArms => {
        const head = { pred: headRows(q), rank: headRank(q) };
        const recency = sql`coalesce(m.date, 0)`;
        const across = acrossOf(q, head, recency);
        if (across) return across;
        // Past eight words asked each part is read alone, and `excluded` holds the letter all the same.
        const excluded = noneOf(queryOperandsOf(q));
        return { head, text: { pred: textRows(q), rank: recency }, ...(excluded ? { excluded } : {}) };
      },
      // Each word whole in the stemming tables `words` reads, OR from four letters as the start of a
      // word in the unstemmed ones (mail 0175, and the people's), each reading over all the words:
      // porter stems a prefix term too, so `"ines"*` there read `in`*, every invoice (`ftsQueryOf`).
      partWords: (qs: string | readonly string[]): MailWordArms | null => {
        const sides = partSidesOf(typeof qs === "string" ? [qs] : qs);
        return sides === null ? null : anyPartArms(sides.map(partArmsOf));
      },
      substring: (qs: string | readonly string[]): SearchArm => {
        // Every row, whether or not it has a search document yet: this store has no index for a
        // substring either way, so the header columns and the recipients' `terms` are one scan. A
        // letter its file names' words find is the text arms', as a body word's is: not read here
        // again, unless its subject or people hold the query too.
        const one = (q: string): SQL => sql`(${headLike(q)} and not (${filesHold(q)} and not ${peopleLike(q)}))`;
        return {
          pred: typeof qs === "string" ? one(qs) : qs.length === 1 ? one(qs[0]!) : sql`(${sql.join(qs.map(one), sql` or `)})`,
          rank: sql`coalesce(m.date, 0)`,
        };
      },
      // The substring arm reads the file names here, leaving out what the text arms find.
      names: (): null => null,
      // The typo arm here is a LIKE already (`fuzzy`): there is no costlier operator to spare.
      typoPrefilter: (): null => null,
      // The side table mail 0154's triggers keep, read by its (account, address) index.
      recipient: ({ accountId, address }): SQL =>
        sql`m.id in (select r.message_id from message_recipients r where r.account_id = ${accountId} and r.address = lower(${address}))`,
      // A LIKE, not an index operator, and one planner: there is nothing to set.
      wordKey: (): null => null,
      letterTerms: (): null => null,
      searchSession: (): null => null,
      // The FTS5 tables are kept by triggers over every row, so nothing here is unindexed.
      unindexed: (): null => null,
      // No INSERT inside a WITH on this store.
      withDocument: (): null => null,
      // No `tsv` column on this store (see the migration's twin).
      document: (): null => null,
    },
  };
}
