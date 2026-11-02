import { expect } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { mailboxes } from "@trafficflow/db";
import type { schema } from "@trafficflow/db/cloud";
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
  // Planted: kestrel 1, osprey 4, plover 12, egret 24, avocet 37 bodies; an address and `harbour_ledger` in 44.
  await h.execute(sql`
    insert into message_bodies (message_id, text)
    select m.id, ${words(sql`x.g`, "b", sql`100 + (hashtext(x.g::text) & 127)`)}
      || case when x.g = 31337 then ' kestrel' else '' end || case when x.g % 18500 = 17 then ' osprey' else '' end
      || case when x.g % 6166 = 11 then ' plover' else '' end || case when x.g % 3083 = 7 then ' egret' else '' end
      || case when x.g % 2000 = 13 then ' avocet' else '' end || case when x.g % 1700 = 9 then ' ledger@kestrelbay.example harbour_ledger' else '' end
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
