import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { SearchFilters, ServiceContext } from "@trafficflow/services";

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
const ctxOf = (accountId: string): ServiceContext => ({ db: db as never, accountId, userId: null, now: () => NOW, requestId: "search-part-probe" });
const ctx = ctxOf(A);
afterAll(() => client.end({ timeout: 5 }));

type PlanNode = Record<string, unknown>;
/** Every node of the page statement's plan as it ran, and the page's answer. */
async function pagePlan(q: string, at: ServiceContext = ctx, filters: SearchFilters = {}, limit?: number): Promise<{ nodes: PlanNode[]; items: number }> {
  seen.length = 0;
  const r = await new SearchService().search(at, { q, parts: "page", filters, ...(limit ? { limit } : {}) });
  const textOf = (st: SQL): string => (base as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string } } }).dialect.sqlToQuery(st).sql;
  const page = seen.find((st) => textOf(st).includes("fused"));
  expect(page, "the page statement was not recorded").toBeDefined();
  const plan = (await base.transaction(async (tx) => {
    await tx.execute(sql`select set_config('enable_seqscan', 'off', true), set_config('jit', 'off', true)`);
    return tx.execute(sql`explain (analyze, format json) ${page!}`);
  })) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>;
  const nodes: PlanNode[] = [];
  const walk = (n: PlanNode): void => {
    nodes.push(n);
    for (const c of (n["Plans"] as PlanNode[] | undefined) ?? []) walk(c);
  };
  walk(plan[0]!["QUERY PLAN"][0]!.Plan);
  return { nodes, items: r.items.length };
}
/** Rows a plan node returned over all its loops. */
const rowsOf = (n: PlanNode): number => Number(n["Actual Rows"]) * Number(n["Actual Loops"]);

/** The largest row count any scan of the History index returned in the page statement's plan. */
async function deepestWalk(q: string): Promise<{ rows: number; items: number }> {
  const { nodes, items } = await pagePlan(q);
  const walks = nodes.filter((n) => n["Index Name"] === "messages_account_msg_order_idx").map(rowsOf);
  return { rows: Math.max(0, ...walks), items };
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
    expect(r.rows).toBeGreaterThan(0);
  });
});

/**
 * MID-DENSITY WORDS READ BY WHAT THE PROBE SEES, MAIN'S READ BY DEFAULT. Bodies only, newest first by
 * `g`: a part in one body of 7 (29 of the newest 200) reads its matches as one set and walks History
 * against it to its K-th match; so does a word in one of 31 (7 there); one in 61 (164 in all) dates
 * its set; one in 1000 reads its GIN. `owl` and `plover` are in most older bodies and few new ones;
 * so are `yak` and `wigeon`, 2 of the newest 40 and 25 of the newest 1,200; `gnu` and `gadwall` are in
 * none of the newest 200 and many after. `egret` and `heron` sit in the newest half, mostly read, so
 * under unread their sets hold few; `tax` is a short word in a small folder. Each answer is exact: for
 * body-only words the relevance pages are the `date_desc` pages.
 */
describe("mid-density words: a walk or the matches as a set, by the probe (real Postgres)", () => {
  const B = randomUUID();
  const at = ctxOf(B);
  const M = 10_000;
  const K = 200;
  beforeAll(async () => {
    const [mb] = await base.insert(mailboxes).values({ accountId: B, provider: "imap", address: "mid@tf.example" }).returning();
    await base.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select ${B}::uuid, ${mb!.id}::uuid, 'h', 'mid:' || g, 'entry ' || g, 's' || (g % 97) || '@mid.example',
        ${NOW.toISOString()}::timestamptz - make_interval(mins => g), g % 3 = 0, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(1, ${M}) g`);
    await base.execute(sql`insert into message_bodies (message_id, text)
      select id, 'harbour log' || case when g % 7 = 3 then ' mooring' else '' end || case when g % 31 = 5 then ' anchorage' else '' end
        || case when g % 61 = 7 then ' buoy' else '' end || case when g % 1000 = 500 then ' kestrel' else '' end
        || case when (g <= 400 and g % 15 = 1) or (g > 400 and g % 5 <> 0) then ' owl' else '' end
        || case when (g <= 400 and g % 15 = 2) or (g > 400 and g % 5 <> 1) then ' plover' else '' end
        || case when g <= 5000 and g % 20 = 3 then ' egret' else '' end
        || case when g <= 6000 and (g % 6 = 1 or g % 60 = 3) then ' heron' else '' end
        || case when g % 50 = 25 and g % 3 <> 2 then ' tax' else '' end
        || case when (g <= 40 and g % 20 = 1) or (g > 40 and g <= 1500 and g % 50 = 1) or (g > 1500 and g % 2 = 1) then ' yak wigeon' else '' end
        || case when g > 200 and g % 2 = 0 then ' gnu' else '' end || case when g > 400 and g % 3 = 0 then ' gadwall' else '' end
        || case when (g % 50 = 25 and g % 800 < 50) or g % 10 = 3 then ' puffin' else '' end
      from messages m cross join lateral (select split_part(m.dedup_key, ':', 2)::int as g) x where m.account_id = ${B}::uuid`);
    // A small folder: one letter in 50.
    await base.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select id, f, f, 'us' from messages m cross join lateral (select case when split_part(m.dedup_key, ':', 2)::int % 50 = 25 then 'Receipts' else 'INBOX' end as f) x
      where account_id = ${B}::uuid`);
    await base.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, setweight(to_tsvector('english', m.subject), 'A'), to_tsvector('english', b.text), lower(m.subject), 'text'
      from messages m join message_bodies b on b.message_id = m.id where m.account_id = ${B}::uuid`);
    await base.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${B}::uuid, now())`);
    await base.execute(sql`analyze messages`);
    await base.execute(sql`analyze message_search`);
  }, 120_000);

  afterAll(async () => {
    await base.execute(sql`delete from message_search where account_id = ${B}::uuid`);
    await base.execute(sql`delete from account_settings where account_id = ${B}::uuid`);
    await base.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${B}::uuid)`);
    await base.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${B}::uuid)`);
    await base.execute(sql`delete from messages where account_id = ${B}::uuid`);
    await base.execute(sql`delete from mailboxes where account_id = ${B}::uuid`);
  });

  // The newest 600 letters: History under the date holds 86 of its matches, and that is every one.
  const recent = { dateFrom: new Date(NOW.getTime() - 600 * 60_000).toISOString() };
  for (const [filters, items] of [[{}, 50], [recent, 50]] as const) {
    it(`a part in one body of 7 is read newest first${"dateFrom" in filters ? " under a date" : ""}: History is read to its K-th match, never joined whole`, async () => {
      const r = await pagePlan("moorin", at, filters);
      expect(r.items).toBe(items);
      expect(historyRead(r.nodes), "History read past the part's K-th match").toBeLessThanOrEqual(2 * 7 * K);
    });
  }

  it("a word in one body of 31 is read as a set and History walked against it, no document asked past 2K times", async () => {
    const { nodes, items } = await pagePlan("anchorage", at);
    expect(items).toBe(50);
    expect(nodes.some((n) => /hashed SubPlan/.test(String(n["Filter"] ?? ""))), "no hashed set").toBe(true);
    const lookups = nodes.filter((n) => n["Relation Name"] === "message_search" && /Index/.test(String(n["Node Type"])))
      .map((n) => Number(n["Actual Loops"]));
    expect(Math.max(0, ...lookups), "the word was walked letter by letter").toBeLessThanOrEqual(2 * K);
  });

  /** The most History index entries one scan of the page statement read, the ones its filter removed included. */
  const historyRead = (nodes: PlanNode[]): number => Math.max(0, ...nodes.filter((n) => n["Index Name"] === "messages_account_msg_order_idx")
    .map((n) => (Number(n["Actual Rows"]) + Number(n["Rows Removed by Filter"] ?? 0)) * Number(n["Actual Loops"])));

  it("a word past the set's cap, sparse in the newest mail, is read newest first: its matches are not read whole", async () => {
    // A page of 10: K 40, the set's cap 4,000 of the word's 7,707 matches, 3 in the newest 40.
    const r = await pagePlan("owl", at, {}, 10);
    expect(r.items).toBe(10);
    const heaps = r.nodes.filter((n) => n["Node Type"] === "Bitmap Heap Scan" && n["Relation Name"] === "message_search").map(rowsOf);
    expect(Math.max(0, ...heaps), "every match was read off the index").toBeLessThanOrEqual(100 * 40);
  });

  /** How many of this mailbox's bodies hold `word`. */
  const bodies = async (word: string): Promise<number> => {
    const [row] = (await base.execute(sql`select count(*)::int as n from message_search
      where account_id = ${B}::uuid and text_tsv @@ to_tsquery('english', ${word})`)) as unknown as Array<{ n: number }>;
    return Number(row!.n);
  };
  /** The rows each read off message_search's GINs returned. */
  const readOff = (nodes: PlanNode[]): number[] => nodes
    .filter((n) => n["Node Type"] === "Bitmap Heap Scan" && n["Relation Name"] === "message_search").map(rowsOf);
  /** Documents asked one by one: message_search's index lookups, over all their loops. */
  const asked = (nodes: PlanNode[]): number => nodes
    .filter((n) => n["Relation Name"] === "message_search" && /Index/.test(String(n["Node Type"]))).reduce((a, n) => a + Number(n["Actual Loops"]), 0);

  it("a longer word in most older mail and few new: its matches are read off the index once at most", async () => {
    const r = await pagePlan("plover", at, {}, 10);
    expect(r.items).toBe(10);
    expect(readOff(r.nodes).reduce((a, b) => a + b, 0), "a match was read twice").toBeLessThanOrEqual(await bodies("plover"));
  });

  it("a short word sparse in the newest mail and past the set's cap is read as the planner reads it: none of its matches off the index", async () => {
    // 2 of the newest 40 at 10 a page (K 40), 25 of the newest 1,200, 4,281 in all: the newest 30 cuts never fill.
    const r = await pagePlan("yak", at, {}, 10);
    expect(r.items).toBe(10);
    expect(Math.max(0, ...readOff(r.nodes)), "its matches were read off the index").toBeLessThanOrEqual(40);
  });

  it("a longer word the same way: each arm reads its matches once, and no document is asked past the probe", async () => {
    const r = await pagePlan("wigeon", at, {}, 10);
    expect(r.items).toBe(10);
    expect(readOff(r.nodes).reduce((a, b) => a + b, 0), "a match was read twice in one arm").toBeLessThanOrEqual(2 * await bodies("wigeon"));
    expect(asked(r.nodes), "documents asked one by one past the probe").toBeLessThanOrEqual(2 * 40);
  });

  it("a short word in none of the newest mail is read as the planner reads it: none of its matches off the index", async () => {
    const r = await pagePlan("gnu", at);
    expect(r.items).toBe(50);
    expect(Math.max(0, ...readOff(r.nodes)), "its matches were read off the index").toBeLessThanOrEqual(K);
  });

  it("a longer word in none of the newest mail: History is read to its K-th match, the mailbox never read whole", async () => {
    const r = await pagePlan("gadwall", at);
    expect(r.items).toBe(50);
    // Any read of messages, by any index or none: a join of every match with the mailbox reads it whole.
    const read = Math.max(0, ...r.nodes.filter((n) => n["Relation Name"] === "messages")
      .map((n) => (Number(n["Actual Rows"]) + Number(n["Rows Removed by Filter"] ?? 0)) * Number(n["Actual Loops"])));
    expect(read, "the mailbox read whole").toBeLessThan(M / 2);
  });

  it("a recent word whose unread few no walk could reach is dated: History is read no deeper than the probe", async () => {
    // 1,100 matches, 100 of them unread: walked against its set, History was read whole for each arm.
    const r = await pagePlan("heron", at, { unread: true });
    expect(r.items).toBe(50);
    expect(historyRead(r.nodes), "History walked past the probe").toBeLessThanOrEqual(4 * K);
  });

  it("a part of a word in a small folder reads History whole at most once, for the probe, never against a set", async () => {
    // 12 of the folder's newest 200 letters, 1,012 in all: walked against its set, History was read whole for each arm.
    const r = await pagePlan("puffin", at, { folder: "Receipts" });
    expect(r.items).toBeGreaterThan(0);
    const whole = r.nodes.filter((n) => n["Index Name"] === "messages_account_msg_order_idx"
      && (Number(n["Actual Rows"]) + Number(n["Rows Removed by Filter"] ?? 0)) * Number(n["Actual Loops"]) >= M / 2);
    expect(whole.length, "History read whole more than once").toBeLessThanOrEqual(1);
  }, 30_000);

  it("a set of a few cuts under a filter on the heap is dated whole: History is read no deeper than the probe", async () => {
    // 250 matches, 84 of them unread: walked against the set, History was read whole for each arm.
    const r = await pagePlan("egret", at, { unread: true });
    expect(r.items).toBe(50);
    expect(historyRead(r.nodes), "History walked past the probe").toBeLessThanOrEqual(4 * K);
  });

  it("a short word under a small folder is not probed: History is not read whole to find the folder's newest K", async () => {
    const r = await pagePlan("tax", at, { folder: "Receipts" });
    expect(r.items).toBe(50);
    expect(historyRead(r.nodes), "the account read to find the folder's newest letters").toBeLessThan(M / 2);
  });

  const cases: Array<[SearchFilters, number]> = [[{}, 50], [{ unread: true }, 50], [recent, 50], [{ folder: "Receipts" }, 50], [{}, 10], [{ unread: true }, 10]];
  for (const [filters, limit] of cases) {
    it(`each answer is exact${filters.unread ? " with a filter on the heap" : filters.dateFrom ? " under a date" : filters.folder ? " in a small folder" : ""}${limit < 50 ? `, ${limit} a page` : ""}: the relevance pages are the date_desc pages`, async () => {
      const svc = new SearchService();
      for (const q of ["moorin", "anchorage", "buoy", "kestrel", "harbour", "owl", "plover", "egret", "heron", "tax", "yak", "wigeon", "gnu", "gadwall", "puffin"]) {
        let first: { total: number; totalExact: boolean } | undefined;
        const chain = async (sort: "relevance" | "date_desc", most: number): Promise<string[]> => {
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const r = await svc.search(at, { q, parts: "page", sort, filters, limit, ...(cursor ? { cursor } : {}) });
            first ??= r;
            ids.push(...r.items.map((x) => x.id));
            cursor = r.nextCursor ?? undefined;
          } while (cursor !== undefined && ids.length < most);
          return ids;
        };
        const relevance = await chain("relevance", Infinity);
        // None of these is in the small folder.
        if (filters.folder !== undefined && ["kestrel", "owl", "egret", "gnu"].includes(q)) expect(relevance, q).toEqual([]);
        else expect(relevance.length, q).toBeGreaterThan(0);
        // Fewer than an arm's cut in all: no arm is cut, and the first page counts them exactly.
        if (relevance.length < 4 * limit) expect({ total: first!.total, exact: first!.totalExact }, q).toEqual({ total: relevance.length, exact: true });
        expect(relevance, q).toEqual((await chain("date_desc", relevance.length)).slice(0, relevance.length));
      }
    }, 60_000);
  }
});
