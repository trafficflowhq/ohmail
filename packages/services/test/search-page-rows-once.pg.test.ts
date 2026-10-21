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
import type { ServiceContext } from "@trafficflow/services";

/**
 * THE PAGE READS EACH CANDIDATE'S MESSAGE ONCE, AT MOST. A cold first search paid a disk read per
 * key lookup: the part walk asked each walked message's row again beside its document, and the
 * fused candidates (up to four arms' cuts) were each looked up once more for their date, which the
 * arms had read already. Counted off the page statement's own plan: every lookup of a message by
 * key is the page's materialization (one per row returned), whatever the arms walked. Real Postgres.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 1 });
const base = brandDialect(drizzle(client, { schema }), "pg");
const A = randomUUID();
const N = 1_500;
const NOW = new Date("2026-10-10T12:00:00Z");

const seen: SQL[] = [];
/** Every statement the service sends, the transaction's and the builders' included (`search-part-probe.pg`'s recorder). */
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
const ctx: ServiceContext = { db: db as never, accountId: A, userId: null, now: () => NOW, requestId: "search-page-rows-once" };
const KEYS = new Set(["messages_pkey", "messages_id_account_uq"]);


type Node = Record<string, unknown>;
const kids = (n: Node): Node[] => (n["Plans"] as Node[] | undefined) ?? [];
/** Lookups of a message by key in `n`'s subtree, each counted once per loop. */
const lookupsIn = (n: Node): number => (KEYS.has(String(n["Index Name"])) ? Number(n["Actual Loops"]) : 0) + kids(n).reduce((a, c) => a + lookupsIn(c), 0);

/**
 * The page statement's plan, split where the change is: lookups OUTSIDE every arm (what the page
 * does with the fused candidates: the materialization's, one per row returned), and lookups inside
 * the part arm's per-row probes (the `exists` subplans under its walk). An arm reading its matches
 * off an index still dates each one, and that is not counted here.
 */
async function keyLookups(q: string): Promise<{ outside: number; probes: number; walked: number; items: number }> {
  seen.length = 0;
  const r = await new SearchService().search(ctx, { q, parts: "page" });
  const textOf = (st: SQL): string => (base as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string } } }).dialect.sqlToQuery(st).sql;
  const page = seen.find((st) => textOf(st).includes("fused"));
  expect(page, "the page statement was not recorded").toBeDefined();
  const plan = (await base.transaction(async (tx) => {
    await tx.execute(sql`select set_config('enable_seqscan', 'off', true), set_config('jit', 'off', true)`);
    return tx.execute(sql`explain (analyze, format json) ${page!}`);
  })) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Node }> }>;
  let outside = 0; let probes = 0; let walked = 0;
  const isArm = (n: Node): boolean => /^CTE s?a\d+$/.test(String(n["Subplan Name"] ?? ""));
  const holdsWalk = (n: Node): boolean => String(n["Subplan Name"] ?? "") === "CTE pw" || kids(n).some(holdsWalk);
  const visit = (n: Node, inArm: boolean, inPart: boolean): void => {
    if (n["Index Name"] === "messages_account_msg_order_idx") walked += Number(n["Actual Rows"]) * Number(n["Actual Loops"]);
    const arm = inArm || isArm(n);
    const part = inPart || (isArm(n) && holdsWalk(n));
    if (part && n["Parent Relationship"] === "SubPlan") { probes += lookupsIn(n); return; }
    if (!arm && KEYS.has(String(n["Index Name"]))) outside += Number(n["Actual Loops"]);
    for (const c of kids(n)) visit(c, arm, part);
  };
  const root = plan[0]!["QUERY PLAN"][0]!.Plan;
  visit(root, false, false);
  return { outside, probes, walked, items: r.items.length };
}

describe("the search page looks a message up by key only for the rows it returns (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(base, { concurrently: false });
    await ensureHotPathIndexes(base, { concurrently: false });
    const [mb] = await base.insert(mailboxes).values({ accountId: A, provider: "imap", address: "rowsonce@tf.example" }).returning();
    // Every message says "harbour"; one in 300 says "lighthouse" (the sparse part `lighth`).
    await base.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select ${A}::uuid, ${mb!.id}::uuid, 'h', 'rowsonce:' || g, case when g % 300 = 7 then 'lighthouse notes ' || g else 'harbour notes ' || g end,
        's' || g || '@rowsonce.example', ${NOW.toISOString()}::timestamptz - make_interval(mins => g), false, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
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
    await client.end({ timeout: 5 });
  });

  it.each([["a dense part, walked", "harbo"], ["a whole word in every message", "harbour"], ["a sparse part", "lighth"]])("%s: the fused candidates are not looked up again, the part's probes ask the document alone", async (_label, q) => {
    const r = await keyLookups(q);
    expect(r.items, "the page found nothing, so the count measures nothing").toBeGreaterThan(0);
    expect(r.outside, `${q}: ${r.outside} lookups outside the arms for ${r.items} rows`).toBeLessThanOrEqual(r.items + 1);
    expect(r.probes, `${q}: the part arm's probes looked up ${r.probes} messages`).toBe(0);
  });

  it("the control: the dense part's walk still runs past the page and its probes ran", async () => {
    const r = await keyLookups("harbo");
    expect(r.items).toBe(50);
    expect(r.walked).toBeGreaterThan(50);
  });
});
