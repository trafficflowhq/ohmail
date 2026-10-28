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
import { type LockMode, assertComparable, assertDistinct, assertJsonKey, type Dialect, type LockOptions, type SearchArm, type SearchCorpus, type SearchDocumentParts, type UnindexedMailArms, type MailWordArms, PART_PREFIX_MIN_CHARS, eszettForms, partOperandsOf, partWordTails, partWordsOf, typoTrigramsOf, queryOperandsOf, straddlesParts, type QueryOperands, type QueryOperand } from "./index.js";

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
function partTsquery(q: string): SQL | null {
  const groups = partGroups(q);
  return groups === null ? null : sql.raw(andTsquery(groups));
}

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
function partLetter(q: string, head: SQL, text: SQL): SQL | null {
  const ops = partOperandsOf(q);
  const groups = partGroups(q);
  if (ops === null || groups === null) return null;
  return sql`(${sql.join(ops.map((op) => {
    const t = sql.raw(andTsquery(op.map((i) => groups[i]!)));
    return sql`(${head} @@ ${t} or ${text} @@ ${t})`;
  }), sql` and `)})`;
}

/** One operand anywhere in the letter: in `head` or in `text`, every ß/ss form unless excluded. */
function inLetter(o: QueryOperand, head: SQL, text: SQL, fold: boolean): SQL {
  const typed = o.quoted ? `"${o.text}"` : o.text;
  const t = fold ? foldedTsquery(typed) : sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${typed})`;
  return sql`(${head} @@ ${t} or ${text} @@ ${t})`;
}

/** No excluded operand anywhere in the letter; undefined when nothing is excluded. */
function noneOf(ops: QueryOperands, head: SQL, text: SQL): SQL | undefined {
  return ops.none.length === 0 ? undefined
    : sql`(${sql.join(ops.none.map((o) => sql`not ${inLetter(o, head, text, false)}`), sql` and `)})`;
}

/**
 * The query over the whole letter, read once a query straddles its parts ({@link straddlesParts}):
 * every operand of a group in `head` or `text`. `head` keeps its own rank but is held to the letter,
 * so no arm admits a letter this reading refuses; no excluded operand in either is `excluded`, for
 * the caller to hold every arm to.
 */
function acrossOf(q: string, head: SearchArm, headTsv: SQL, textTsv: SQL, recency: SQL, tsq: SQL): MailWordArms | null {
  const ops = queryOperandsOf(q);
  if (!straddlesParts(ops)) return null;
  const groups = ops.any.map((g) => sql`(${sql.join(g.map((o) => inLetter(o, headTsv, textTsv, true)), sql` and `)})`);
  const none = noneOf(ops, headTsv, textTsv);
  const letter = groups.length === 0 ? sql`true` : sql`(${sql.join(groups, sql` or `)})`;
  // Each group with every excluded operand as one tsquery, which the text GIN answers whole: one
  // group is the typed query itself; of several, `websearch_to_tsquery` would hold only the last
  // group to an exclusion, so each is typed again with them.
  const typed = (o: QueryOperand): string => (o.quoted ? `"${o.text}"` : o.text);
  const noHead = ops.none.map((o) => sql`not ${headTsv} @@ websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${typed(o)})`);
  const alone = none ? ops.any.map((g, i) => {
    const t = ops.any.length === 1 ? tsq : foldedTsquery([...g.map(typed), ...ops.none.map((o) => `-${typed(o)}`)].join(" "));
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
function letterTermsOf(q: string): SQL[] | null {
  const ops = queryOperandsOf(q);
  if (ops.none.length > 0 || ops.any.length === 0) return null;
  const terms: SQL[] = [];
  for (const g of ops.any) {
    if (g.length > LETTER_TERMS_MAX || g.some((o) => o.quoted)) return null;
    // The same tsquery per operand as `inLetter(o, …, true)`.
    const t = g.map((o) => foldedTsquery(o.text));
    for (let mask = 0; mask < 1 << g.length; mask++) {
      const head = t.filter((_, i) => (mask & (1 << i)) !== 0);
      const text = t.filter((_, i) => (mask & (1 << i)) === 0);
      const parts = [
        ...(head.length > 0 ? [sql`s.head_tsv @@ (${sql.join(head, sql` && `)})`] : []),
        ...(text.length > 0 ? [sql`s.text_tsv @@ (${sql.join(text, sql` && `)})`] : []),
      ];
      terms.push(sql`(${sql.join(parts, sql` and `)})`);
    }
  }
  return terms;
}

/** The typed query as a tsquery, every ß/ss form of it OR-ed (`eszettForms`); one form is the old shape. */
function foldedTsquery(q: string): SQL {
  const forms = eszettForms(q);
  return forms.length === 1 ? sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${q})`
    : sql`(${sql.join(forms.map((f) => sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${f})`), sql` || `)})`;
}

/** `col ilike '%q%'` for every ß/ss form of `q`; one form is the old single predicate. */
function likeAny(col: SQL, q: string): SQL {
  const forms = eszettForms(q);
  return forms.length === 1 ? sql`${col} ilike ${`%${q}%`}`
    : sql`(${sql.join(forms.map((f) => sql`${col} ilike ${`%${f}%`}`), sql` or `)})`;
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
      words: (q: string): MailWordArms => {
        const tsq = foldedTsquery(q);
        const head = { pred: sql`s.head_tsv @@ ${tsq}`, rank: sql`ts_rank_cd(s.head_tsv, ${tsq})` };
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        return acrossOf(q, head, sql`s.head_tsv`, sql`s.text_tsv`, recency, tsq)
          ?? { head, text: { pred: sql`s.text_tsv @@ ${tsq}`, rank: recency } };
      },
      partWords: (q: string): MailWordArms | null => {
        const tsq = partTsquery(q);
        if (tsq === null) return null;
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        const letter = partLetter(q, sql`s.head_tsv`, sql`s.text_tsv`);
        if (letter !== null) return { head: { pred: letter, rank: recency }, text: { pred: letter, rank: recency }, across: true };
        return {
          head: { pred: sql`s.head_tsv @@ ${tsq}`, rank: recency },
          text: { pred: sql`s.text_tsv @@ ${tsq}`, rank: recency },
        };
      },
      substring: (q: string, opts): SearchArm => ({
        // `message_search_terms_trgm_idx` serves the ILIKE where pg_trgm exists (search-setup.ts).
        pred: likeAny(sql`s.terms`, q),
        rank: opts.trigram ? sql`word_similarity(${q}, s.terms)` : sql`coalesce(extract(epoch from m.date), 0)`,
      }),
      unindexed: (q: string, opts): UnindexedMailArms => {
        // The pre-0125 columns, one index per branch (subject_tsv / body_tsv GINs, the two trgm
        // GINs) — never an OR, which is the shape that seq-scanned.
        const tsq = foldedTsquery(q);
        const recency = sql`coalesce(extract(epoch from m.date), 0)`;
        const sim = (col: SQL): SQL => (opts.trigram ? sql`word_similarity(${q}, ${col})` : recency);
        const part = partTsquery(q);
        const ops = queryOperandsOf(q);
        // A guess holds no excluded operand: each table's own NOT, a row without a body kept.
        const none = !straddlesParts(ops) || ops.none.length === 0 ? null : ops.none.map((o) => {
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
      estimateRows: async (db: unknown, statement: SQL): Promise<number | null> => {
        const rows = await pgDialect().exec(db, sql`explain (format json) ${statement}`);
        const cell = rows[0]?.[0];
        const plan = (typeof cell === "string" ? JSON.parse(cell) : cell) as Array<{ Plan?: { "Plan Rows"?: number } }> | undefined;
        const n = plan?.[0]?.Plan?.["Plan Rows"];
        return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
      },
      estimateRowsEach: async (db: unknown, statements: readonly SQL[]): Promise<Array<number | null>> => {
        const one = (s: SQL) => pgDialect().search.estimateRows(db, s);
        if (statements.length < 2) return Promise.all(statements.map(one));
        // One EXPLAIN: an Append keeps each branch's own estimate. Any other shape asks each apart.
        const all = sql.join(statements.map((s, i) => sql`select 1 from (${s}) ${sql.raw(`e${i}`)}`), sql` union all `);
        const rows = await pgDialect().exec(db, sql`explain (format json) ${all}`);
        const cell = rows[0]?.[0];
        type Node = { "Node Type"?: string; "Plan Rows"?: number; Plans?: Node[] };
        const top = ((typeof cell === "string" ? JSON.parse(cell) : cell) as Array<{ Plan?: Node }> | undefined)?.[0]?.Plan;
        const kids = top?.["Node Type"] === "Append" ? top.Plans ?? [] : [];
        if (kids.length !== statements.length) return Promise.all(statements.map(one));
        return kids.map((k) => (typeof k["Plan Rows"] === "number" && Number.isFinite(k["Plan Rows"]) ? Math.round(k["Plan Rows"]) : null));
      },
      withDocument: (bodyInsert: SQL, documentUpsert: SQL): SQL =>
        sql`with body as (${bodyInsert}) ${documentUpsert} returning (select count(*) from body)::int as body_rows`,
      document: (p: SearchDocumentParts) => ({
        head: sql`(setweight(to_tsvector(${TEXT_SEARCH_CONFIG}, ${p.subject}), 'A')
          || setweight(to_tsvector('simple', ${p.people}), 'B')
          || setweight(to_tsvector('simple', ${p.attachments}), 'B'))`,
        text: sql`to_tsvector(${TEXT_SEARCH_CONFIG}, ${p.body})`,
      }),
    },
  };
}
