import { rmSync } from "node:fs";
import { loadavg } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import type { ServiceContext } from "@trafficflow/services";
import { searchFor } from "../../src/composition-passes.js";
import { GIN_PENDING_LIST_KB, openLocalDb, type OpenLocalDb } from "../../src/db.js";
import { freshDataDir } from "../_datadir.js";

/**
 * SEARCH IS MILLISECONDS ON THE DESKTOP'S OWN STORE, through the local door's own service
 * (`searchFor("local")`): the first page inside 100 ms at p95 and the estimate inside 150 ms, for a
 * broad, a mid and a narrow word, a word in one message of twelve, a substring, a typo and a phrase;
 * no statement scans a table, and no scan in one reads more rows than a walk of the newest six cuts
 * (a bounded walk) whatever the match count, first after a fresh open too (150 ms). `N` messages, the server
 * twin's generator (~6 min here); the larger corpus's reading is the lane's. Watched red: a K of forty pages,
 * the estimate without its typo tier; at the base the broad, the mid and the one-in-twelve word
 * each read all `N` messages, and so did the first page after a fresh open.
 */
const N = 10_000;
const PAGE_BUDGET_MS = 100;
const ESTIMATE_BUDGET_MS = 150;
/** The first page after a fresh open reads its pages off disk: PGlite's buffer pool starts empty. */
const COLD_PAGE_BUDGET_MS = 150;
/** A walk of the newest six cuts of a 50-row page: what a bounded arm may read. */
const ROWS_PER_SCAN = 6 * 4 * 50;
const MID = "kestrelmid";
const QUERIES = ["w1", "w40", "w3000", MID, "axa", "portl", '"myaxa portal"'] as const;
/** The recipients (mail 0154): the own address in To of every message, a rare contact, a mid one in Cc. */
const OWN = "Budget@mail.example";
const RARE = "rare@contact.example";
const MID_CONTACT = "mid@contact.example";
const ADDRESS_CLASSES = [
  { cls: "to rare", address: RARE, direction: "to", total: 10 },
  { cls: "to mid", address: MID_CONTACT, direction: "to", total: 200 },
  { cls: "to own", address: OWN, direction: "to", total: N },
  { cls: "any own", address: OWN.toLowerCase(), direction: "any", total: N },
  { cls: "from", address: "news@axa.example", direction: "from", total: 30 },
] as const;
/** The exact count reads every match by contract; the bound on rows read is the page's. */
const isCount = (text: string): boolean => /^\s*select\s+\(?(cast\()?count\(\*\)/i.test(text);
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));
const textOf = (st: SQL): string => (o.db as unknown as { dialect: { sqlToQuery(s: SQL): { sql: string } } }).dialect.sqlToQuery(st).sql;

let dir = "";
let o: OpenLocalDb;
let accountId = "";
/** Every statement the service sends, in its own transaction too, and the settings it ran under. */
const seen: Array<{ st: SQL; session: SQL[] }> = [];
function recording(target: any, session: SQL[] | null): any {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop === "execute") return (st: SQL) => {
        if (session !== null && /set_config/.test(textOf(st))) session.push(st);
        else seen.push({ st, session: session ?? [] });
        return t.execute(st);
      };
      if (prop === "transaction") return (fn: (tx: unknown) => Promise<unknown>) => t.transaction((tx: unknown) => fn(recording(tx, [])));
      return Reflect.get(t, prop, recv);
    },
  });
}
const ctx = (): ServiceContext =>
  ({ db: recording(o.db, null), accountId, userId: null, now: () => new Date("2026-09-23T12:00:00Z"), requestId: "budget-local" }) as ServiceContext;

/** The relations a statement read by a sequential scan, from its own plan, under its own settings. */
async function seqScans(st: SQL, session: SQL[]): Promise<string[]> {
  const plan = await o.db.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return rows(await tx.execute(sql`explain (format json) ${st}`));
  });
  const out: string[] = [];
  const walk = (p: Record<string, unknown>): void => {
    if (p["Node Type"] === "Seq Scan") out.push(String(p["Relation Name"]));
    for (const c of (p["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
  };
  const cell = plan[0]?.["QUERY PLAN"];
  walk(((typeof cell === "string" ? JSON.parse(cell) : cell) as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
  return out.filter((rel) => rel === "messages" || rel === "message_search" || rel === "message_bodies");
}

/** The most rows one scan of `messages`, `message_search` or `message_bodies` read (kept or filtered out), across its loops. */
async function widestScan(st: SQL, session: SQL[]): Promise<{ rows: number; at: string }> {
  const plan = await o.db.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return rows(await tx.execute(sql`explain (analyze, format json) ${st}`));
  });
  let widest = { rows: 0, at: "" };
  const walk = (p: Record<string, unknown>): void => {
    const rel = String(p["Relation Name"] ?? "");
    const read = Number(p["Actual Rows"] ?? 0) + Number(p["Rows Removed by Filter"] ?? 0) + Number(p["Rows Removed by Index Recheck"] ?? 0);
    const n = read * Number(p["Actual Loops"] ?? 1);
    const scan = /Scan$/.test(String(p["Node Type"])) && p["Node Type"] !== "Bitmap Index Scan";
    if (scan && ["messages", "message_search", "message_bodies"].includes(rel) && n > widest.rows) widest = { rows: n, at: `${String(p["Node Type"])} ${rel}` };
    for (const c of (p["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
  };
  const cell = plan[0]?.["QUERY PLAN"];
  walk(((typeof cell === "string" ? JSON.parse(cell) : cell) as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
  return widest;
}

const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

/**
 * THE QUIET CLOCK, as the server twin reads it: a figure is read in up to ROUNDS rounds of its whole
 * sample set and fails only when EVERY round is over its budget. Before each round the store's CPU is
 * read through a fixed statement that touches no search code; while it runs over QUIET_RATIO times the
 * run's quietest reading the round waits, up to QUIET_WAIT_MS, then runs anyway. Every round prints its
 * figures, the reference, the wait and the load, so a red names its rounds. The budgets never move.
 */
const ROUNDS = 3;
const QUIET_RATIO = 1.25;
const QUIET_WAIT_MS = 45_000;
let quietest = Infinity;
async function referenceMs(): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await o.db.execute(sql`select count(*) from generate_series(1, 50000)`);
    xs.push(performance.now() - t);
  }
  const ms = [...xs].sort((a, b) => a - b)[2]!;
  quietest = Math.min(quietest, ms);
  return ms;
}
async function bestOfRounds(label: string, budget: Record<string, number>, round: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
  const best: Record<string, number> = {};
  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    let ref = await referenceMs();
    while (ref > quietest * QUIET_RATIO && Date.now() - t0 < QUIET_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 1_000));
      ref = await referenceMs();
    }
    const waited = Date.now() - t0;
    const figures = await round();
    const after = await referenceMs();
    console.log(`search-budget-local ${label} round ${i}/${ROUNDS} ref ${ref.toFixed(1)}/${after.toFixed(1)} ms (quietest ${quietest.toFixed(1)}, waited ${waited} ms) `
      + `load ${loadavg()[0]!.toFixed(2)}: ${Object.entries(figures).map(([k, v]) => `${k} ${v} ms`).join(", ")}`);
    for (const [k, v] of Object.entries(figures)) best[k] = Math.min(best[k] ?? Infinity, v);
    if (Object.entries(best).every(([k, v]) => v <= budget[k]!)) break;
  }
  return best;
}

describe(`the desktop store's search is milliseconds (PGlite, ${N} messages)`, () => {
  beforeAll(async () => {
    const seedStart = Date.now();
    dir = await freshDataDir("ohmail-search-budget-");
    o = await openLocalDb(dir);
    /* THE SEED RUNS UNDER POSTGRES' 4 MB GIN PENDING LIST, THE SEARCH UNDER THE STORE'S 256 kB.
       The store's bound is for one message per commit; a seed statement of thousands of rows overflows it again
       and again (minutes at the store's bound, far less here, measured). Every list is flushed and the
       store's bound set back before the first measured search, so the indexes are grown row by
       row as ingest grows them and nothing is left pending. */
    await o.db.execute(sql.raw("set gin_pending_list_limit = 4096"));
    accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('budget') returning id`))[0].id;
    const mb = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'budget@mail.example') returning id`))[0].id;
    // The twin's vocabulary — word k = floor(5000 · u⁴), so `w1` is in almost every body.
    const word = sql`('w' || floor(5000 * power(random(), 4))::int)`;
    await o.db.execute(sql`select setseed(0.23)`);
    await o.db.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator, to_addresses, cc_addresses)
      select ${accountId}::uuid, ${mb}::uuid, 'h', 'budget:' || g,
        case when g % 200 = 0 then 'myAXA Portal ' || (g % 97) else (select string_agg(${word}, ' ') from generate_series(1, 3 + (g % 4)) i where g > 0) end
          || case when g % 12 = 0 then ' ' || ${MID} else '' end,
        case when g % 333 = 0 then 'news@axa.example' else 'sender' || (g % 2000) || '@dom' || (g % 300) || '.example' end,
        timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g * 97), g % 3 = 0, g % 10 = 0,
        jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g),
        jsonb_build_array(jsonb_build_object('name', null, 'address', ${OWN}::text))
          || case when g % 1000 = 7 then jsonb_build_array(jsonb_build_object('name', null, 'address', ${RARE}::text)) else '[]'::jsonb end,
        case when g % 50 = 3 then jsonb_build_array(jsonb_build_object('name', 'Mid', 'address', ${MID_CONTACT}::text)) else '[]'::jsonb end
      from generate_series(1, ${N}) g`);
    await o.db.execute(sql`
      insert into message_bodies (message_id, text)
      select m.id, (select string_agg(${word}, ' ') from generate_series(1, 100 + (hashtext(m.id::text) & 127)) i where m.id is not null)
        || case when substring(m.dedup_key from 8)::int % 12 = 0 then ' ' || ${MID} else '' end
      from messages m where m.account_id = ${accountId}::uuid`);
    await o.db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${accountId}::uuid`);
    // The production writer, then the store's own statistics rule — nothing hand-analyzed.
    const built = await searchIndexBackfillPass({ db: o.db as unknown as Tx, accountId, rounds: 1_000, batch: 2_000 });
    expect(built.marked).toBe(true);
    const gins = rows(await o.db.execute(sql`select x.indexrelid::regclass::text as i from pg_index x
      join pg_class c on c.oid = x.indexrelid join pg_am a on a.oid = c.relam
      where a.amname = 'gin' and x.indrelid::regclass::text in ('messages', 'message_bodies', 'message_search')`));
    expect(gins.length).toBeGreaterThanOrEqual(7);
    for (const g of gins) await o.db.execute(sql`select gin_clean_pending_list(${g.i}::regclass)`);
    await o.db.execute(sql.raw(`set gin_pending_list_limit = ${GIN_PENDING_LIST_KB}`));
    expect(rows(await o.db.execute(sql`show gin_pending_list_limit`))[0].gin_pending_list_limit).toBe(`${GIN_PENDING_LIST_KB}kB`);
    expect(await o.analyzeSearchIfStale()).toBe(true);
    console.log(`search-budget-local seed ${Date.now() - seedStart} ms, ${gins.length} GIN pending lists flushed, load ${loadavg()[0]!.toFixed(2)}`);
    for (let i = 0; i < 10; i++) await referenceMs();
  }, 900_000);

  afterAll(async () => {
    await o?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const q of QUERIES) {
    it(`"${q}": the page inside ${PAGE_BUDGET_MS} ms and the estimate inside ${ESTIMATE_BUDGET_MS} ms at p95, no table scanned`, async () => {
      const svc = searchFor("local");
      await svc.search(ctx(), { q, parts: "page" });
      const best = await bestOfRounds(q, { page: PAGE_BUDGET_MS, estimate: ESTIMATE_BUDGET_MS }, async () => {
        const page: number[] = [];
        const estimate: number[] = [];
        for (let i = 0; i < 20; i++) {
          page.push((await svc.search(ctx(), { q, parts: "page" })).ms);
          estimate.push((await svc.search(ctx(), { q, parts: "estimate" })).ms);
        }
        return { page: p95(page), estimate: p95(estimate) };
      });
      expect(best.page!, `${q} page p95, the best of ${ROUNDS} rounds; the run's quietest reference ${quietest.toFixed(1)} ms`).toBeLessThanOrEqual(PAGE_BUDGET_MS);
      expect(best.estimate!, `${q} estimate p95, the best of ${ROUNDS} rounds; the run's quietest reference ${quietest.toFixed(1)} ms`).toBeLessThanOrEqual(ESTIMATE_BUDGET_MS);

      seen.length = 0;
      const r = await svc.search(ctx(), { q, parts: "page" });
      expect(r.items.length, `${q} found nothing, so its plan measured nothing`).toBeGreaterThan(0);
      await svc.search(ctx(), { q, parts: "estimate" });
      const statements = seen.filter(({ st }) => !/^\s*explain/i.test(textOf(st)));
      expect(statements.length).toBeGreaterThan(1);
      for (const { st, session } of statements) {
        expect(await seqScans(st, session), textOf(st).slice(0, 160)).toEqual([]);
        const wide = await widestScan(st, session);
        expect(wide.rows, `${q}: ${wide.at} read ${wide.rows} rows — ${textOf(st).slice(0, 120)}`).toBeLessThanOrEqual(ROWS_PER_SCAN);
      }
    }, 600_000);
  }

  it(`the address arm, every direction: inside ${PAGE_BUDGET_MS} ms at p95, no table scanned, no page scan past ${ROWS_PER_SCAN} rows`, async () => {
    const svc = searchFor("local");
    for (const c of ADDRESS_CLASSES) {
      const r = await svc.searchByAddress(ctx(), { address: c.address, direction: c.direction });
      expect(r.total, c.cls).toBe(c.total);
      expect(r.items.length, c.cls).toBe(Math.min(50, c.total));
    }
    const best = await bestOfRounds("address", Object.fromEntries(ADDRESS_CLASSES.map((c) => [c.cls, PAGE_BUDGET_MS])), async () => {
      const figures: Record<string, number> = {};
      for (const c of ADDRESS_CLASSES) {
        const ms: number[] = [];
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          await svc.searchByAddress(ctx(), { address: c.address, direction: c.direction });
          ms.push(Math.round(performance.now() - t));
        }
        figures[c.cls] = p95(ms);
      }
      return figures;
    });
    for (const c of ADDRESS_CLASSES) {
      expect(best[c.cls]!, `${c.cls} p95, the best of ${ROUNDS} rounds; the run's quietest reference ${quietest.toFixed(1)} ms`).toBeLessThanOrEqual(PAGE_BUDGET_MS);
      seen.length = 0;
      await svc.searchByAddress(ctx(), { address: c.address, direction: c.direction });
      const statements = seen.filter(({ st }) => !/^\s*explain/i.test(textOf(st)));
      expect(statements.length).toBeGreaterThan(1);
      for (const { st, session } of statements) {
        expect(await seqScans(st, session), `${c.cls}: ${textOf(st).slice(0, 160)}`).toEqual([]);
        if (isCount(textOf(st))) continue;
        const wide = await widestScan(st, session);
        expect(wide.rows, `${c.cls}: ${wide.at} read ${wide.rows} rows — ${textOf(st).slice(0, 120)}`).toBeLessThanOrEqual(ROWS_PER_SCAN);
      }
    }
  }, 600_000);

  it(`first after a fresh open: the broad and the one-in-twelve page inside ${COLD_PAGE_BUDGET_MS} ms, no scan past ${ROWS_PER_SCAN} rows`, async () => {
    // A round is a fresh open and the two first pages; the next round opens the store again.
    const best = await bestOfRounds("first after a fresh open", { first: COLD_PAGE_BUDGET_MS }, async () => {
      await o.close();
      o = await openLocalDb(dir);
      const svc = searchFor("local");
      const first: number[] = [];
      for (const q of ["w1", MID]) {
        const r = await svc.search(ctx(), { q, parts: "page" });
        first.push(r.ms);
        expect(r.items.length).toBeGreaterThan(0);
        // The estimate reads the page's own arms; its statements are the ones this file records.
        seen.length = 0;
        await svc.search(ctx(), { q, parts: "estimate" });
        const arms = seen.filter(({ st }) => /message_search/.test(textOf(st)) && !/^\s*explain/i.test(textOf(st)));
        expect(arms.length).toBeGreaterThan(0);
        for (const { st, session } of arms) expect((await widestScan(st, session)).rows).toBeLessThanOrEqual(ROWS_PER_SCAN);
      }
      // A recipient page first after the open, the own address (the walk) and a rare contact (the index).
      for (const address of [OWN, RARE]) {
        const t = performance.now();
        const r = await svc.searchByAddress(ctx(), { address, direction: "to" });
        first.push(performance.now() - t);
        expect(r.items.length).toBeGreaterThan(0);
      }
      return { first: Math.max(...first) };
    });
    expect(best.first!, `the slower first page, the best of ${ROUNDS} fresh opens; the run's quietest reference ${quietest.toFixed(1)} ms`).toBeLessThanOrEqual(COLD_PAGE_BUDGET_MS);
  }, 600_000);

  it("the typo answers in the similar tier, page and estimate alike, and the phrase in the exact one", async () => {
    const svc = searchFor("local");
    expect((await svc.search(ctx(), { q: "portl", parts: "page" })).tier).toBe("similar");
    expect((await svc.search(ctx(), { q: "portl", parts: "estimate" })).tier).toBe("similar");
    expect((await svc.search(ctx(), { q: '"myaxa portal"', parts: "page" })).tier).toBe("exact");
  }, 300_000);
});
