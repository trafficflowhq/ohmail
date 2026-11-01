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
import { type LockMode, assertComparable, assertDistinct, assertJsonKey, type Dialect, type LockOptions, type SearchArm, type SearchCorpus, type SearchDocumentParts, type UnindexedMailArms, type MailWordArms, PART_PREFIX_MIN_CHARS, eszettForms, partOperandsOf, partWordTails, partWordsOf, typoTrigramsOf, queryOperandsOf, straddlesParts, type QueryOperands, type QueryOperand, SEARCH_WEEK_AHEAD, SEARCH_WEEK_UNDATED } from "./index.js";

// Re-exported because it was defined here first and the server arm's tests import it by this
// path; the refusal itself belongs to both arms and now lives in the contract.
export { assertDistinct };


/** Fed to `to_tsvector`/`websearch_to_tsquery`; the literal is required for an immutable index. */
const TEXT_SEARCH_CONFIG = "english";

/**
 * The part-word arm's tsquery. Per word: itself and its stem; from four letters also every lexeme
 * starting with it and those stems of the word plus a tail the prefix does not already reach (each
 * term is one more pass over the index's pending list). A stopword is dropped, as the whole-word
 * parser drops it, except a long LAST word: `over` starts `overview`. INLINED, never bound: every
 * word is letters and digits and every tail a-z, so nothing leaves its quotes, and the expression
 * is immutable — it folds to one constant at plan time, priced by the vector's statistics.
 */
function partTsquery(q: string, opaque = false): SQL | null {
  const groups = partGroups(q);
  return groups === null ? null : opaqueOf(sql.raw(andTsquery(groups)), opaque);
}

/** A tsquery the planner prices (inline), or, `opaque`, one it reads at run time (`Dialect.search`'s `dated`). */
function opaqueOf(tsq: SQL, opaque: boolean): SQL {
  return opaque ? sql`(select ${tsq})` : tsq;
}

/**
 * The vectors and the substring corpus as only the dated indexes key them (mail 0174, `DATED_INDEX_SPECS`):
 * a dated read written over these can take no other index, so the planner reads its key and its words in
 * one scan rather than pairing the key with a smaller index that holds every account's words.
 */
const DATED_HEAD = sql.raw("(s.head_tsv || ''::tsvector)");
const DATED_TEXT = sql.raw("(s.text_tsv || ''::tsvector)");
const DATED_HEAD_TERMS = sql.raw("(split_part(s.terms, chr(31), 1) || ''::text)");
const DATED_NAME_TERMS = sql.raw("(split_part(s.terms, chr(31), 2) || ''::text)");

/** Inlined groups ANDed into one tsquery, a null group dropped. */
function andTsquery(groups: readonly string[]): string {
  return `(nullif(substr(${groups.map((g) => `coalesce(' & ' || ${g}, '')`).join(" || ")}, 4), '')::tsquery)`;
}

/** Each part-word's group as an inlined text expression (null for a dropped stopword). */
function partGroups(q: string): string[] | null {
  const words = partWordsOf(q);
  if (words === null) return null;
  const lit = (s: string): string => `'${s}'`;
  return words.map((w, i) => {
    const long = [...w].length >= PART_PREFIX_MIN_CHARS;
    // One alternative per ß/ss form of the word (`eszettForms`), each the shape it always had.
    const one = (v: string): string => {
      const forms = long ? [v, ...partWordTails(v).map((t) => v + t)].join(" ") : v;
      const stems = `strip(to_tsvector('${TEXT_SEARCH_CONFIG}', ${lit(forms)}))::text`;
      const extra = long ? `regexp_replace(${stems}, '''' || lower(${lit(v)}) || '[^'']*''', ' ', 'g')` : stems;
      const alts = `regexp_replace(btrim(${extra}), '\\s+', ' | ', 'g')`;
      return `'(''' || lower(${lit(v)}) || '''${long ? ":*" : ""}' || coalesce(' | ' || nullif(${alts}, ''), '') || ')'`;
    };
    const variants = eszettForms(w).map(one);
    const group = variants.length === 1 ? variants[0]! : `'(' || ${variants.join(" || ' | ' || ")} || ')'`;
    return long && i === words.length - 1 ? group
      : `case when length(to_tsvector('${TEXT_SEARCH_CONFIG}', ${lit(w)})) = 0 then null else ${group} end`;
  });
}

/** Each typed operand's kept part-words together in `head` or in `text` ({@link partOperandsOf}), ANDed; inlined. */
/** {@link partLetter} as single-index terms ({@link splitTerms}); `null` past three typed tokens. */
function partLetterTermsOf(q: string, opaque = false): SQL[] | null {
  const ops = partOperandsOf(q);
  const groups = partGroups(q);
  if (ops === null || groups === null || ops.length > LETTER_TERMS_MAX) return null;
  return splitTerms(ops.map((op) => {
    const t = sql.raw(andTsquery(op.map((i) => groups[i]!)));
    return { head: t, text: t };
  }), opaque);
}

function partLetter(q: string, head: SQL, text: SQL, opaque = false): SQL | null {
  const ops = partOperandsOf(q);
  const groups = partGroups(q);
  if (ops === null || groups === null) return null;
  return sql`(${sql.join(ops.map((op) => {
    const t = opaqueOf(sql.raw(andTsquery(op.map((i) => groups[i]!))), opaque);
    return sql`(${head} @@ ${t} or ${text} @@ ${t})`;
  }), sql` and `)})`;
}

/** One operand anywhere in the letter: in `head` or in `text`, every ß/ss form unless excluded. */
function inLetter(o: QueryOperand, head: SQL, text: SQL, fold: boolean, opaque = false): SQL {
  const typed = o.quoted ? `"${o.text}"` : o.text;
  const t = fold ? foldedTsquery(typed, opaque) : opaqueOf(sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${typed})`, opaque);
  return sql`(${head} @@ ${headTsquery(typed, fold, opaque)} or ${text} @@ ${t})`;
}

/**
 * The typed text as the HEAD vector is asked it: its subject is english words, its people `simple`
 * ones (`ines` stays `ines`, english reads `ine`), so each form is asked both ways, OR-ed.
 */
function headTsquery(q: string, fold = true, opaque = false): SQL {
  const forms = fold ? eszettForms(q) : [q];
  // Read at run time, a form both ways alike is asked once: a GIN read asks each repeated word again.
  const both = (f: string): SQL => (opaque
    ? sql`(select case when e::text = s::text then e else e || s end
        from (select websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${f}) as e, websearch_to_tsquery('simple', ${f}) as s) x)`
    : sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${f}) || websearch_to_tsquery('simple', ${f})`);
  return opaqueOf(sql`(${sql.join(forms.map(both), sql` || `)})`, opaque);
}

/** An operand as `websearch_to_tsquery` reads it. */
const typedOf = (o: QueryOperand): string => (o.quoted ? `"${o.text}"` : o.text);

/** The excluded operand in neither form of the head (`headTsquery`). */
const notInHead = (o: QueryOperand, headTsv: SQL): SQL => sql`not ${headTsv} @@ ${headTsquery(typedOf(o), false)}`;

/**
 * No excluded operand anywhere in the letter, each vector asked once for all of them, not once per
 * operand (each ask reads the vector); undefined when nothing is excluded.
 */
function noneOf(ops: QueryOperands, head: SQL, text: SQL): SQL | undefined {
  if (ops.none.length === 0) return undefined;
  if (ops.none.length === 1) return sql`(not ${inLetter(ops.none[0]!, head, text, false)})`;
  const any = (one: (typed: string) => SQL): SQL => sql`(${sql.join(ops.none.map((o) => one(typedOf(o))), sql` || `)})`;
  return sql`(not (${head} @@ ${any((t) => headTsquery(t, false))} or ${text} @@ ${any((t) => sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${t})`)}))`;
}

/**
 * The query over the whole letter, read once a query straddles its parts ({@link straddlesParts}):
 * every operand of a group in `head` or `text`. `head` keeps its own rank but is held to the letter,
 * so no arm admits a letter this reading refuses; no excluded operand in either is `excluded`, for
 * the caller to hold every arm to.
 */
function acrossOf(q: string, head: SearchArm, headTsv: SQL, textTsv: SQL, recency: SQL, opaque = false): MailWordArms | null {
  const ops = queryOperandsOf(q);
  if (!straddlesParts(ops)) return null;
  const groups = ops.any.map((g) => sql`(${sql.join(g.map((o) => inLetter(o, headTsv, textTsv, true, opaque)), sql` and `)})`);
  const none = noneOf(ops, headTsv, textTsv);
  const letter = groups.length === 0 ? sql`true` : sql`(${sql.join(groups, sql` or `)})`;
  // Each group typed again with every excluded operand, one tsquery the text GIN answers whole: as
  // typed, `websearch_to_tsquery` reads a bare `or` beside a minus word as "or not" (`mail or -x`),
  // and holds only the last of several groups to an exclusion.
  const noHead = ops.none.map((o) => notInHead(o, headTsv));
  const alone = none ? ops.any.map((g, i) => {
    const t = foldedTsquery([...g.map(typedOf), ...ops.none.map((o) => `-${typedOf(o)}`)].join(" "));
    return { pred: sql`(${textTsv} @@ ${t} and ${sql.join(noHead, sql` and `)})`, letter: groups[i]!, whole: g.length === 1 };
  }) : null;
  return {
    head: { pred: sql`(${head.pred} and ${letter})`, rank: head.rank }, text: { pred: letter, rank: recency },
    across: true, ...(none ? { excluded: none } : {}), ...(alone ? { alone } : {}),
  };
}

/** A group's operands in {@link letterTermsOf}: it reads 2^n terms, each one index scan. */
const LETTER_TERMS_MAX = 3;

/** The straddling letter as single-index terms: per `or` group, each split of its operands over head and text. */
function letterTermsOf(q: string, opaque = false): SQL[] | null {
  const ops = queryOperandsOf(q);
  if (ops.none.length > 0 || ops.any.length === 0) return null;
  const terms: SQL[] = [];
  for (const g of ops.any) {
    const each = groupTermsOf(g, opaque);
    if (each === null) return null;
    terms.push(...each);
  }
  return terms;
}

/** One `or` group's operands each in head or text, as single-index terms; `null` past three operands or for a quoted one. */
function groupTermsOf(g: readonly QueryOperand[], opaque = false): SQL[] | null {
  if (g.length > LETTER_TERMS_MAX || g.some((o) => o.quoted)) return null;
  // The same tsquery per operand as `inLetter(o, …, true)`.
  return splitTerms(g.map((o) => ({ head: headTsquery(o.text, true, opaque), text: foldedTsquery(o.text) })), opaque);
}

/** Every split of the operands over head and text: `head_tsv @@ (…) and text_tsv @@ (…)`, each one index read. */
function splitTerms(ops: ReadonlyArray<{ head: SQL; text: SQL }>, opaque: boolean): SQL[] {
  const terms: SQL[] = [];
  for (let mask = 0; mask < 1 << ops.length; mask++) {
    const head = ops.filter((_, i) => (mask & (1 << i)) !== 0).map((o) => o.head);
    const text = ops.filter((_, i) => (mask & (1 << i)) === 0).map((o) => o.text);
    const parts = [
      ...(head.length > 0 ? [sql`${opaque ? DATED_HEAD : sql`s.head_tsv`} @@ ${opaqueOf(sql`(${sql.join(head, sql` && `)})`, opaque)}`] : []),
      ...(text.length > 0 ? [sql`${opaque ? DATED_TEXT : sql`s.text_tsv`} @@ ${opaqueOf(sql`(${sql.join(text, sql` && `)})`, opaque)}`] : []),
    ];
    terms.push(sql`(${sql.join(parts, sql` and `)})`);
  }
  return terms;
}

/** The typed query as a tsquery, every ß/ss form of it OR-ed (`eszettForms`); one form is the old shape. */
function foldedTsquery(q: string, opaque = false): SQL {
  const forms = eszettForms(q);
  return opaqueOf(forms.length === 1 ? sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${q})`
    : sql`(${sql.join(forms.map((f) => sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${f})`), sql` || `)})`, opaque);
}

/**
 * The substring corpus's header text and its file names (`SEARCH_NAMES_MARK`, U+001F, between them),
 * each spelled as its own trigram index keys it (search-setup.ts): inline, never a bound parameter, or
 * the planner sees another expression and reads every one of the account's documents.
 */
const HEAD_TERMS = sql.raw("split_part(s.terms, chr(31), 1)");
const NAME_TERMS = sql.raw("split_part(s.terms, chr(31), 2)");

/** `col ilike '%q%'` for every ß/ss form of `q`; one form is the old single predicate. `opaque`: see `Dialect.search`. */
function likeAny(col: SQL, q: string, opaque = false): SQL {
  const forms = eszettForms(q);
  const like = (f: string): SQL => (opaque ? sql`${col} ilike (select ${`%${f}%`}::text)` : sql`${col} ilike ${`%${f}%`}`);
  return forms.length === 1 ? like(q) : sql`(${sql.join(forms.map(like), sql` or `)})`;
}

export function pgDialect(): Dialect {
  return {
    name: "pg",

    now: () => sql`now()`,
    ts: (at: Date) => sql`${at.toISOString()}::timestamptz`,
    tsOrNull: (at: Date | null) => (at === null ? sql`null` : sql`${at.toISOString()}::timestamptz`),

    castInt: (v) => sql`(${v})::int`,
    castText: (v) => sql`(${v})::text`,
    castUuid: (v) => sql`(${v})::uuid`,
    castJsonb: (v) => sql`(${v})::jsonb`,

    /**
     * THE MODE IS PASSED THROUGH, so a port keeps the strength the site chose.
     *
     * Defaulting to `"update"` is what every existing caller already gets. What the parameter buys
     * is the three sites that are NOT exclusive: a shared read and a key-share read let other
     * traffic past on purpose, and porting them to this member without carrying the mode would
     * have promoted them to exclusive — a change to what the statement does on the SERVER, made
     * while teaching it about a second store. That is the substitution this seam exists to
     * prevent, so the mode travels rather than being decided here.
     */
    forUpdate: <Q>(q: Q, opts: LockOptions = {}): Q => {
      const builder = q as { for?: (mode: LockMode, cfg?: object) => Q };
      if (typeof builder.for !== "function") return q;
      const cfg: Record<string, unknown> = {};
      if (opts.of !== undefined) cfg.of = opts.of;
      if (opts.skipLocked === true) cfg.skipLocked = true;
      return builder.for(opts.mode ?? "update", Object.keys(cfg).length > 0 ? cfg : undefined);
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

    /* `substring … from position('@' in …)` and NOT `split_part(…, '@', 2)`: the two disagree on
       an address carrying two separators, and this is the spelling `rule-retro.ts#matchPredicate`
       and `screener-service#heldRowsForDomain` already use — so the set a rule MOVES and the set
       it is COUNTED over stay one set. `messages_account_from_domain_idx` is built on it. */
    domainOf: (address) =>
      sql`substring(lower(${address}) from position('@' in lower(${address})) + 1)`,

    interval: (ms: number) => sql`(${`${Math.trunc(ms)} milliseconds`}::interval)`,

    // The server keeps microseconds; a sort key that must survive a round trip through a
    // JavaScript `Date` has to lose them HERE rather than on the way out, or the cursor handed to
    // a caller names an instant no row has.
    truncMs: (at) => sql`date_trunc('milliseconds', ${at})`,

    /* The clause the builder would have appended, as text. `sql.raw` for the keywords because they
       are a fixed vocabulary from {@link LockMode} and never a caller's string — the only values
       that reach here are the four modes and a boolean. */
    lockClause: (opts: LockOptions = {}) => sql.raw(
      `for ${opts.mode ?? "update"}${opts.skipLocked === true ? " skip locked" : ""}`),

    /* The element is the aliased relation's single column, which is why the alias is written with
       a column list. `sql.raw` for the alias because it is a fixed identifier chosen by the
       statement's author, never a value. `text` is `#>> '{}'` — the whole-document path, which is
       how this store unwraps a JSON scalar without quoting it. */
    jsonArrayElements: (source, alias) => {
      const value = sql.raw(`${alias}.value`);
      return {
        from: sql`jsonb_array_elements(${source}) as ${sql.raw(alias)}(value)`,
        value,
        isString: sql`jsonb_typeof(${value}) = 'string'`,
        text: sql`(${value} #>> '{}')`,
      };
    },

    jsonGet: (document, key) => sql`(${document} -> ${assertJsonKey(key)})`,
    jsonText: (document, key) => sql`(${document} ->> ${assertJsonKey(key)})`,
    jsonIsArray: (value) => sql`jsonb_typeof(${value}) = 'array'`,

    /* `||` between two jsonb objects IS the shallow merge, right-hand side winning. The device
       arm has to spell it out; the contract says why neither of that store's two candidates is
       this. */
    jsonMergeShallow: (document, patch) =>
      sql`(coalesce(${document}, '{}'::jsonb) || (${patch})::jsonb)`,

    /* THE KEY IS CAST, and it is not decoration: this function takes `VARIADIC "any"`, so a bound
       parameter in that position has nothing to resolve against and the server answers `could not
       determine data type of parameter` for the whole statement. */
    jsonObject: (entries) => sql`jsonb_build_object(${sql.join(
      Object.entries(entries).flatMap(([k, v]) => [sql`${k}::text`, sql`${v}`]), sql`, `)})`,

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

    foldLog: async (db, bounds, mark) => {
      const run = async (statement: SQL): Promise<unknown[][]> => pgDialect().exec(db, statement);
      const at = async (): Promise<string | null> => {
        const [row] = await run(sql`select pg_current_wal_insert_lsn()::text as at`);
        return typeof row?.[0] === "string" ? row[0] : null;
      };
      const grownSince = async (since: string): Promise<number | null> => {
        const [row] = await run(sql`select (pg_current_wal_insert_lsn() - ${since}::pg_lsn)::bigint::text as grew`);
        const grew = Number(row?.[0]);
        return Number.isFinite(grew) ? grew : null;
      };
      const grew = mark.folded === null ? null : await grownSince(mark.folded);
      if (grew !== null && grew < bounds.foldBytes) return { folded: false, grewBytes: grew, mark };
      await run(sql`CHECKPOINT`);
      return { folded: true, grewBytes: grew, mark: { folded: await at() } };
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

    // Truncated, not formatted: formatting every row costs more than the grouping it serves.
    monthBucket: (instant: SQL): SQL => sql`date_trunc('month', ${instant} at time zone 'UTC')`,

    // IMMUTABLE throughout — `timestamptz - timestamptz` and an interval literal — so it indexes.
    arrivalKey: (date: SQL, arrivedAt: SQL): SQL => sql`(case when ${arrivedAt} is null then coalesce(${date}, 'epoch'::timestamptz) when ${date} is null then ${arrivedAt} when ${date} <= ${arrivedAt} and ${arrivedAt} - ${date} <= interval '48 hours' then ${date} else ${arrivedAt} end)`,

    keysetBelow: (key: SQL, id: SQL, at: Date, atId: string, inclusive = false): SQL =>
      sql`(${key}, ${id}) ${sql.raw(inclusive ? "<=" : "<")} (${at.toISOString()}::timestamptz, ${atId}::uuid)`,

    search: {
      lexical: (q: string, corpus: SearchCorpus): SearchArm => {
        const tsq = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${q})`;
        if (corpus === "kb") {
          return { pred: sql`kb_tsv @@ ${tsq}`, rank: sql`ts_rank(kb_tsv, ${tsq})` };
        }
        // The search document's HEAD vector (mail 0125) — the mail corpus's arms are `words`
        // below. The old shape was an OR across the body join, which no index can serve: a
        // sequential scan of the whole account.
        return { pred: sql`s.head_tsv @@ ${tsq}`, rank: sql`ts_rank_cd(s.head_tsv, ${tsq})` };
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
          // `<%` is `word_similarity >= pg_trgm.word_similarity_threshold`, and unlike the function
          // it is served by `message_search_terms_trgm_idx`; the caller sets the threshold for its
          // transaction through `fuzzyThreshold`, so the operator and `opts.threshold` agree.
          return { pred: sql`${q} <% s.terms`, rank: sql`word_similarity(${q}, s.terms)` };
        }
        // The degrade, for a deployment without the trigram index: the same shape, no index, and
        // it still answers rather than pretending the arm does not exist. RECENCY is the rank —
        // there is no relevance signal left, and a constant here would have thrown away the one
        // ordering the caller still had.
        return { pred: sql`s.terms ilike ${like}`, rank: sql`coalesce(extract(epoch from m.date), 0)` };
      },
      typoPrefilter: (q: string, opts): SQL | null => {
        // A trigram present in an ASCII document is a substring of its lower-cased text, at a
        // word edge where it is padded. Every literal is [a-z0-9] and regex syntax, so INLINED.
        const all = typoTrigramsOf(q);
        if (all === null) return null;
        const need = Math.ceil(opts.threshold * all.length - 1e-6);
        if (need <= 0) return null;
        const edge = "[^a-z0-9]";
        const test = (t: string): string => {
          const core = t.trim();
          const re = (t.startsWith(" ") ? `(^|${edge})` : "") + core + (t.endsWith(" ") ? `(${edge}|$)` : "");
          return t === core ? `(strpos(LOW, '${core}') > 0)::int` : `(strpos(LOW, '${core}') > 0 and LOW ~ '${re}')::int`;
        };
        const parts = all.map(test).join(" + ").split("LOW");
        const sum = sql.join(parts.map((p) => sql.raw(p)), opts.lowered);
        return sql`(octet_length(${opts.terms}) > length(${opts.terms}) or (${sum}) >= ${sql.raw(String(need))})`;
      },
      words: (q: string, opts): MailWordArms => {
        const opaque = opts?.dated === true;
        const [headTsv, textTsv] = opaque ? [DATED_HEAD, DATED_TEXT] : [sql`s.head_tsv`, sql`s.text_tsv`];
        const tsq = foldedTsquery(q, opaque);
        const hq = headTsquery(q, true, opaque);
        const head = { pred: sql`${headTsv} @@ ${hq}`, rank: sql`ts_rank_cd(s.head_tsv, ${hq})` };
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        const across = acrossOf(q, head, headTsv, textTsv, recency, opaque);
        if (across) {
          const terms = letterTermsOf(q, opaque);
          return terms ? { ...across, terms } : across;
        }
        // Each half of `hq` refuses only its own form of an excluded word: the head refuses both.
        // Past eight words asked each part is read alone, and `excluded` holds the letter all the same.
        const ops = queryOperandsOf(q);
        const none = ops.none.map((o) => notInHead(o, headTsv));
        const pred = none.length === 0 ? head.pred : sql`(${head.pred} and ${sql.join(none, sql` and `)})`;
        const excluded = noneOf(ops, headTsv, textTsv);
        return { head: { pred, rank: head.rank }, text: { pred: sql`${textTsv} @@ ${tsq}`, rank: recency }, ...(excluded ? { excluded } : {}) };
      },
      partWords: (q: string, opts): MailWordArms | null => {
        const opaque = opts?.dated === true;
        const [headTsv, textTsv] = opaque ? [DATED_HEAD, DATED_TEXT] : [sql`s.head_tsv`, sql`s.text_tsv`];
        const tsq = partTsquery(q, opaque);
        if (tsq === null) return null;
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        const letter = partLetter(q, headTsv, textTsv, opaque);
        if (letter !== null) {
          const terms = partLetterTermsOf(q, opaque);
          return { head: { pred: letter, rank: recency }, text: { pred: letter, rank: recency }, across: true, ...(terms ? { terms } : {}) };
        }
        return {
          head: { pred: sql`${headTsv} @@ ${tsq}`, rank: recency },
          text: { pred: sql`${textTsv} @@ ${tsq}`, rank: recency },
        };
      },
      substring: (q: string, opts): SearchArm => ({
        // The header text alone (subject, people): `message_search_head_terms_trgm_idx` serves the ILIKE.
        pred: opts.dated === true ? likeAny(DATED_HEAD_TERMS, q, true) : likeAny(HEAD_TERMS, q),
        rank: opts.trigram ? sql`word_similarity(${q}, ${HEAD_TERMS})` : sql`coalesce(extract(epoch from m.date), 0)`,
      }),
      // The file names: `message_search_names_trgm_idx` serves the ILIKE.
      names: (q: string, opts): SearchArm => ({
        pred: opts?.dated === true ? likeAny(DATED_NAME_TERMS, q, true) : likeAny(NAME_TERMS, q), rank: sql`coalesce(extract(epoch from m.date), 0)`,
      }),
      unindexed: (q: string, opts): UnindexedMailArms => {
        // The pre-0125 columns, one index per branch (subject_tsv / body_tsv GINs, the two trgm
        // GINs) — never an OR, which is the shape that seq-scanned.
        const tsq = foldedTsquery(q);
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        const sim = (col: SQL): SQL => (opts.trigram ? sql`word_similarity(${q}, ${col})` : recency);
        const part = partTsquery(q);
        const ops = queryOperandsOf(q);
        // No excluded operand, each table's own NOT, a row without a body kept: every branch here is held to it.
        const none = ops.none.length === 0 ? null : ops.none.map((o) => {
          const t = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${o.quoted ? `"${o.text}"` : o.text})`;
          return sql`not coalesce(m.subject_tsv @@ ${t}, false) and not coalesce(b.body_tsv @@ ${t}, false)`;
        });
        return {
          words: {
            head: { pred: sql`m.subject_tsv @@ ${tsq}`, rank: sql`ts_rank(m.subject_tsv, ${tsq})` },
            text: { pred: sql`b.body_tsv @@ ${tsq}`, rank: recency },
          },
          part: part === null ? null : {
            head: { pred: sql`m.subject_tsv @@ ${part}`, rank: recency },
            text: { pred: sql`b.body_tsv @@ ${part}`, rank: recency },
          },
          ...(none === null ? {} : { excluded: sql`(${sql.join(none, sql` and `)})` }),
          substring: [
            { pred: likeAny(sql`m.subject`, q), rank: sim(sql`m.subject`) },
            { pred: likeAny(sql`m.from_address`, q), rank: sim(sql`m.from_address`) },
          ],
          fuzzy: opts.trigram
            ? [
              { pred: sql`${q} <% m.subject`, rank: sim(sql`m.subject`) },
              { pred: sql`${q} <% m.from_address`, rank: sim(sql`m.from_address`) },
            ]
            : [],
        };
      },
      // The word index's key expression (`message_search_words_idx`): no other index carries it,
      // so the planner reads the account and the words in one GIN.
      wordKey: (accountId: string): SQL => sql`((s.account_id)::text = (${accountId}::uuid)::text)`,
      letterTerms: (q: string): SQL[] | null => letterTermsOf(q),
      // Textually the index's expression over `m` (mail 0154), or the planner cannot use it.
      recipient: ({ accountId, address }): SQL =>
        sql`messages_recipient_keys(m.account_id, m.to_addresses, m.cc_addresses) @> array[${accountId}::text || ':' || lower(${address})]`,
      searchSession: (opts): SQL | null => {
        const sets: SQL[] = [];
        if (opts.typoThreshold !== undefined) {
          // A LITERAL, not a parameter: a statement with no parameter is one round trip through a
          // transaction-mode pooler, where the driver describes every parameterized statement
          // before it binds. The value is a number this module checks, never caller text.
          const t = Number(opts.typoThreshold);
          if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error(`typo threshold ${String(opts.typoThreshold)} is not in [0, 1]`);
          sets.push(sql`set_config('pg_trgm.word_similarity_threshold', ${sql.raw(`'${String(t)}'`)}, true)`);
        }
        if (opts.statementTimeoutMs !== undefined) {
          // A literal for the reason the threshold is one; an integer this module checks.
          const ms = Number(opts.statementTimeoutMs);
          if (!Number.isInteger(ms) || ms <= 0) throw new Error(`statement timeout ${String(opts.statementTimeoutMs)} is not a positive integer`);
          sets.push(sql`set_config('statement_timeout', ${sql.raw(`'${String(ms)}'`)}, true)`);
        }
        if (opts.preferIndexes === true) {
          // A word set past hash_mem is no longer a hashed SubPlan, and is asked again per letter
          // walked (measured 68 ms to 13 s).
          sets.push(sql`set_config('enable_seqscan', 'off', true)`, sql`set_config('hash_mem_multiplier', '8', true)`);
        }
        // JIT and parallel workers never pay back on a search read, and a stock Postgres arms both on
        // plan cost: a broad word's page on 74k priced 115k (JIT's threshold is 100k), compiled 336
        // functions in ~60 ms and ran twice as long; its workers' start-up cost ~15 ms more than a
        // serial plan, and the whole-set counts read no faster with them (self-hosted Postgres 16).
        if (sets.length > 0) {
          sets.push(sql`set_config('jit', 'off', true)`, sql`set_config('max_parallel_workers_per_gather', '0', true)`);
        }
        // Each named apart: a positional read refuses two columns of one name.
        return sets.length === 0 ? null
          : sql`select ${sql.join(sets.map((x, i) => sql`${x} as ${sql.raw(`s${i}`)}`), sql`, `)}`;
      },
      withDocument: (bodyInsert: SQL, documentUpsert: SQL): SQL =>
        sql`with body as (${bodyInsert}) ${documentUpsert} returning (select count(*) from body)::int as body_rows`,
      document: (p: SearchDocumentParts) => ({
        // No file name in the head: the names, whole and in parts, are words of the text (`p.body`).
        head: sql`(setweight(to_tsvector(${TEXT_SEARCH_CONFIG}, ${p.subject}), 'A')
          || setweight(to_tsvector('simple', ${p.people}), 'B'))`,
        text: sql`to_tsvector(${TEXT_SEARCH_CONFIG}, ${p.body})`,
      }),
      // Mail 0174's function, the one its trigger computes the month with.
      week: (date: SQL, written: Date): SQL => sql`message_search_week(${date}, ${written.toISOString()}::timestamptz)`,
    },
  };
}

/**
 * THE SERVER'S DATED READS (mail 0174): the newest (or oldest) matches of a search's arms read month by
 * month off the dated indexes, so a broad word costs its newest month, never every match. The months are
 * the account's months with mail, newest first (`datedMonths`, off the History index), read in two steps
 * (one month, then the two after it), every arm's branches together and each month under its own key, until
 * each arm holds its `k` letters. An arm still short counts its matches in the whole account once: one with
 * at most its reach of them is read whole, and any other reads the rest of its documents past those months
 * as one set, whose letters are looked up one by one where they are few, else found by walking the History
 * index in the read's order against the set, as the reads without months date a large set (an empty month costs an index read
 * a branch, and a word in old mail would read every month). Each step's documents are dated with one History
 * range read under `where`, so only living letters count toward `k`; the letters dated past the month after
 * they were written sit in one bucket, read first where the account has any. Never asked beside an excluded
 * word: every read there is the one without months.
 */

/** The months the steps read at most: one, then the two after it. */
const MONTHS_MAX = 3;
/** Step s reads the months at positions 2^s − 1 to 2^(s+1) − 2: two steps read three. */
const STEPS_MAX = 2;
/** The rest of an arm short past its months is looked up one letter at a time up to this many cuts, else walked. */
const SET_LOOKUP_CUTS = 4;
/** An arm with at most this many times `k` matches in the whole account is read whole once it is sparse. */
const WHOLE_FACTOR = 2;

/** A document's dated key, spelled as the dated indexes key it (`DATED_KEY` in `../search-setup.ts`), over `s`. */
const DKEY = sql.raw("(((s.account_id)::text || ':'::text) || (s.search_week)::text)");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An account id as the dated reads inline it: a lower-case uuid, or `null` for anything else. */
export function datedAccount(accountId: string): string | null {
  const a = accountId.toLowerCase();
  return UUID.test(a) ? a : null;
}

/** A letter's UTC month as `search_week` counts it, over a timestamp expression. */
function monthOf(at: SQL): SQL {
  return sql`(extract(year from ${at} at time zone 'UTC')::int * 12 + extract(month from ${at} at time zone 'UTC')::int - 1)`;
}

/** The first instant of the UTC month of a timestamp expression. */
function monthStart(at: SQL): SQL {
  return sql`(date_trunc('month', ${at} at time zone 'UTC') at time zone 'UTC')`;
}

/**
 * THE ACCOUNT'S MONTHS WITH MAIL, in reading order, as `(m, st, i)` (`st` the month's first instant): one
 * History-index read each, and only as
 * many as the reads ask for (the list is read lazily). Newest first from the newest letter `first` admits
 * (`desc`), or oldest first from the oldest (`asc`). Months with no letter are never asked, so an archive
 * whose mail stops years ago, or a letter dated 1970, costs nothing.
 */
export function datedMonths(o: { account: string; dir: "desc" | "asc"; first?: SQL }): SQL {
  const acct = sql.raw(`'${o.account}'::uuid`);
  const probe = (bound: SQL): SQL => o.dir === "desc"
    ? sql`(select m.date from messages m where m.account_id = ${acct} and m.deleted_at is null and ${bound}
        order by m.date desc nulls last limit 1)`
    : sql`(select m.date from messages m where m.account_id = ${acct} and m.deleted_at is null and ${bound}
        order by m.date asc nulls first limit 1)`;
  const first = o.first ?? sql`m.date is not null`;
  const next = o.dir === "desc" ? sql`m.date < w.st` : sql`m.date >= ((w.st at time zone 'UTC') + interval '1 month') at time zone 'UTC'`;
  return sql`(with recursive w(m, st, i) as (
      select ${monthOf(sql`f.date`)}, ${monthStart(sql`f.date`)}, 0 from ${probe(first)} f
      union all
      select ${monthOf(sql`n.date`)}, ${monthStart(sql`n.date`)}, w.i + 1 from w cross join lateral ${probe(next)} n where w.i < ${sql.raw(String(MONTHS_MAX - 1))}
    ) select m, st, i from w)`;
}

/** One branch of a dated read: what the dated index answers beside the key, and the rank its arm orders by. */
export interface DatedBranch {
  /** Over `s`. */
  readonly raw: SQL;
  /** Over `s`; `0` for a recency arm. */
  readonly rank: SQL;
}

/** One arm of a {@link datedShared} read. */
export interface DatedArmSpec {
  readonly branches: readonly DatedBranch[];
  /** How many letters the arm reads: its cut, or a ranked arm's window. */
  readonly k: number;
  /** It is read whole once it has at most this many times `k` matches in all (default {@link WHOLE_FACTOR}). */
  readonly reach?: number;
  /**
   * The step before which it first asks its reach: by default after both steps (three months); -1, before any,
   * and it is read whole at once where it has at most its reach.
   */
  readonly wholeFrom?: number;
  /**
   * With `wholeFrom` -1: the arm's branches as the reads without months read them, off its own indexes (each over `s`, holding
   * the account), which its whole count and whole read take, so a few matches cost what they cost there.
   */
  readonly plain?: readonly DatedBranch[];
}

/** The account's own documents, as the dated indexes' first column keys them (`DATED_ACCOUNT`), over `s`. */
function accountKey(account: string): SQL {
  return sql.raw(`(((s.account_id)::text || ''::text) = '${account}'::text)`);
}

/**
 * What a read of documents asks the index: each of a step's keys (`keys`, a query of one text column, each
 * key one index read beside the words), or a condition over `s` (the account, the rest past the months).
 */
type DocScope = { readonly keys: SQL } | { readonly where: SQL };

/**
 * The documents a scope admits, each branch off its own index, as `(id, bit, wk, r0…)`: `bit` the arm's bit,
 * `wk` the document's month, `rN` arm N's rank. A branch is read only while `gate(arm)` holds.
 */
function docsOf(arms: readonly DatedArmSpec[], scope: DocScope, gate: (arm: number) => SQL | undefined, only?: number): SQL {
  return sql.join(arms.flatMap((a, i) => (only !== undefined && only !== i ? [] : a.branches).map((b) => {
    const ranks = arms.map((_, j) => (j === i ? sql`(${b.rank})::float8` : sql`null::float8`));
    const g = gate(i);
    const row = sql`s.message_id as id, ${sql.raw(String(1 << i))} as bit, s.search_week as wk, ${sql.join(ranks, sql`, `)}`;
    const gated = g === undefined ? sql`` : sql` and ${g}`;
    return "keys" in scope
      ? sql`select x.* from (${scope.keys}) mk(k) cross join lateral (select ${row} from message_search s
          where ${DKEY} = mk.k and ${b.raw}${gated} offset 0) x`
      : sql`select ${row} from message_search s where ${scope.where} and ${b.raw}${gated}`;
  })), sql` union all `);
}

const rankCols = (n: number, pre = ""): SQL => sql.raw(Array.from({ length: n }, (_, i) => `${pre}r${i}`).join(", "));

/** The documents a scope admits, one row each: `(id, mask, wk, r0…)` ({@link docsOf}). */
function grouped(arms: readonly DatedArmSpec[], scope: DocScope, gate: (arm: number) => SQL | undefined): SQL {
  const n = arms.length;
  const maxes = sql.raw(Array.from({ length: n }, (_, i) => `max(c.r${i}) as r${i}`).join(", "));
  return sql`(select c.id as id, bit_or(c.bit) as mask, max(c.wk) as wk, ${maxes}
        from (select * from (${docsOf(arms, scope, gate)}) d(id, bit, wk, ${rankCols(n)})) c group by c.id)`;
}

/**
 * EVERY ARM'S NEWEST (or oldest) LETTERS, as the query `(id, date, mask, r0…)`: each letter once, `mask` the
 * arms it matches, `rN` arm N's rank. Arm N's newest `k` are its rows' newest `k` (the read's order is its
 * months'), exactly: every letter the months did not reach is older (or newer) than those, save the ahead
 * bucket, which is read first. One recursive statement reads the steps, one each time round, each month of a
 * step under its own key so the index reads the key and the words together; so the read is planned once
 * whatever it reaches, and every arm's letters are looked up together.
 */
export function datedShared(o: {
  readonly account: string; readonly arms: readonly DatedArmSpec[]; readonly where: SQL; readonly months: string; readonly after?: SQL;
  /** The months' order, as {@link datedMonths} read them: newest first (the default) or oldest first. */
  readonly dir?: "desc" | "asc";
  /** Nothing is read unless this holds. */
  readonly gate?: SQL;
}): SQL {
  const { arms } = o;
  const gate = o.gate ?? sql`true`;
  const lit = (v: number | string): SQL => sql.raw(String(v));
  const months = sql.raw(o.months);
  const aheadKey = sql.raw(`'${o.account}:${SEARCH_WEEK_AHEAD}'`);
  // Step `j`'s months: positions 2^j − 1 to 2^(j+1) − 2 of the read's months, as a query of their rows; the
  // step before them (`j` -1) is the ahead bucket.
  const span = (j: SQL): SQL => sql`(select t.m, t.st, t.i from ${months} t
    offset (case when ${j} >= 0 then (1 << ${j}) - 1 else 0 end) limit (case when ${j} >= 0 then 1 << ${j} else 0 end))`;
  const keys = (j: SQL): SQL => sql`select ${aheadKey} where ${j} < 0
    union all select ${sql.raw(`'${o.account}:'`)} || t.m::text from ${span(j)} t`;
  // Arm `i`'s documents in the whole account, up to its reach and one: all of them when no more (`whole`).
  const dh = (i: number): SQL => sql.raw(`dh${i}`);
  const reach = (i: number): number => (arms[i]!.reach ?? WHOLE_FACTOR) * arms[i]!.k;
  const whole = (i: number): SQL => sql`((select count(*) from ${dh(i)}) <= ${lit(reach(i))})`;
  const ns = arms.map((_, i) => sql.raw(`n${i}`));
  // Arm `i` reads the next step while it is short. Past its first steps (`wholeFrom`) it asks whether it
  // has at most its reach in all, and if so is read whole instead of reading on: a word in a few letters a
  // month would cost a month's index read every few letters.
  const short = (i: number): SQL => {
    const a = arms[i]!;
    if ((a.wholeFrom ?? 1) < 0) return sql`(w.${ns[i]!} < ${lit(a.k)} and not ${whole(i)})`;
    return sql`(w.i < 0 or (w.${ns[i]!} < ${lit(a.k)} and (w.i < ${lit(a.wholeFrom ?? 1)} or not ${whole(i)})))`;
  };
  const bit = (i: number): SQL => lit(1 << i);
  const counts = sql.join(arms.map((_, i) =>
    sql`count(*) filter (where c.id is not null and (c.mask & ${bit(i)}) <> 0 and c.wk is distinct from ${lit(SEARCH_WEEK_AHEAD)}) as ${ns[i]!}`), sql`, `);
  const kept = sql`filter (where c.id is not null and c.mask <> 0)`;
  const arrays = sql.join(arms.map((_, i) => sql`array_agg(c.${sql.raw(`r${i}`)}) ${kept} as ${sql.raw(`r${i}s`)}`), sql`, `);
  const raised = sql.join(ns.map((x) => sql`w.${x} + x.${x}`), sql`, `);
  const nulls = sql.raw(Array.from({ length: arms.length }, () => "null::float8[]").join(", "));
  const zeros = sql.raw(arms.map(() => "0::bigint").join(", "));
  const rArrays = sql.raw(Array.from({ length: arms.length }, (_, i) => `x.r${i}s`).join(", "));
  const wCols = sql.raw(["i", ...arms.map((_, i) => `n${i}`), "ids", "dates", "masks", ...arms.map((_, i) => `r${i}s`)].join(", "));
  // Past the months: the undated letters, and where the steps stopped at their bound (theirs, or the
  // list's own), those past the last month read.
  const last = sql`(select case when i < 0 then -1 else (1 << (i + 1)) - 2 end from wl)`;
  const more = sql`(${last} >= ${lit(MONTHS_MAX - 1)} or exists (select 1 from ${months} t offset greatest(${last} + 1, 0)))`;
  const past = sql`(case when ${last} < 0 then true
    else s.search_week ${sql.raw(o.dir === "asc" ? ">" : "<")} (select t.m from (select m, i from ${months} t limit ${last} + 1) t order by t.i desc limit 1) end)`;
  const unasked = sql`(s.search_week is null or s.search_week = ${lit(SEARCH_WEEK_UNDATED)} or (s.search_week >= 0 and ${more} and ${past}))`;
  // One step's documents and their letters: the step's living letters read off the History index in one
  // range, never one key lookup a document; the ahead bucket's, whose dates are anywhere, each by its key.
  const j = sql`w.i + 1`;
  const after = o.after === undefined ? sql`` : sql` and ${o.after}`;
  const step = sql`with r as materialized ${grouped(arms, { keys: keys(j) }, short)},
      b as materialized (select min(t.st) as lo, max(t.st) as hi from ${span(j)} t),
      h as materialized (select m.id as id, m.date as date from messages m where ${j} >= 0 and ${o.where}${after}
        and m.date >= (select lo from b) and m.date < (((select hi from b) at time zone 'UTC') + interval '1 month') at time zone 'UTC')
      select coalesce(h.id, p.id) as id, coalesce(h.date, p.date) as date, r.mask, r.wk, ${rankCols(arms.length, "r.")}
      from r left join h on h.id = r.id and r.mask <> 0
        left join lateral (select m.id as id, m.date as date from messages m
          where ${j} < 0 and r.mask <> 0 and m.id = r.id and ${o.where}${after} offset 0) p on true`;
  const acct = accountKey(o.account);
  const rCols = rankCols(arms.length);
  // Short past the months: its documents whole when it has no more than its reach, else those the months did not ask.
  const rest = (i: number): SQL => sql`(${gate} and (select ${ns[i]!} < ${lit(arms[i]!.k)} from wl))`;
  // Past the months the letters are few (an arm read whole, or what the months did not reach): each is
  // dated by its key. An arm read whole before any month counts and reads its branches as the reads without months do.
  const first = (i: number): boolean => (arms[i]!.wholeFrom ?? 1) < 0;
  const wholeDocs = (i: number): SQL => (first(i) && arms[i]!.plain !== undefined
    ? docsOf(arms.map((a, j) => (j === i ? { ...a, branches: a.plain! } : a)), { where: sql`true` }, () => undefined, i)
    : docsOf(arms, { where: acct }, () => undefined, i));
  const named = arms.map((_, i) => sql`${dh(i)} as materialized (select * from (${wholeDocs(i)}) d(id, bit, wk, ${rCols})
    limit ${lit(reach(i) + 1)})`);
  // An arm's letters past the months: each looked up where it has few, else found by walking the History index in
  // the read's order against them, its cut at most (oldest first: the dated letters, then the undated ones).
  const few = (i: number): SQL => sql`((select count(*) from wg where (mask & ${bit(i)}) <> 0) <= ${lit(SET_LOOKUP_CUTS * arms[i]!.k)})`;
  const member = (i: number): SQL => sql`(m.id in (select id from wg where (mask & ${bit(i)}) <> 0)) is true`;
  const walked = (i: number): SQL => (o.dir === "asc"
    ? sql`((select m.id as id, m.date as date from messages m where ${o.where}${after} and m.date is not null and not ${few(i)} and ${member(i)}
          order by m.date asc, m.id asc limit ${lit(arms[i]!.k)})
        union all (select m.id as id, m.date as date from messages m where ${o.where}${after} and m.date is null and not ${few(i)} and ${member(i)}
          order by m.id asc limit ${lit(arms[i]!.k)}))`
    : sql`(select m.id as id, m.date as date from messages m where ${o.where}${after} and not ${few(i)} and ${member(i)}
        order by m.date desc nulls last, m.id desc limit ${lit(arms[i]!.k)})`);
  // The ahead bucket is read first, where the account has a letter in it and some arm reads months.
  const stepping = sql.join(arms.map((_, i) => (first(i) ? sql`not ${whole(i)}` : sql`true`)), sql` or `);
  const ahead = sql`(case when ${stepping} then (case when exists (select 1 from message_search s where ${DKEY} = ${aheadKey}) then -2 else -1 end)
    else -1 end)`;
  const maxRanks = sql.raw(Array.from({ length: arms.length }, (_, i) => `max(r${i}) as r${i}`).join(", "));
  return sql`with recursive ${sql.join(named, sql`, `)},
    w(${wCols}) as (
      select ${ahead}, ${zeros}, null::uuid[], null::timestamptz[], null::int[], ${nulls}
      union all
      select w.i + 1, ${raised}, x.ids, x.dates, x.masks, ${rArrays} from w cross join lateral (
        select ${counts}, array_agg(c.id) ${kept} as ids, array_agg(c.date) ${kept} as dates, array_agg(c.mask) ${kept} as masks, ${arrays}
        from (${step}) c) x
      where ${gate} and (${sql.join(arms.map((_, i) => short(i)), sql` or `)})
        and w.i < ${lit(STEPS_MAX - 1)} and (w.i < -1 or exists (select 1 from ${span(sql`w.i + 1`)} t))),
    wl as materialized (select * from w order by i desc limit 1),
    wd as materialized (${sql.join(arms.map((_, i) => sql`select * from ${dh(i)} where ${rest(i)} and ${whole(i)}`), sql` union all `)}
      union all select * from (${docsOf(arms, { where: sql`${acct} and ${unasked}` }, (i) => sql`${rest(i)} and not ${whole(i)}`)}) d(id, bit, wk, ${rCols})),
    wg as materialized (select id, bit_or(bit) as mask, max(wk) as wk, ${maxRanks} from wd group by id),
    wz as materialized (${sql.join(arms.map((_, i) => sql`select p.id as id, p.date as date, ${bit(i)} as mask, ${rankCols(arms.length, "g.")}
      from wg g cross join lateral (select m.id as id, m.date as date from messages m where m.id = g.id and ${o.where}${after} offset 0) p
      where (g.mask & ${bit(i)}) <> 0 and ${few(i)}
      union all select x.id, x.date, ${bit(i)} as mask, ${rankCols(arms.length, "g.")} from ${walked(i)} x join wg g on g.id = x.id`), sql` union all `)})
    select id, date, bit_or(mask) as mask, ${maxRanks} from (
      select u.id, u.date, u.mask, ${rankCols(arms.length, "u.")} from w
        cross join lateral unnest(w.ids, w.dates, w.masks, ${sql.raw(Array.from({ length: arms.length }, (_, i) => `w.r${i}s`).join(", "))}) as u(id, date, mask, ${rankCols(arms.length)})
        where u.mask <> 0
      union all select id, date, mask, ${rankCols(arms.length)} from wz) u
    group by id, date`;
}

/** One arm's {@link datedShared} read: its `k` letters in `dir` order, as `(id, date, rank)`. */
export interface DatedSpec {
  readonly account: string;
  readonly branches: readonly DatedBranch[];
  readonly where: SQL;
  readonly k: number;
  readonly dir: "desc" | "asc";
  /** The {@link datedMonths} statement's name, in the read's order. */
  readonly months: string;
  /** Over `m`: strictly after the cursor, in this read's order. */
  readonly after?: SQL;
  /** Nothing is read unless this holds. */
  readonly gate?: SQL;
  /** Read whole before any month where it has at most this many matches in all, its branches as {@link plain}. */
  readonly whole?: number;
  /** The branches as the reads without months read them (`DatedArmSpec.plain`), for the whole count and read. */
  readonly plain?: readonly DatedBranch[];
}

/** THE `k` NEWEST (or oldest) LETTERS ONE SET OF BRANCHES MATCHES, as the subquery `(id, date, rank)`, in order. */
export function datedRead(spec: DatedSpec): SQL {
  const order = spec.dir === "desc" ? sql`date desc nulls last, id desc` : sql`date asc nulls last, id asc`;
  const arm: DatedArmSpec = {
    branches: spec.branches, k: spec.k,
    ...(spec.whole === undefined ? {} : {
      wholeFrom: -1, reach: Math.max(WHOLE_FACTOR, Math.ceil(spec.whole / spec.k)), ...(spec.plain ? { plain: spec.plain } : {}),
    }),
  };
  return sql`(select id, date, r0 as rank from (${datedShared({
    account: spec.account, arms: [arm], where: spec.where, months: spec.months, dir: spec.dir,
    ...(spec.after ? { after: spec.after } : {}), ...(spec.gate ? { gate: spec.gate } : {}),
  })}) x order by ${order} limit ${sql.raw(String(spec.k))})`;
}
