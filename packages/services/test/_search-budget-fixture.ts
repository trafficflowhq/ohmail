import { expect } from "vitest";
import postgres from "postgres";
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { mailboxes } from "@trafficflow/db";
import type { schema } from "@trafficflow/db/cloud";
import { brandDialect } from "@trafficflow/db/dialect";
import { throwawayDb } from "@trafficflow/db/testing";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";

/**
 * THE SEARCH BUDGET'S MAILBOXES AND RECORDER, shared by `search-budget.pg` (the first page warm, in
 * milliseconds) and `search-budget-cold.pg` (the blocks a cold first page reads): the same seeded
 * mailboxes, every statement the service sends, and the plans Postgres ran them by.
 */
export type BudgetHandle = PostgresJsDatabase<typeof schema>;

/* THE SAME MAILBOXES EVERY RUN. They were drawn with random() and random ids, so each run measured
   the budget over a different mailbox: one common-class page read 12,657 shared buffers on one
   seed and 31,669 on the next, and on the slowest CI runners a heavy draw read 129-134 ms where the
   rest of that run's figures matched every green run. Ids, account ids and every word are now
   derived from md5 of a salt, the message's index and the word's position, so a run measures what
   the last one did whatever order Postgres evaluates the rows in. */
export const D = "5eed0000-0000-4000-8000-00000000000d";
export const NOISE = "5eed0000-0000-4000-8000-00000000000e";
/**
 * D's salt: the HEAVIEST of the seeds sampled, by the shared buffers its common-class pages read
 * (the class's p95 over seven queries is its heaviest one), so the budget is held over a heavy
 * mailbox rather than a lucky draw. Sampled on 2026-10-17 over twelve salts budget-d-s01..s12, each
 * on a database made from empty, reading each common query's page with EXPLAIN (ANALYZE, BUFFERS):
 * the heaviest query read 25,348 to 32,069 shared buffers by salt, and s04 is the 32,069 (gijubadale;
 * fehora 25,385, gileledatu 22,112, letumitu 19,589, sovejuso 17,120, portal 7,642, axa 3,855).
 * If this mailbox reads over the budget on a runner, that is search over budget on a heavy mailbox:
 * a product row with the plan, never a looser bound.
 */
export const D_SALT = "budget-d-s04";
export const NOISE_SALT = "budget-noise";
/** A uniform draw in [0, 1) from md5 of (salt, message index, position): deterministic and order-free. */
export const draw = (salt: string, g: SQL, i: SQL): SQL =>
  sql`((('x' || substr(md5(${salt} || ':' || ${g} || ':' || ${i}), 1, 8))::bit(32)::bigint)::float8 / 4294967296.0)`;
/** A message id from md5 of its account and index. */
export const idOf = (acct: string, g: SQL): SQL => sql`md5('budget-id:' || ${acct} || ':' || ${g})::uuid`;

/**
 * Every statement the service sends into `into` — on the handle and inside any transaction it opens,
 * where the page runs — so a test can ask Postgres how it ran them under the same session settings.
 */
export function recording<T extends object>(target: T, into: SQL[]): T {
  return new Proxy(target, {
    get(t, p, r) {
      if (p === "execute") return (st: SQL) => { into.push(st); return (t as { execute: (s: SQL) => unknown }).execute(st); };
      if (p === "select") return (...a: unknown[]) => recorded((t as { select: (...x: unknown[]) => object }).select(...a), into);
      if (p === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          (t as { transaction: (f: (tx: object) => Promise<unknown>) => Promise<unknown> }).transaction((tx) => fn(recording(tx, into)));
      }
      return Reflect.get(t, p, r);
    },
  });
}

/**
 * A query builder whose statement is recorded when it runs: a search page's rows and their DTOs
 * are ONE builder read, so a recorder that saw only `execute` would miss the statement it guards.
 */
function recorded<B extends object>(b: B, seen: SQL[]): B {
  return new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "then" && typeof v === "function") {
        seen.push((t as unknown as { getSQL: () => SQL }).getSQL());
        return (v as (...x: unknown[]) => unknown).bind(t);
      }
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const out = (v as (...x: unknown[]) => unknown).apply(t, a);
        return out !== null && typeof out === "object" && ("from" in out || "getSQL" in out) ? recorded(out, seen) : out;
      };
    },
  });
}

const dialect = new PgDialect();
/** A statement's text as Postgres receives it. */
export const textOf = (st: SQL): string => dialect.sqlToQuery(st).sql;
export const isSession = (st: SQL): boolean => textOf(st).includes("set_config");
/** The service's own planner estimate is an EXPLAIN already; it is not a read to plan. */
export const isExplain = (st: SQL): boolean => /^\s*explain\b/i.test(textOf(st));

export type PlanNode = Record<string, unknown>;
/** Every node of a statement's plan, as it ran (or, `analyze: false`, as planned), under the session settings. */
export async function planNodes(st: SQL, session: SQL[], h: BudgetHandle, analyze = true): Promise<PlanNode[]> {
  const r = (await h.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(analyze ? sql`explain (analyze, format json) ${st}` : sql`explain (format json) ${st}`);
  })) as unknown as Array<Record<string, unknown>>;
  const out: PlanNode[] = [];
  const walk = (p: PlanNode) => {
    out.push(p);
    for (const c of (p["Plans"] as PlanNode[] | undefined) ?? []) walk(c);
  };
  walk(((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode);
  return out;
}

/**
 * The blocks `page` reads from outside the cache: run once under its session on a fresh copy of the database at
 * `url` (`CREATE DATABASE ... TEMPLATE`: a new database has none of its blocks in the cache), dropped after. Nothing
 * may be connected to that database while it is copied.
 */
export async function coldReads(url: string, page: SQL, session: SQL[]): Promise<number> {
  const copy = throwawayDb("search_cold_cell");
  const admin = postgres(Object.assign(new URL(url), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => { /* quiet */ } });
  try {
    await admin`set statement_timeout = 0`;
    await admin.unsafe(`CREATE DATABASE "${copy.name}" TEMPLATE "${new URL(url).pathname.slice(1)}" STRATEGY FILE_COPY`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  try {
    const cold = postgres(copy.url, { max: 1, connection: { max_parallel_workers_per_gather: 0 } });
    try {
      const r = (await brandDialect(drizzle(cold), "pg").transaction(async (tx) => {
        for (const s of session) await tx.execute(s);
        return tx.execute(sql`explain (analyze, buffers, format json) ${page}`);
      })) as unknown as Array<Record<string, unknown>>;
      return Number((((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode)["Shared Read Blocks"] ?? 0);
    } finally {
      await cold.end({ timeout: 5 });
    }
  } finally {
    await copy.drop();
  }
}

/**
 * The seeded tables' autovacuum, off from before the first row is seeded until the seed's own vacuum, then back on: at
 * work while the matrix is planted, it held back the page cleanup the plant's updates rely on, and the documents
 * updated meanwhile were written at the table's end instead of beside their old versions. So one layout's 1,500
 * documents lay in 118 pages one run and in 837 the next, and a page's cold reads moved by 700 blocks between two
 * runs of the same code (the base's as well).
 */
export async function autovacuum(h: BudgetHandle, on: boolean): Promise<void> {
  for (const t of ["messages", "message_bodies", "message_search", "folder_state", "attachments"]) {
    await h.execute(sql.raw(on ? `alter table ${t} reset (autovacuum_enabled)` : `alter table ${t} set (autovacuum_enabled = off)`));
  }
}

/**
 * A mailbox as production holds it: a pseudo-word vocabulary (word k is 3-5 syllables from
 * md5, so words share trigrams the way a language does and the typo tier has real candidates),
 * skewed k = floor(5000 · u⁴); planted rare words; file names on about two letters in five, as
 * mail carries them (signature images, dated invoices, scans, phone photos, joined words, reports,
 * camel-case sheets). A letter with no file name gets its document as `searchDocumentOf` writes it
 * for a sender and no recipients; one with a file name gets the writer's own, through the backfill,
 * which writes the marker. `lead` starts every subject.
 */
export async function seedDocumented(h: BudgetHandle, acct: string, n: number, salt: string, lead = ""): Promise<void> {
  const [mb] = await h.insert(mailboxes).values({ accountId: acct, provider: "imap", address: `${acct.slice(0, 8)}@tf.example` }).returning();
  await h.execute(sql`create temp table if not exists vocab as
    select k, (select string_agg((array['ba','ke','ri','so','tu','na','le','mi','po','da','fe','gi','ho','ju','ra','ve'])[(get_byte(decode(md5('v' || k), 'hex'), i) % 16) + 1], '' order by i)
               from generate_series(0, 2 + k % 3) i) as w
    from generate_series(0, 4999) k`);
  const words = (g: SQL, part: string, count: SQL) => sql`(select string_agg(v.w, ' ' order by r.i) from (select i, floor(5000 * power(${draw(salt, g, sql`${part} || i`)}, 4))::int as k from generate_series(1, ${count}) i) r join vocab v using (k))`;
  await h.execute(sql`
    insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
    select ${idOf(acct, sql`g`)}, ${acct}::uuid, ${mb!.id}::uuid, 'h', 'budget:' || ${acct} || ':' || g,
      ${lead} || case when g % 200 = 0 then 'myAXA Portal ' || (g % 97) when g % 4933 = 3 then 'heron sighting ' || g
           else ${words(sql`g`, "s", sql`3 + (g % 4)`)} end,
      case when g % 8222 = 1 then 'news@dunlin.example' when g % 333 = 0 then 'news@axa.example'
           else 'sender' || (g % 2000) || '@dom' || (g % 300) || '.example' end,
      timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g * 97), g % 3 = 0, g % 10 = 0,
      jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
    from generate_series(1, ${n}) g`);
  // Planted: kestrel 1, osprey 4, plover 12, egret 24, avocet 37 bodies.
  await h.execute(sql`
    insert into message_bodies (message_id, text)
    select m.id, ${words(sql`x.g`, "b", sql`100 + (hashtext(x.g::text) & 127)`)}
      || case when x.g = 31337 then ' kestrel' else '' end || case when x.g % 18500 = 17 then ' osprey' else '' end
      || case when x.g % 6166 = 11 then ' plover' else '' end || case when x.g % 3083 = 7 then ' egret' else '' end
      || case when x.g % 2000 = 13 then ' avocet' else '' end
    from messages m cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x where m.account_id = ${acct}::uuid`);
  await h.execute(sql`
    insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${acct}::uuid`);
  await h.execute(sql`
    insert into attachments (account_id, message_id, filename, content_type)
    select m.account_id, m.id, f.name, 'application/octet-stream'
    from messages m
    cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x
    join vocab v1 on v1.k = (x.g * 7) % 5000
    join vocab v2 on v2.k = (x.g * 13 + 1) % 5000
    cross join lateral (values
      (case when x.g % 5 = 0 then 'image001.png' end),
      (case when x.g % 10 = 0 then 'image002.jpg' end),
      (case when x.g % 12 = 1 then 'Invoice_' || (2024 + x.g % 3) || '-' || lpad(((x.g % 12) + 1)::text, 2, '0') || '-' || lpad(((x.g % 28) + 1)::text, 2, '0') || '.pdf' end),
      (case when x.g % 25 = 2 then 'scan' || lpad((x.g % 10000)::text, 4, '0') || '.PDF' end),
      (case when x.g % 33 = 3 then 'IMG_' || (20240101 + x.g % 1000) || '_' || lpad((x.g % 2400)::text, 4, '0') || '.jpg' end),
      (case when x.g % 50 = 4 then v1.w || '-' || v2.w || '-' || (x.g % 10000) || '.pdf' end),
      (case when x.g % 100 = 5 then 'Report Q' || (1 + x.g % 4) || ' ' || (2024 + x.g % 3) || '.docx' end),
      (case when x.g % 100 = 6 then initcap(v1.w) || initcap(v2.w) || (x.g % 100) || '.xlsx' end)
    ) f(name)
    where f.name is not null and m.account_id = ${acct}::uuid`);
  await h.execute(sql`
    insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
    select m.id, m.account_id,
      setweight(to_tsvector('english', coalesce(m.subject, '')), 'A')
        || setweight(to_tsvector('simple', m.from_address || ' ' || regexp_replace(m.from_address, '[@.+_-]+', ' ', 'g')), 'B'),
      to_tsvector('english', b.text), left(lower(trim(coalesce(m.subject, '') || ' ' || m.from_address)), 2048), 'text'
    from messages m join message_bodies b on b.message_id = m.id
    where m.account_id = ${acct}::uuid and not exists (select 1 from attachments a where a.account_id = m.account_id and a.message_id = m.id)`);
  const filled = await searchIndexBackfillPass({ db: h as never, accountId: acct, batch: 2_000, rounds: 1_000 });
  expect(filled.marked).toBe(true);
}

/** Word `k` of the documented mailboxes' vocabulary. */
export async function vocabWord(k: number, h: BudgetHandle): Promise<string> {
  const [row] = (await h.execute(sql`select (select string_agg((array['ba','ke','ri','so','tu','na','le','mi','po','da','fe','gi','ho','ju','ra','ve'])[(get_byte(decode(md5('v' || ${k}::int), 'hex'), i) % 16) + 1], '' order by i)
    from generate_series(0, 2 + ${k}::int % 3) i) as w`)) as unknown as Array<{ w: string }>;
  return row!.w;
}

/**
 * THE SHAPE MATRIX: six shapes of query (a whole word, a part of one, a typo with many guesses, a word
 * beside a common excluded word and beside a rare one, a pair of whole words), each over members spread
 * through the mailbox and over members that are its oldest letters, under no filter and under each filter.
 * A change that answered one shape faster had made another slower four times, so every change to the page
 * is read over all of it. Each distribution plants a body word and a subject word in 1,500 to 2,400 letters; the
 * words share no trigram with the harness's other queries, so their answers and guesses are unchanged.
 */
export const MATRIX_MEMBERS = 1_500;
export const MATRIX_DISTRIBUTIONS = {
  /** The oldest 1,500 letters. */
  old: { word: "vexbolt", subject: "marlinquest", typo: "marlnquest" },
  /** One letter in n / 1,500, newest to oldest, a step that shares no factor with the filters' 3, 10 and 100. */
  spread: { word: "dwyfrin", subject: "corvidtrail", typo: "corvdtrail" },
  /**
   * The oldest 1,500 letters, three of them deleted ({@link MATRIX_DELETED}): a letter deleted into Trash keeps its
   * search document until the server expunges it, so the set holds members no History walk meets.
   */
  deleted: { word: "qorvanel", subject: "zephyrkoln", typo: "zephrkoln" },
  /** As `spread`, but none among the newest 1,300 letters: absent from the newest bound, present just past it. */
  gap: { word: "brunthal", subject: "wyczolbrant", typo: "wyczolbrnt" },
  /** The oldest 1,499 letters and one among the newest 200. */
  burst: { word: "lindqvar", subject: "tormelind", typo: "tormelnd" },
  /** One word in the bodies of 100 of the newest 2,000 letters and in the subjects of the oldest 1,500. */
  mix: { word: "valtorin", subject: "valtorin", typo: "valtrin" },
  /**
   * Eight of the newest 1,200 letters and 1,492 old ones, a run that ends 22,508 letters from the oldest: the newest
   * letters' rate spreads the members through the whole mailbox, and the oldest 1,200 hold none.
   */
  lateblock: { word: "quillmarsh", subject: "fenwickrow", typo: "fenwckrow" },
  /** None of the newest letters, 14 of the oldest 1,200 and 1,453 of the 27,600 before them, one in 19. */
  oldthin: { word: "orvelstane", subject: "gratchwode", typo: "gratchwde" },
  /** One in 25 of the newest 60,000 letters (2,400), none older: a steady rate in recent mail, none in the oldest. */
  recent: { word: "pelmatora", subject: "trevanokil", typo: "trevankil" },
  /** One in 100 of the newest 200,000 letters (2,000) on the large mailbox, one in 40 of the newest 60,000 on 74,000 (1,500). */
  recentthin: { word: "skavendrol", subject: "mirquatesh", typo: "mirqatesh" },
  /** Five of the oldest 200 letters and 1,495 every fourth letter from the 3,601st newest: none between those and the oldest. */
  oldtail: { word: "glimcrusk", subject: "thornqwavel", typo: "thornqwvel" },
  /** Two of the 2,400 letters after the newest 1,200, 30 of the oldest 1,200 and 1,440 every 20th of the 28,800 before them. */
  behindfar: { word: "plyxwarden", subject: "crombelvix", typo: "crombelvx" },
  /** Eight of the newest 1,200 letters, none of the 2,400 after them or of the oldest 1,200, about 1,500 spread between. */
  sampled: { word: "zundrapike", subject: "hexfallowen", typo: "hexfalowen" },
  /** 20 of the newest 1,200 letters, two of the 2,400 after them, about 1,500 every 26th of the 38,800 before the oldest 1,200. */
  newestfar: { word: "smorvathil", subject: "plinquordex", typo: "plinqordex" },
} as const;
export type MatrixDistribution = keyof typeof MATRIX_DISTRIBUTIONS;
/** Every filter is read for these; the others (members laid out to mislead a set read) unfiltered alone, as only it reads sets. */
const MATRIX_FILTERED: ReadonlySet<MatrixDistribution> = new Set(["old", "spread"]);
/** The deleted letters, by their place from the oldest (`n - g`): members of `old`, `deleted` and `burst`. */
export const MATRIX_DELETED = [100, 700, 1_400] as const;
type MatrixWords = (typeof MATRIX_DISTRIBUTIONS)[MatrixDistribution];
/** Each shape's query; `{k}` is a vocabulary word, as the harness spells its queries. */
export const MATRIX_SHAPES = {
  plain: (w: MatrixWords) => w.word,
  part: (w: MatrixWords) => w.word.slice(0, -1),
  typo: (w: MatrixWords) => w.typo,
  beside: (w: MatrixWords) => `${w.word} -{1}`,
  besiderare: (w: MatrixWords) => `${w.word} -{3000}`,
  pair: (w: MatrixWords) => `${w.word} {0}`,
} as const;
export type MatrixShape = keyof typeof MATRIX_SHAPES;
export interface MatrixFilters { folder?: string; sender?: string; unread?: boolean; hasAttachments?: boolean; dateTo?: string }
/** The filters, a sender with one of the oldest letters among its own (one letter in 6,000). */
export function matrixFilters(n: number): Record<string, MatrixFilters> {
  const c = (n - MATRIX_MEMBERS / 2) % 6_000;
  return {
    none: {}, sender: { sender: `sender${c % 2_000}@dom${c % 300}.example` }, folder: { folder: "Archive" },
    unread: { unread: true }, attachments: { hasAttachments: true }, dateTo: { dateTo: "2025-06-01T00:00:00Z" },
  };
}
/**
 * COMMON WORDS UNDER A FOLDER, where the planted words are rare: a word in about three letters in four, a pair with the
 * most common word, the most common word beside the next, and a typo of the first (`gijubadale`, word 5, one letter
 * left out), each under {@link MATRIX_FOLDERS}.
 */
export const MATRIX_COMMON: Readonly<Partial<Record<MatrixShape, string>>> = { plain: "{5}", pair: "{5} {0}", beside: "{0} -{1}", typo: "gijubdale" };
/**
 * Archive, one letter in 100; Old, none of the newest 3,000 letters and every second one after them (sparse where a
 * walk starts, half the mailbox past it); INBOX, the rest.
 */
export const MATRIX_FOLDERS = ["Archive", "Old", "INBOX"] as const;
export interface MatrixCell { shape: MatrixShape; dist: MatrixDistribution | "common"; filter: string; of: string; filters: MatrixFilters; label: string }
export function matrixCells(n: number): MatrixCell[] {
  const filters = matrixFilters(n);
  const common = Object.entries(MATRIX_COMMON).flatMap(([shape, of]) => MATRIX_FOLDERS.map((folder) => ({
    shape: shape as MatrixShape, dist: "common" as const, filter: folder, of: of!, filters: { folder }, label: `${shape} common ${folder}`,
  })));
  return [...(Object.keys(MATRIX_SHAPES) as MatrixShape[]).flatMap((shape) => (Object.keys(MATRIX_DISTRIBUTIONS) as MatrixDistribution[])
    .flatMap((dist) => Object.entries(filters).filter(([filter]) => filter === "none" || MATRIX_FILTERED.has(dist)).map(([filter, f]) => ({
      shape, dist, filter, of: MATRIX_SHAPES[shape](MATRIX_DISTRIBUTIONS[dist]), filters: f, label: `${shape} ${dist} ${filter}`,
    })))), ...common];
}
const matrixStep = (n: number): number => {
  let s = Math.floor(n / MATRIX_MEMBERS);
  while (s % 2 === 0 || s % 3 === 0 || s % 5 === 0) s--;
  return s;
};

/** What one cell's page statement did, read from its own plan as it ran. */
export interface MatrixWork {
  /** Shared buffers, hit or read. */
  buffers: number;
  /** History letters read: rows of `messages_account_msg_order_idx`, the filtered out among them. */
  history: number;
  /** Of those, the ones the set reads' walks read (`su`, `sw`, `sr`: search-service.ts `setRead`), probes and the base's own reads left out. */
  walks: number;
  /** Letters looked up one at a time by id: each member dated, and each row shown. */
  lookups: number;
  /** Passes over the folder table: a read of half its rows or more, every account's. */
  folderPasses: number;
  /** Rows of the folder table read, a letter asked by its key one. */
  folderRows: number;
  /** The typo arm's guesses read off the trigram index, and in how many reads. */
  guesses: number;
  guessReads: number;
  /** `messages` or `message_bodies` read by a sequential scan. */
  scans: string[];
  /** Blocks written to temporary files: rows kept past the memory a statement may use. */
  temp: number;
}

/**
 * UNDER A FOLDER no page reads the folder table whole. The planted words have at most 2,000 matches a word, so each is
 * read off its index, every match asked its folder by key before its letter is read, and no History is walked: a folder
 * row for each match a branch reads, and for each of its letters in the folder (at most 3,200). The typo arm, and a
 * rare word beside a common excluded word (whose exact tier is empty), ask the folder's newest 200 letters first: in
 * Archive, one letter in 100, 20,000 History letters and a folder row each. Joined to the folder table, a page had
 * read it whole for each read of the folder's newest letters (four beside an excluded word, 0.8-1.3 s on 240,000
 * letters), or walked 20,000 to 40,000 letters for them.
 */
export const matrixFolderBounds = (): MatrixBounds => Object.fromEntries((Object.keys(MATRIX_SHAPES) as MatrixShape[])
  .flatMap((shape) => [...MATRIX_FILTERED].map((dist) => [`${shape} ${dist} folder`, shape === "typo" || shape === "beside"
    ? { folderPasses: 0, history: 20_000, folderRows: 21_600 } : { folderPasses: 0, history: 0, folderRows: 3_200 }])));

/** The most of each kind of work a cell may do, by its label. */
export type MatrixBounds = Readonly<Record<string, Partial<Record<"buffers" | "history" | "walks" | "lookups" | "folderPasses" | "folderRows" | "guesses", number>>>>;
/**
 * The History an unfiltered page of the shape reads besides its set reads' walks, to the hundred above: each arm's
 * newest letters, its probes, the letters after the newest a probe asks and the oldest with as many before them (5,440,
 * 11,020 to 13,420 where both the text and the part arm read sets, and 12,020).
 */
export const MATRIX_REST = { typo: 5_500, beside: 13_500, besiderare: 12_100 } as const;
/** A set read's walk newest first as it is chosen (search-service.ts `setRead`): twice the letters its estimate assumed, never past 140 a member. */
export const matrixWalk = (estimate: number, members: number): number => Math.min(2 * estimate, 140 * members);
/** Its walk oldest first: the oldest window, which the probe read, and twice the letters assumed past it, never past 140 a member. */
export const matrixOldest = (estimate: number, window: number, members: number): number =>
  Math.min(estimate <= window ? window : window + 2 * (estimate - window), 140 * members);
/** Its walk of History whole newest first, where the account holds at most 60 letters a member: never past 60 a member. */
export const matrixWhole = (members: number): number => 60 * members;

/** The cell's work over its bounds, one line each. */
export function matrixOver(label: string, work: MatrixWork, bounds: MatrixBounds): string[] {
  return Object.entries(bounds[label] ?? {}).flatMap(([k, most]) => {
    const did = work[k as keyof MatrixBounds[string]];
    return did > most! ? [`${label} ${k} ${did} of ${most}`] : [];
  });
}

/** {@link MatrixWork} of `page` under its `session`, the folder table holding `folderRows`. */
export async function matrixWork(page: SQL, session: SQL[], h: BudgetHandle, folderRows: number): Promise<MatrixWork> {
  const r = (await h.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(sql`explain (analyze, buffers, format json) ${page}`);
  })) as unknown as Array<Record<string, unknown>>;
  const top = ((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode;
  const nodes: PlanNode[] = [];
  const walkNodes = new Set<PlanNode>();
  const walk = (p: PlanNode, inWalk: boolean): void => {
    const set = inWalk || ["CTE su", "CTE sw", "CTE sr"].includes(String(p["Subplan Name"] ?? ""));
    nodes.push(p);
    if (set) walkNodes.add(p);
    for (const ch of (p["Plans"] as PlanNode[] | undefined) ?? []) walk(ch, set);
  };
  walk(top, false);
  const loops = (p: PlanNode): number => Number(p["Actual Loops"] ?? 0);
  const rows = (p: PlanNode): number => (Number(p["Actual Rows"] ?? 0) + Number(p["Rows Removed by Filter"] ?? 0)) * loops(p);
  const guesses = nodes.filter((p) => p["Index Name"] === "message_search_terms_trgm_idx");
  const history = nodes.filter((p) => p["Index Name"] === "messages_account_msg_order_idx");
  return {
    buffers: Number(top["Shared Hit Blocks"] ?? 0) + Number(top["Shared Read Blocks"] ?? 0),
    history: history.reduce((n, p) => n + rows(p), 0),
    walks: history.filter((p) => walkNodes.has(p)).reduce((n, p) => n + rows(p), 0),
    lookups: nodes.filter((p) => p["Index Name"] === "messages_pkey" || p["Index Name"] === "messages_id_account_uq").reduce((n, p) => n + loops(p), 0),
    folderPasses: nodes.filter((p) => p["Relation Name"] === "folder_state" && rows(p) >= folderRows / 2).length,
    folderRows: nodes.filter((p) => p["Relation Name"] === "folder_state").reduce((n, p) => n + rows(p), 0),
    guesses: guesses.reduce((n, p) => n + Number(p["Actual Rows"] ?? 0) * loops(p), 0),
    guessReads: guesses.length,
    scans: nodes.filter((p) => p["Node Type"] === "Seq Scan" && ["messages", "message_bodies"].includes(String(p["Relation Name"])))
      .map((p) => String(p["Relation Name"])),
    temp: Number(top["Temp Written Blocks"] ?? 0),
  };
}

/**
 * Plants the matrix's words in `acct`'s documents (before the word index is built and the tables are
 * vacuumed), deletes {@link MATRIX_DELETED} (their documents kept), and files the letters in {@link MATRIX_FOLDERS}.
 */
export async function plantMatrix(h: BudgetHandle, acct: string, n: number): Promise<void> {
  const g = sql`split_part(m.dedup_key, ':', 3)::int`;
  const body = (members: SQL, word: string) => h.execute(sql`
    update message_search s set text_tsv = s.text_tsv || to_tsvector('english', ${word})
    from messages m where m.id = s.message_id and m.account_id = ${acct}::uuid and ${members}`);
  const subject = (members: SQL, word: string) => h.execute(sql`
    update message_search s set head_tsv = s.head_tsv || setweight(to_tsvector('english', ${word}), 'A'), terms = left(${word} || ' ' || s.terms, 2048)
    from messages m where m.id = s.message_id and m.account_id = ${acct}::uuid and ${members}`);
  const plant = async (members: SQL, w: MatrixWords) => { await body(members, w.word); await subject(members, w.subject); };
  const oldest = sql`${g} > ${n - MATRIX_MEMBERS}`;
  await plant(oldest, MATRIX_DISTRIBUTIONS.old);
  await plant(sql`${g} % ${matrixStep(n)} = 11`, MATRIX_DISTRIBUTIONS.spread);
  await plant(oldest, MATRIX_DISTRIBUTIONS.deleted);
  await plant(sql`${g} % ${matrixStep(n)} = 23 and ${g} > 1300`, MATRIX_DISTRIBUTIONS.gap);
  await plant(sql`(${g} > ${n - MATRIX_MEMBERS + 1} or ${g} = 50)`, MATRIX_DISTRIBUTIONS.burst);
  await body(sql`${g} <= 2000 and ${g} % 20 = 3`, MATRIX_DISTRIBUTIONS.mix.word);
  await subject(oldest, MATRIX_DISTRIBUTIONS.mix.subject);
  await plant(sql`(${g} in (100, 250, 400, 550, 700, 850, 1000, 1150) or ${g} between ${n - 23_999} and ${n - 22_508})`,
    MATRIX_DISTRIBUTIONS.lateblock);
  await plant(sql`((${g} > ${n - 1_200} and (${g} - ${n - 1_200}) % 92 = 1) or (${g} > ${n - 28_800} and ${g} <= ${n - 1_200} and (${g} - ${n - 28_800}) % 19 = 1))`,
    MATRIX_DISTRIBUTIONS.oldthin);
  await plant(sql`${g} <= 60000 and ${g} % 25 = 7`, MATRIX_DISTRIBUTIONS.recent);
  await plant(n >= 200_000 ? sql`${g} <= 200000 and ${g} % 100 = 37` : sql`${g} <= 60000 and ${g} % 40 = 37`, MATRIX_DISTRIBUTIONS.recentthin);
  await plant(sql`(${g} in (${n - 10}, ${n - 50}, ${n - 100}, ${n - 150}, ${n - 190}) or (${g} >= 3601 and ${g} <= ${3601 + 4 * 1_494} and (${g} - 3601) % 4 = 0))`,
    MATRIX_DISTRIBUTIONS.oldtail);
  await plant(sql`(${g} in (2000, 3000) or (${g} > ${n - 1_200} and (${n} - ${g}) % 40 = 5) or (${g} >= ${n - 30_000} and ${g} <= ${n - 1_201} and (${n - 1_201} - ${g}) % 20 = 0))`,
    MATRIX_DISTRIBUTIONS.behindfar);
  await plant(sql`(${g} in (100, 250, 400, 550, 700, 850, 1000, 1150) or (${g} >= 3601 and ${g} <= ${n - 1_201} and (${g} - 3601) % ${Math.floor((n - 4_802) / 1_492)} = 0))`,
    MATRIX_DISTRIBUTIONS.sampled);
  await plant(sql`((${g} <= 1200 and ${g} % 60 = 30) or ${g} in (2000, 3000) or (${g} >= ${n - 40_000} and ${g} <= ${n - 1_201} and (${n - 1_201} - ${g}) % 26 = 0))`,
    MATRIX_DISTRIBUTIONS.newestfar);
  await h.execute(sql`update messages m set deleted_at = timestamptz '2026-09-20T00:00:00Z'
    where m.account_id = ${acct}::uuid and ${g} in (${sql.join(MATRIX_DELETED.map((d) => sql`${n - d}`), sql`, `)})`);
  await h.execute(sql`update folder_state f set desired_folder = 'Archive'
    from messages m where m.id = f.message_id and m.account_id = ${acct}::uuid and ${g} % 100 = 7`);
  await h.execute(sql`update folder_state f set desired_folder = 'Old'
    from messages m where m.id = f.message_id and m.account_id = ${acct}::uuid and ${g} > 3000 and ${g} % 2 = 0`);
}
