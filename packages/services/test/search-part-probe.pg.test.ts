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
async function deepestWalk(q: string): Promise<{ rows: number; items: number }> {
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
  const walk = (n: Record<string, unknown>): void => {
    if (n["Index Name"] === "messages_account_msg_order_idx") deepest = Math.max(deepest, Number(n["Actual Rows"]) * Number(n["Actual Loops"]));
    for (const c of (n["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
  };
  walk(plan[0]!["QUERY PLAN"][0]!.Plan);
  return { rows: deepest, items: r.items.length };
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
    await client.end({ timeout: 5 });
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
