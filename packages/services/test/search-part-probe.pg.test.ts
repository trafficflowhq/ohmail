import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes, ensureWordIndex } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A SPARSE PART OF A WORD IS NOT WALKED. The part arm walked thousands of the newest documents for a part
 * in a small share of messages, then read its index anyway: most of the page's time at the large corpus. Now
 * the newest page-cut (200) is asked first and the walk runs only where a sixth of it matches. Read
 * off the page statement's own plan: no scan of the History index returns more than a page-cut of rows for
 * the sparse part, and the dense part (the control) still walks and fills its cut. Real Postgres.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 1 });
const base = brandDialect(drizzle(client, { schema }), "pg");
const A = randomUUID();
const N = 1_500;
const NOW = new Date("2026-10-10T12:00:00Z");

const seen: SQL[] = [];
/** Every statement the service sends, the transaction's and the builders' included (`search-budget.pg`'s recorder). */
const wrap = <T extends object>(target: T): T => new Proxy(target, {
  get(t, p, r) {
    if (p === "execute") return (st: SQL) => { seen.push(st); return (t as { execute: (s: SQL) => unknown }).execute(st); };
    if (p === "select") return (...a: unknown[]) => recorded((t as { select: (...x: unknown[]) => object }).select(...a));
    if (p === "transaction") {
      return (fn: (tx: unknown) => Promise<unknown>) =>
        (t as { transaction: (f: (tx: object) => Promise<unknown>) => Promise<unknown> }).transaction((tx) => fn(wrap(tx)));
    }
    return Reflect.get(t, p, r);
  },
});
function recorded<B extends object>(b: B): B {
  return new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "then" && typeof v === "function") { seen.push((t as unknown as { getSQL: () => SQL }).getSQL()); return (v as (...x: unknown[]) => unknown).bind(t); }
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const out = (v as (...x: unknown[]) => unknown).apply(t, a);
        return out !== null && typeof out === "object" && ("from" in out || "getSQL" in out) ? recorded(out) : out;
      };
    },
  });
}
const db = wrap(base);
const ctx: ServiceContext = { db: db as never, accountId: A, userId: null, now: () => NOW, requestId: "search-part-probe" };

/** The largest row count any scan of the History index returned in the page statement's plan. */
async function deepestWalk(q: string): Promise<{ rows: number; kept: number; items: number }> {
  seen.length = 0;
  const r = await new SearchService().search(ctx, { q, parts: "page" });
  const textOf = (st: SQL): string => (base as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string } } }).dialect.sqlToQuery(st).sql;
  const page = seen.find((st) => textOf(st).includes("fused"));
  expect(page, "the page statement was not recorded").toBeDefined();
  const plan = (await base.transaction(async (tx) => {
    await tx.execute(sql`select set_config('enable_seqscan', 'off', true), set_config('jit', 'off', true)`);
    return tx.execute(sql`explain (analyze, format json) ${page!}`);
  })) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>;
  let deepest = 0;
  let kept = 0;
  const walk = (n: Record<string, unknown>): void => {
    if (n["Index Name"] === "messages_account_msg_order_idx") deepest = Math.max(deepest, Number(n["Actual Rows"]) * Number(n["Actual Loops"]));
    // What a walk kept, whichever scan of History fed it (a keyed walk's limit is a parameter).
    if (n["Subplan Name"] === "CTE pw") kept = Math.max(kept, Number(n["Actual Rows"]));
    for (const c of (n["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
  };
  walk(plan[0]!["QUERY PLAN"][0]!.Plan);
  return { rows: deepest, kept, items: r.items.length };
}

describe("the part arm asks the newest page-cut before it walks (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(base, { concurrently: false });
    await ensureHotPathIndexes(base, { concurrently: false });
    const [mb] = await base.insert(mailboxes).values({ accountId: A, provider: "imap", address: "probe@tf.example" }).returning();
    // Every message says "harbour"; one in 300 says "lighthouse" (the sparse part `lighth`).
    await base.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select ${A}::uuid, ${mb!.id}::uuid, 'h', 'probe:' || g, case when g % 300 = 7 then 'lighthouse notes ' || g else 'harbour notes ' || g end,
        's' || g || '@probe.example', ${NOW.toISOString()}::timestamptz - make_interval(mins => g), false, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(1, ${N}) g`);
    await base.execute(sql`insert into message_bodies (message_id, text) select id, subject from messages where account_id = ${A}::uuid`);
    await base.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select id, 'INBOX', 'INBOX', 'us' from messages where account_id = ${A}::uuid`);
    await base.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, setweight(to_tsvector('english', m.subject), 'A'), to_tsvector('english', m.subject), lower(m.subject), 'text'
      from messages m where m.account_id = ${A}::uuid`);
    await base.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${A}::uuid, now())`);
    await base.execute(sql`analyze messages`);
    await base.execute(sql`analyze message_search`);
  }, 120_000);

  afterAll(async () => {
    await base.execute(sql`delete from message_search where account_id = ${A}::uuid`);
    await base.execute(sql`delete from account_settings where account_id = ${A}::uuid`);
    await base.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${A}::uuid)`);
    await base.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A}::uuid)`);
    await base.execute(sql`delete from messages where account_id = ${A}::uuid`);
    await base.execute(sql`delete from mailboxes where account_id = ${A}::uuid`);
  });

  it("a sparse part: no History scan past the page-cut, and every match found", async () => {
    const r = await deepestWalk("lighth");
    expect(r.items).toBe(5);
    expect(r.rows, "the sparse part was walked past its probe").toBeLessThanOrEqual(200);
  });

  it("a dense part (the control): the walk still runs and fills the page", async () => {
    const r = await deepestWalk("harbo");
    expect(r.items).toBe(50);
    expect(r.kept).toBeGreaterThan(50);
  });
});

/**
 * THE ACCOUNT-KEYED WORD INDEX. An account (`W`) beside a neighbour with twice its mail and the same
 * words. A recency arm short of its cut reads its matches as a set off `message_search_words_idx`,
 * whose key is the account, then walks History against it or dates each member; a denser one walks
 * only as deep as the newest page-cut's rate says. Read off the page statement's own plan, under the
 * session the service set.
 */
const W = randomUUID();
const NB = randomUUID();
const WN = 20_000;
const K = 200;
const owner = new Map<string, string>();

/** Body words by the letter's index `g` (1 the newest): each word's density is the fixture's. */
const BODY = sql`'note ' || g
  || case when g % 20 <> 0 then ' alpha' else '' end
  || case when g > 3000 or g % 50 = 0 then ' oldtide' else '' end
  || case when g > 200 and g % 2 = 0 then ' grebe' else '' end
  || case when g > 19200 then ' fossil' else '' end
  || case when g % 33 = 3 then ' ribbon' else '' end
  || case when g % 7 = 2 then ' midtown' else '' end
  || case when g % 101 = 5 then ' lantern' else '' end`;

async function seedWords(acct: string, n: number): Promise<void> {
  const [mb] = await base.insert(mailboxes).values({ accountId: acct, provider: "imap", address: `${acct.slice(0, 8)}@words.example` }).returning();
  await base.execute(sql`
    insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
    select ${acct}::uuid, ${mb!.id}::uuid, 'h', 'words:' || g, 'letter ' || g, 's' || (g % 500) || '@words.example',
      ${NOW.toISOString()}::timestamptz - make_interval(mins => g), g % 4 = 0, false,
      jsonb_build_object('folder', case when g % 97 = 1 then 'Small' else 'INBOX' end, 'ref', '1:' || g)
    from generate_series(1, ${n}) g`);
  await base.execute(sql`insert into message_bodies (message_id, text)
    select m.id, ${BODY} from messages m cross join lateral (select split_part(m.dedup_key, ':', 2)::int as g) x
    where m.account_id = ${acct}::uuid`);
  await base.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select id, native_locator->>'folder', native_locator->>'folder', 'us' from messages where account_id = ${acct}::uuid`);
  await base.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
    select m.id, m.account_id, setweight(to_tsvector('english', m.subject), 'A') || setweight(to_tsvector('simple', m.from_address), 'B'),
      to_tsvector('english', b.text), lower(m.subject || ' ' || m.from_address), 'text'
    from messages m join message_bodies b on b.message_id = m.id where m.account_id = ${acct}::uuid`);
  await base.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${acct}::uuid, now())`);
  const ids = (await base.execute(sql`select id from messages where account_id = ${acct}::uuid`)) as unknown as Array<{ id: string }>;
  for (const r of ids) owner.set(r.id, acct);
}

async function removeWords(acct: string): Promise<void> {
  await base.execute(sql`delete from message_search where account_id = ${acct}::uuid`);
  await base.execute(sql`delete from account_settings where account_id = ${acct}::uuid`);
  await base.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${acct}::uuid)`);
  await base.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${acct}::uuid)`);
  await base.execute(sql`delete from messages where account_id = ${acct}::uuid`);
  await base.execute(sql`delete from mailboxes where account_id = ${acct}::uuid`);
}

type Node = Record<string, unknown>;
const textOf = (st: SQL): string => (base as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string } } }).dialect.sqlToQuery(st).sql;
const nodesOf = (n: Node): Node[] => [n, ...((n["Plans"] as Node[] | undefined) ?? []).flatMap(nodesOf)];
const rowsOf = (n: Node): number => Number(n["Actual Rows"]) * Number(n["Actual Loops"]);
/** Rows a node read: the ones it returned and the ones its filter and recheck removed. */
const readOf = (n: Node): number => (Number(n["Actual Rows"]) + Number(n["Rows Removed by Filter"] ?? 0)
  + Number(n["Rows Removed by Index Recheck"] ?? 0)) * Number(n["Actual Loops"]);

/** The page's answer, every statement it sent, and its page statement's plan under the session it set. */
/** `without`: indexes dropped for the plan only, in its own transaction, rolled back. */
async function pageOf(q: string, opts: { on?: typeof base; filters?: Record<string, unknown>; without?: string[] } = {}): Promise<{ ids: string[]; sent: string[]; nodes: Node[] }> {
  const on = opts.on ?? base;
  const handle = wrap(on);
  seen.length = 0;
  const c: ServiceContext = { ...ctx, db: handle as never, accountId: W };
  const r = await new SearchService().search(c, { q, parts: "page", ...(opts.filters ? { filters: opts.filters } : {}) });
  const sent = seen.map(textOf);
  const session = seen.filter((st) => textOf(st).includes("set_config"));
  const page = seen.find((st) => textOf(st).includes("fused"));
  expect(page, "the page statement was not recorded").toBeDefined();
  let plan: unknown;
  const undo = new Error("rolled back");
  await on.transaction(async (tx) => {
    for (const ix of opts.without ?? []) await tx.execute(sql.raw(`drop index ${ix}`));
    for (const st of session) await tx.execute(st);
    plan = await tx.execute(sql`explain (analyze, format json) ${page!}`);
    if (opts.without) throw undo;
  }).catch((e: unknown) => { if (e !== undo) throw e; });
  const [top] = plan as Array<{ "QUERY PLAN": Array<{ Plan: Node }> }>;
  return { ids: r.items.map((i) => i.id), sent, nodes: nodesOf(top!["QUERY PLAN"][0]!.Plan) };
}
const searchHeaps = (nodes: Node[]): Node[] => nodes.filter((n) => n["Node Type"] === "Bitmap Heap Scan" && n["Relation Name"] === "message_search");
/** The most letters one read of `messages` returned: a History walk, a bitmap of the account, a lookup's loops. */
const lettersRead = (nodes: Node[]): number => Math.max(0, ...nodes.filter((n) => n["Relation Name"] === "messages").map(readOf));
/** A CTE's plan and every node under it. */
const cteOf = (nodes: Node[], name: string): Set<Node> => new Set(nodes.filter((n) => n["Subplan Name"] === `CTE ${name}`).flatMap(nodesOf));
/** How many of W's letters say each word, anywhere in the letter. */
async function matchesOf(...ws: string[]): Promise<number> {
  const [r] = (await base.execute(sql`select count(*)::int as n from message_search s
    where s.account_id = ${W}::uuid and ${sql.join(ws.map((w) => sql`(s.head_tsv @@ to_tsquery('english', ${w}) or s.text_tsv @@ to_tsquery('english', ${w}))`), sql` and `)}`)) as unknown as Array<{ n: number }>;
  return r!.n;
}

describe("a recency arm reads its account's words off the keyed index (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(base, { concurrently: false });
    await ensureHotPathIndexes(base, { concurrently: false });
    await ensureWordIndex(base, { concurrently: false });
    await base.execute(sql`set statement_timeout = '600s'`);
    await seedWords(W, WN);
    await seedWords(NB, 2 * WN);
    for (const t of ["messages", "message_search", "folder_state"]) await base.execute(sql.raw(`vacuum (parallel 0, analyze) ${t}`));
    await base.execute(sql`reset statement_timeout`);
  }, 300_000);

  afterAll(async () => {
    await base.execute(sql`set statement_timeout = '600s'`);
    await removeWords(W);
    await removeWords(NB);
    await base.execute(sql`reset statement_timeout`);
  }, 300_000);

  it("a word dense in old mail and rare in new reads only the account's matches, by the index, filtering none", async () => {
    const own = await matchesOf("oldtide");
    const { ids, nodes } = await pageOf("oldtide");
    expect(ids).toHaveLength(50);
    const heaps = searchHeaps(nodes);
    for (const n of heaps) {
      expect(String(n["Filter"] ?? ""), "a document read asked its vectors one by one").not.toContain("@@");
      expect(readOf(n), "a document read read another account's letters").toBeLessThanOrEqual(own);
    }
  }, 60_000);

  it("a word in ~3% of letters is not walked for: no read of the mailbox passes four cuts", async () => {
    const { ids, nodes } = await pageOf("ribbon");
    expect(ids).toHaveLength(50);
    // Past the probe of the walk bound's last cut (`pf`), which skips to it and asks K letters there.
    const far = cteOf(nodes, "pf");
    expect(far.size, "the last cut was not asked").toBeGreaterThan(0);
    expect(lettersRead(nodes.filter((n) => !far.has(n)))).toBeLessThanOrEqual(4 * K);
    expect(lettersRead([...far])).toBeLessThanOrEqual(15 * K);
  }, 60_000);

  it("a 14% part and a two-word letter walk only to their cut, within the need, and read no whole match set", async () => {
    for (const q of ["midto", "alpha midtown"]) {
      const { ids, nodes } = await pageOf(q);
      expect(ids, q).toHaveLength(50);
      expect(lettersRead(nodes), q).toBeLessThanOrEqual(15 * K);
      for (const n of searchHeaps(nodes)) expect(rowsOf(n), `${q}: every match was read`).toBeLessThanOrEqual(K);
    }
  }, 60_000);

  it("a word missing from the newest cut and dense after it is walked for, not read as a set", async () => {
    const { ids, nodes } = await pageOf("grebe");
    expect(ids).toHaveLength(50);
    expect(lettersRead(nodes)).toBeLessThanOrEqual(15 * K);
    for (const n of nodes.filter((x) => x["Subplan Name"] === "CTE ps")) expect(rowsOf(n), "every match was read").toBeLessThanOrEqual(K);
  }, 60_000);

  it("a set whose matches are all old walks History only to its bound, then dates its members", async () => {
    const own = await matchesOf("fossil");
    expect(own).toBe(4 * K);
    const { ids, nodes } = await pageOf("fossil");
    expect(ids).toHaveLength(50);
    expect(lettersRead(nodes), "the walk passed 20 letters a member").toBeLessThanOrEqual(20 * own);
  }, 60_000);

  it("the word index serves only reads under its account key, even with no plain word index to prefer", async () => {
    const without = ["message_search_head_tsv_idx", "message_search_text_tsv_idx"];
    for (const q of ["alpha note", "alpha midtown", "note -ribbon"]) {
      for (const filters of [undefined, { unread: true }, { hasAttachments: false }]) {
        const { nodes } = await pageOf(q, { without, ...(filters ? { filters } : {}) });
        for (const n of nodes.filter((x) => x["Index Name"] === "message_search_words_idx")) {
          expect(String(n["Index Cond"]), `${q} ${JSON.stringify(filters)}`).toContain("(account_id)::text");
        }
      }
    }
  }, 120_000);

  it("every answer is exact: the relevance chain is the newest matches, the date order agrees, the total counts them", async () => {
    const svc = new SearchService();
    const c: ServiceContext = { ...ctx, accountId: W };
    const CASES: Array<{ q: string; words: string[] }> = [
      { q: "lantern", words: ["lantern"] }, { q: "ribbon", words: ["ribbon"] }, { q: "oldtide", words: ["oldtide"] },
      { q: "lante", words: ["lantern"] }, { q: "midto", words: ["midtown"] }, { q: "alpha ribbon", words: ["alpha", "ribbon"] },
      { q: "grebe", words: ["grebe"] }, { q: "fossil", words: ["fossil"] },
    ];
    const at = (mins: number): string => new Date(NOW.getTime() - mins * 60_000).toISOString();
    const FILTERS: Array<{ f: Record<string, unknown>; where: SQL }> = [
      { f: {}, where: sql`true` },
      { f: { unread: true }, where: sql`m.unread` },
      { f: { dateFrom: at(9000), dateTo: at(2000) }, where: sql`m.date >= ${at(9000)}::timestamptz and m.date <= ${at(2000)}::timestamptz` },
      { f: { folder: "Small" }, where: sql`fs.desired_folder = 'Small'` },
    ];
    for (const { q, words } of CASES) {
      for (const { f, where } of FILTERS) {
        const what = `${q} ${JSON.stringify(f)}`;
        const truth = ((await base.execute(sql`select m.id from messages m join message_search s on s.message_id = m.id
          left join folder_state fs on fs.message_id = m.id
          where m.account_id = ${W}::uuid and m.deleted_at is null and ${where}
            and ${sql.join(words.map((w) => sql`(s.head_tsv @@ to_tsquery('english', ${w}) or s.text_tsv @@ to_tsquery('english', ${w}))`), sql` and `)}
          order by m.date desc nulls last, m.id desc`)) as unknown as Array<{ id: string }>).map((r) => r.id);
        const chain: string[] = [];
        let cursor: string | undefined;
        do {
          const r = await svc.search(c, { q, parts: "page", filters: f, ...(cursor ? { cursor } : {}) });
          chain.push(...r.items.map((i) => i.id));
          cursor = r.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(chain, what).toEqual(truth.slice(0, Math.min(truth.length, K)));
        const dated = await svc.search(c, { q, parts: "page", filters: f, sort: "date_desc" });
        expect(dated.items.map((i) => i.id), what).toEqual(truth.slice(0, 50));
        const summary = await svc.search(c, { q, parts: "summary", filters: f });
        expect(summary.total, what).toBe(truth.length);
      }
    }
  }, 120_000);

  it("a small working memory keeps the History walk's membership test a hashed set", async () => {
    const small = postgres(URL, { max: 1, connection: { work_mem: "256kB" } });
    try {
      const { ids, nodes } = await pageOf("oldtide", { on: brandDialect(drizzle(small, { schema }), "pg") });
      expect(ids).toHaveLength(50);
      // The walk's `(m.id in ps) is true`, on the History scan or above its bound.
      const member = nodes.filter((n) => /SubPlan.*IS TRUE/.test(String(n["Filter"] ?? "")));
      expect(member.length, "no History walk tested membership").toBeGreaterThan(0);
      for (const n of member) expect(String(n["Filter"]), "membership asked per letter").toContain("hashed SubPlan");
    } finally {
      await small.end({ timeout: 5 });
    }
  }, 60_000);

  it("the neighbour's letters are neither read into a set nor answered", async () => {
    for (const w of ["oldtide", "ribbon", "lantern"]) {
      const own = await matchesOf(w);
      const { ids, nodes } = await pageOf(w);
      expect(ids.length, w).toBeGreaterThan(0);
      for (const id of ids) expect(owner.get(id), w).toBe(W);
      const sets = nodes.filter((n) => n["Subplan Name"] === "CTE ps");
      expect(sets.length, `${w}: no set was read`).toBeGreaterThan(0);
      for (const n of sets) expect(rowsOf(n), `${w}: a set holds another account's letters`).toBeLessThanOrEqual(own);
    }
  }, 60_000);

  it("without the word index the search reads as before, and answers the same", async () => {
    const QS = ["oldtide", "ribbon", "midto", "alpha midtown", "lantern"];
    const before = new Map<string, string[]>();
    for (const q of QS) before.set(q, (await pageOf(q)).ids);
    await base.execute(sql`drop index if exists message_search_words_idx`);
    try {
      for (const q of QS) {
        // A fresh handle each page (`pageOf` wraps one), so no probe's answer is remembered.
        const { ids, sent } = await pageOf(q);
        expect(ids, q).toEqual(before.get(q));
        for (const st of sent) expect(st, q).not.toContain("(account_id)::text");
      }
    } finally {
      await ensureWordIndex(base, { concurrently: false });
    }
  }, 120_000);
});

afterAll(async () => { await client.end({ timeout: 5 }); });
