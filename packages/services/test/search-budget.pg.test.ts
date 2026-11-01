// @postpush: alone
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { availableParallelism, loadavg } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect, pgDialect } from "@trafficflow/db/dialect";
import { mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes, ensureWordIndex, ensureDatedIndexes, DATED_INDEX_SPECS } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { searchDatesFillPass, searchIndexBackfillPass, searchIndexProgress } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { CALIBRATED_REF_MS, LOADED_CEILING, QUIET_RATIO, clockOf, isQuiet, judgedClockOf, judgedVerdicts, mustJudge, outcomeOf, scaleOf, verdicts, windowOf, type Round, type Verdict, type Window } from "./_budget-clock.js";
import { buffersOf, isExplain, isSession, readsOf, recording } from "./_search-reads.js";

/**
 * SEARCH IS MILLISECONDS: the first page of a search answers inside 100 ms of server time at p95
 * on a large mailbox, and every statement it issues reads an index — no sequential scan
 * of `messages` or `message_bodies`. Two large mailboxes: `A` before its backfill (the pre-0125
 * columns, four words and two parts of words: `w100` starts `w1000`–`w1009`, `myax` `myAXA`) and `D` in
 * production's shape (documents built, the marker written), which runs the query harness by
 * class beside a documented neighbour. Real Postgres with pg_trgm and the reading-order index,
 * parallel workers off (this server cannot grow a parallel query's shared memory). Alone: it seeds
 * a large corpus of messages.
 */
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, { max: 1 });
const base = brandDialect(drizzle(client, { schema }), "pg");
const BUDGET_MS = 100;
const N = 74_000;
/* THE SAME MAILBOXES EVERY RUN. They were drawn with random() and random ids, so each run measured
   the budget over a different mailbox: one common-class page read 12,657 shared buffers on one
   seed and 31,669 on the next, and on the slowest CI runners a heavy draw read 129-134 ms where the
   rest of that run's figures matched every green run. Ids, account ids and every word are now
   derived from md5 of a salt, the message's index and the word's position, so a run measures what
   the last one did whatever order Postgres evaluates the rows in. */
const A = "5eed0000-0000-4000-8000-00000000000a";
const D = "5eed0000-0000-4000-8000-00000000000d";
const NOISE = "5eed0000-0000-4000-8000-00000000000e";
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
const D_SALT = "budget-d-s04";
const A_SALT = "budget-a";
const NOISE_SALT = "budget-noise";
/** A uniform draw in [0, 1) from md5 of (salt, message index, position): deterministic and order-free. */
const draw = (salt: string, g: SQL, i: SQL): SQL =>
  sql`((('x' || substr(md5(${salt} || ':' || ${g} || ':' || ${i}), 1, 8))::bit(32)::bigint)::float8 / 4294967296.0)`;
/** A message id from md5 of its account and index. */
const idOf = (acct: string, g: SQL): SQL => sql`md5('budget-id:' || ${acct} || ':' || ${g})::uuid`;

/**
 * Every statement the service sends — on the handle and inside any transaction it opens, where the
 * page runs — so the test can ask Postgres how it ran them under the same session settings.
 */
const seen: SQL[] = [];
const wrap = <T extends object>(target: T): T => recording(target, seen);
const db = wrap(base);

// A skewed vocabulary — word k = floor(5000 · u⁴) — so `w1` is in almost every body and `w3000`
// in a rare few; subjects of 3–6 words, bodies of 100–227.
/** `count` words of A's vocabulary for message `g`, the `part` of it (subject or body) named apart. */
const aWords = (g: SQL, part: string, count: SQL): SQL =>
  sql`(select string_agg('w' || floor(5000 * power(${draw(A_SALT, g, sql`${part} || i`)}, 4))::int, ' ' order by i) from generate_series(1, ${count}) i)`;

/**
 * A's recipients, for the address arm by recipient (mail 0154): its own address in To of every
 * message, a rare contact in To of one in 3083, a mid one in Cc of one in 50.
 */
const OWN = "Me@A.example";
const RARE = "rare@contact.example";
const MID = "mid@contact.example";

async function seed(acct: string, n: number): Promise<void> {
  const [mb] = await base.insert(mailboxes).values({ accountId: acct, provider: "imap", address: `${acct.slice(0, 8)}@tf.example` }).returning();
  await base.execute(sql`
    insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator, to_addresses, cc_addresses)
    select ${idOf(acct, sql`g`)}, ${acct}::uuid, ${mb!.id}::uuid, 'h', 'budget:' || ${acct} || ':' || g,
      case when g % 200 = 0 then 'myAXA Portal ' || (g % 97)
           else ${aWords(sql`g`, "s", sql`3 + (g % 4)`)} end,
      case when g % 333 = 0 then 'news@axa.example' else 'sender' || (g % 2000) || '@dom' || (g % 300) || '.example' end,
      timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g * 97), g % 3 = 0, g % 10 = 0,
      jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g),
      jsonb_build_array(jsonb_build_object('name', null, 'address', ${OWN}::text))
        || case when g % 3083 = 7 then jsonb_build_array(jsonb_build_object('name', null, 'address', ${RARE}::text)) else '[]'::jsonb end,
      case when g % 50 = 3 then jsonb_build_array(jsonb_build_object('name', 'Mid', 'address', ${MID}::text)) else '[]'::jsonb end
    from generate_series(1, ${n}) g`);
  await base.execute(sql`
    insert into message_bodies (message_id, text)
    select m.id, ${aWords(sql`x.g`, "b", sql`100 + (hashtext(x.g::text) & 127)`)}
    from messages m cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x where m.account_id = ${acct}::uuid`);
  await base.execute(sql`
    insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${acct}::uuid`);
}

/**
 * `D`'s mailbox as production holds it: a pseudo-word vocabulary (word k is 3-5 syllables from
 * md5, so words share trigrams the way a language does and the typo tier has real candidates),
 * skewed k = floor(5000 · u⁴); planted rare words; file names on about two letters in five, as
 * mail carries them (signature images, dated invoices, scans, phone photos, joined words, reports,
 * camel-case sheets). A letter with no file name gets its document as `searchDocumentOf` writes it
 * for a sender and no recipients; one with a file name gets the writer's own, through the backfill,
 * which writes the marker.
 */
async function seedDocumented(acct: string, n: number, salt: string): Promise<void> {
  const [mb] = await base.insert(mailboxes).values({ accountId: acct, provider: "imap", address: `${acct.slice(0, 8)}@tf.example` }).returning();
  await base.execute(sql`create temp table if not exists vocab as
    select k, (select string_agg((array['ba','ke','ri','so','tu','na','le','mi','po','da','fe','gi','ho','ju','ra','ve'])[(get_byte(decode(md5('v' || k), 'hex'), i) % 16) + 1], '' order by i)
               from generate_series(0, 2 + k % 3) i) as w
    from generate_series(0, 4999) k`);
  const words = (g: SQL, part: string, count: SQL) => sql`(select string_agg(v.w, ' ' order by r.i) from (select i, floor(5000 * power(${draw(salt, g, sql`${part} || i`)}, 4))::int as k from generate_series(1, ${count}) i) r join vocab v using (k))`;
  await base.execute(sql`
    insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
    select ${idOf(acct, sql`g`)}, ${acct}::uuid, ${mb!.id}::uuid, 'h', 'budget:' || ${acct} || ':' || g,
      case when g % 200 = 0 then 'myAXA Portal ' || (g % 97) when g % 4933 = 3 then 'heron sighting ' || g
           else ${words(sql`g`, "s", sql`3 + (g % 4)`)} end,
      case when g % 8222 = 1 then 'news@dunlin.example' when g % 333 = 0 then 'news@axa.example'
           else 'sender' || (g % 2000) || '@dom' || (g % 300) || '.example' end,
      timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g * 97), g % 3 = 0, g % 10 = 0,
      jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
    from generate_series(1, ${n}) g`);
  // Planted: kestrel 1, osprey 4, plover 12, egret 24, avocet 37 bodies.
  await base.execute(sql`
    insert into message_bodies (message_id, text)
    select m.id, ${words(sql`x.g`, "b", sql`100 + (hashtext(x.g::text) & 127)`)}
      || case when x.g = 31337 then ' kestrel' else '' end || case when x.g % 18500 = 17 then ' osprey' else '' end
      || case when x.g % 6166 = 11 then ' plover' else '' end || case when x.g % 3083 = 7 then ' egret' else '' end
      || case when x.g % 2000 = 13 then ' avocet' else '' end
    from messages m cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x where m.account_id = ${acct}::uuid`);
  await base.execute(sql`
    insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${acct}::uuid`);
  await base.execute(sql`
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
  await base.execute(sql`
    insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
    select m.id, m.account_id,
      setweight(to_tsvector('english', coalesce(m.subject, '')), 'A')
        || setweight(to_tsvector('simple', m.from_address || ' ' || regexp_replace(m.from_address, '[@.+_-]+', ' ', 'g')), 'B'),
      to_tsvector('english', b.text), left(lower(trim(coalesce(m.subject, '') || ' ' || m.from_address)), 2048), 'text'
    from messages m join message_bodies b on b.message_id = m.id
    where m.account_id = ${acct}::uuid and not exists (select 1 from attachments a where a.account_id = m.account_id and a.message_id = m.id)`);
  const filled = await searchIndexBackfillPass({ db: base as never, accountId: acct, batch: 2_000, rounds: 1_000 });
  expect(filled.marked).toBe(true);
}

/** Every row the seeds wrote, by the fixed account ids. */
async function removeSeeded(): Promise<void> {
  for (const acct of [A, D, NOISE]) {
    await base.execute(sql`delete from message_search where account_id = ${acct}::uuid`);
    await base.execute(sql`delete from attachments where account_id = ${acct}::uuid`);
    await base.execute(sql`delete from account_settings where account_id = ${acct}::uuid`);
    await base.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${acct}::uuid)`);
    await base.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${acct}::uuid)`);
    await base.execute(sql`delete from messages where account_id = ${acct}::uuid`);
    await base.execute(sql`delete from mailboxes where account_id = ${acct}::uuid`);
  }
}

function ctx(accountId: string = A): ServiceContext {
  return { db, accountId, userId: null, now: () => new Date("2026-09-23T12:00:00Z"), requestId: "search-budget" };
}

type PlanNode = Record<string, unknown>;
/** Every node of a statement's plan as it ran, under the session settings. */
async function planNodes(st: SQL, session: SQL[]): Promise<PlanNode[]> {
  const r = (await base.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(sql`explain (analyze, format json) ${st}`);
  })) as unknown as Array<Record<string, unknown>>;
  const out: PlanNode[] = [];
  const walk = (p: PlanNode) => {
    out.push(p);
    for (const c of (p["Plans"] as PlanNode[] | undefined) ?? []) walk(c);
  };
  walk(((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode);
  return out;
}
/** The relations a statement read by a sequential scan, from its own plan, under the session settings. */
async function seqScans(st: SQL, session: SQL[]): Promise<string[]> {
  return (await planNodes(st, session)).filter((p) => p["Node Type"] === "Seq Scan").map((p) => String(p["Relation Name"]))
    .filter((rel) => rel === "messages" || rel === "message_bodies");
}

/**
 * PRODUCTION'S ROUND TRIP, PER STATEMENT: every statement the service awaits — begin and commit
 * included — first waits `ms`, as each pays a round trip to the pooler there. The budget on a local
 * socket (~0.1 ms a round trip) says nothing about a path that costs one statement per table.
 */
function latent<T extends object>(target: T, ms: number, count: { n: number }): T {
  const pause = (): Promise<void> => { count.n++; return new Promise((r) => setTimeout(r, ms)); };
  return new Proxy(target, {
    get(t, p, r) {
      if (p === "execute") return async (st: SQL) => { await pause(); return (t as { execute: (s: SQL) => unknown }).execute(st); };
      if (p === "select") return (...a: unknown[]) => paced((t as { select: (...x: unknown[]) => object }).select(...a));
      if (p === "transaction") {
        return async (fn: (tx: unknown) => Promise<unknown>) => {
          await pause();
          const out = await (t as { transaction: (f: (tx: object) => Promise<unknown>) => Promise<unknown> })
            .transaction((tx) => fn(latent(tx, ms, count)));
          await pause();
          return out;
        };
      }
      return Reflect.get(t, p, r);
    },
  });
  function paced<B extends object>(b: B): B {
    return new Proxy(b, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (p === "then" && typeof v === "function") {
          return (ok: (x: unknown) => unknown, bad: (e: unknown) => unknown) =>
            pause().then(() => (v as (a: unknown, b: unknown) => Promise<unknown>).call(t, ok, bad));
        }
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          const out = (v as (...x: unknown[]) => unknown).apply(t, a);
          return out !== null && typeof out === "object" && ("from" in out || "getSQL" in out) ? paced(out) : out;
        };
      },
    });
  }
}

/**
 * THE QUERY HARNESS, by the class the answer falls in: a word in many messages (the page cut),
 * a word in 3-15% of them alone or beside a common one (mid), a word in a few, no match in either
 * tier, and a typo the similar tier answers. `k` names a
 * vocabulary word; one past the vocabulary is outside it and shares its syllables — the broad typo.
 * `of` spells a query of several words, `{k}` a vocabulary word: each word anywhere in the letter.
 */
type Cls = "common" | "mid" | "rare" | "none" | "typo";
const HARNESS: Array<{ cls: Cls; q?: string; k?: number; of?: string }> = [
  ...[0, 1, 2, 5, 40].map((k) => ({ cls: "common" as const, k })), { cls: "common", q: "axa" }, { cls: "common", q: "portal" },
  ...["portal {0}", "{0} portal {2}", "{0} {1}", "{0} -{1}", "{40} -{1}", "{0} {2} -{1}", "{0} or {2} -{1}"].map((of) => ({ cls: "common" as const, of })),
  ...["{100}", "{300}", "{1000}", "{1500}", "{0} {100}", "{0} {1000}"].map((of) => ({ cls: "mid" as const, of })),
  ...["kestrel", "osprey", "plover", "heron", "egret", "avocet", "dunlin", "unlin"].map((q) => ({ cls: "rare" as const, q })),
  ...["heron {0}", "dunlin {1}", "heron -{3000}", "heron {0} -{3000}", "heron or dunlin -{3000}"].map((of) => ({ cls: "rare" as const, of })),
  // Parts of file names: alone and beside other words (a sender's in the last), and fragments typed with
  // their marks, which only the file names' own index reads.
  { cls: "common", q: "image001" },
  ...["pdf", "jpg", "scan", "img", "scan pdf", "invoice pdf", "invoice 2025", "{0} pdf", "{0} {1} jpg", "ice_2025-02", "img_20240"].map((of) => ({ cls: "mid" as const, of })),
  ...["heron pdf", "avocet pdf", "sender1237 pdf", "can0102"].map((of) => ({ cls: "rare" as const, of })),
  ...["zqxjv", "quokka", "xylograph"].map((q) => ({ cls: "none" as const, q })),
  { cls: "typo", k: 77_777 }, { cls: "typo", q: "heorn" },
];
/** A query of one word, which oldest first reads by month (mail 0174). */
const ONE_WORD = /^[a-z0-9]+$/i;
/** A first page is begin, the session's settings, one read and commit; the typo tier is in that read. */
const PAGE_STATEMENTS: Record<Cls, number> = { common: 4, mid: 4, rare: 4, none: 4, typo: 4 };

async function vocabWord(k: number): Promise<string> {
  const [row] = (await base.execute(sql`select (select string_agg((array['ba','ke','ri','so','tu','na','le','mi','po','da','fe','gi','ho','ju','ra','ve'])[(get_byte(decode(md5('v' || ${k}::int), 'hex'), i) % 16) + 1], '' order by i)
    from generate_series(0, 2 + ${k}::int % 3) i) as w`)) as unknown as Array<{ w: string }>;
  return row!.w;
}

/** The round trip `latent` waits before each statement in production's shape. */
const RTT_MS = 8;
const p95Of = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(s.length * 0.95) - 1]!; };

/**
 * THE QUIET CLOCK: a budget figure is read in up to ROUNDS rounds of its whole sample set. Before each
 * round the server's CPU is read through a fixed statement that touches no search code; while it runs
 * over QUIET_RATIO times the run's quietest reading the round waits, up to QUIET_WAIT_MS, then runs
 * anyway. Inside the round the reference is read once beside every sample (`tick`), and again after it.
 * A figure passes when any round reads it inside BUDGET_MS, fails when a quiet round (`_budget-clock.ts`:
 * both ends, and the inside readings' median and p95, at their limits, the host's load average at most a
 * quarter of its CPUs) reads it over, and is unjudged,
 * a SKIPPED-LOADED warning and never red, when no round was quiet, unless it reads past LOADED_CEILING
 * times the budget, which load alone has never reached; under OHMAIL_BUDGET_MUST_JUDGE=1 (ci.yml's nightly job
 * "suite · search budget · judged", on a hosted runner of its own) it fails instead, the wait before a round is for the
 * host's load average too, and a runner slower than the calibrated one is judged scaled to it (`judgedVerdicts`). Every round prints its figures, the reference
 * at both ends and inside, quiet or loaded, the limits, the wait and the load. The budget never moves.
 */
const ROUNDS = 3;
const QUIET_WAIT_MS = 45_000;
/** The run's quietest reference: the lowest median of any window of readings. */
let quietest = Infinity;
/** One run of the fixed CPU-bound statement, in ms. */
async function refSample(): Promise<number> {
  const t = performance.now();
  await base.execute(sql`select count(*) from generate_series(1, 200000)`);
  return performance.now() - t;
}
/** A window of reference readings; its median may lower the run's quietest. */
function noted(xs: number[]): Window {
  const w = windowOf(xs);
  quietest = Math.min(quietest, w.median);
  return w;
}
/** The median of five readings, in ms. */
async function referenceMs(): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < 5; i++) xs.push(await refSample());
  return noted(xs).median;
}
async function quietClock(): Promise<{ ref: number; waited: number }> {
  const t0 = Date.now();
  let ref = await referenceMs();
  // Where the budget must be judged, the wait is for the host's load too (the seeding's own load decays over a minute).
  const busy = () => ref > quietest * QUIET_RATIO || (MUST_JUDGE && loadavg()[0]! > clockOf(quietest, CPUS).load);
  while (busy() && Date.now() - t0 < QUIET_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 1_000));
    ref = await referenceMs();
  }
  return { ref, waited: Date.now() - t0 };
}
const fixed = (n: number): string => n.toFixed(1);
const CPUS = availableParallelism();
const MUST_JUDGE = mustJudge();
const clockNow = () => (MUST_JUDGE ? judgedClockOf : clockOf)(quietest, CPUS);
/** `fixedOf` names a figure's round-trip wait in ms (`latent`'s timers), left unscaled where it must judge. */
async function bestOfRounds(label: string, round: (tick: () => Promise<void>) => Promise<Record<string, number>>, fixedOf: (figure: string) => number = () => 0): Promise<Record<string, Verdict>> {
  const verdictsOf = (rounds: Round[]) => (MUST_JUDGE
    ? judgedVerdicts(rounds, BUDGET_MS, quietest, CPUS, Object.fromEntries(Object.keys(rounds[0]!.figures).map((k) => [k, fixedOf(k)])))
    : verdicts(rounds, BUDGET_MS, clockOf(quietest, CPUS)));
  const rounds: Round[] = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const before = await quietClock();
    const loadBefore = loadavg()[0]!;
    const inside: number[] = [];
    const figures = await round(async () => { inside.push(await refSample()); });
    const after = await referenceMs();
    const r: Round = { before: before.ref, after, during: noted(inside), load: Math.max(loadBefore, loadavg()[0]!), figures };
    rounds.push(r);
    const clock = clockNow();
    console.log(`search-budget ${label} round ${i}/${ROUNDS} ${isQuiet(r, clock) ? "quiet" : "loaded"} ref ${fixed(before.ref)}/${fixed(after)} ms, `
      + `inside median ${fixed(r.during.median)} p95 ${fixed(r.during.p95)} of ${inside.length} (limit ${fixed(clock.limit)}, spike ${fixed(clock.spike)}, `
      + `quietest ${fixed(quietest)}, waited ${before.waited} ms) `
      + `load ${r.load.toFixed(2)} (limit ${clock.load} on ${CPUS} CPUs): ${Object.entries(figures).map(([k, v]) => `${k} ${v} ms`).join(", ")}`);
    if (Object.values(verdictsOf(rounds)).every((v) => v.kind === "within")) break;
  }
  return verdictsOf(rounds);
}
/** A figure inside the budget, or over it on a quiet round (red); over on no quiet round warns, or fails where it must be judged. */
function judge(v: Verdict, what: string): void {
  const clock = clockNow();
  const limits = `limit ${fixed(clock.limit)} ms, spike ${fixed(clock.spike)} ms, load limit ${clock.load} on ${CPUS} CPUs, the run's quietest reference ${fixed(quietest)} ms`
    + (MUST_JUDGE ? `, figures less their round trip scaled by ${scaleOf(quietest).toFixed(3)} to the calibrated ${CALIBRATED_REF_MS} ms reference` : "");
  if (outcomeOf(v, MUST_JUDGE) === "skipped-loaded") {
    console.log(`::warning title=search budget SKIPPED-LOADED::${what} p95 ${v.ms} ms over ${BUDGET_MS} ms with no quiet round (${limits}): not judged on this host`);
    return;
  }
  const how = v.kind === "unjudged" ? `with no quiet round (${limits}) on a host that must judge the budget (OHMAIL_BUDGET_MUST_JUDGE=1)`
    : v.kind !== "over" ? `the best of ${ROUNDS} rounds`
    : v.round ? `on a quiet round (reference ${fixed(v.round.before)}/${fixed(v.round.after)} ms, inside ${fixed(v.round.during.median)}/${fixed(v.round.during.p95)} ms, `
      + `limit ${fixed(clock.limit)}/${fixed(clock.spike)} ms, load ${v.round.load.toFixed(2)} of ${clock.load}): search over budget`
    : `past ${LOADED_CEILING * BUDGET_MS} ms with no quiet round, slower than load alone has ever read: search over budget`;
  expect(v.ms, `${what} p95 ${how}${MUST_JUDGE ? ` (${limits})` : ""}`).toBeLessThanOrEqual(BUDGET_MS);
}

describe("the first page of a search is milliseconds (real Postgres, a large mailbox)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    await ensureSearchExtensions(base, { concurrently: false });
    await ensureHotPathIndexes(base, { concurrently: false });
    await base.execute(sql`set max_parallel_workers_per_gather = 0`);
    // The seed's statements write tens of thousands of rows each; the box's 55 s statement ceiling is for tests.
    await base.execute(sql`set statement_timeout = '600s'`);
    // Fixed account ids: a run that died before its afterAll left these rows, so they go first.
    await removeSeeded();
    await seed(A, N);
    await seedDocumented(D, N, D_SALT);
    await seedDocumented(NOISE, 20_000, NOISE_SALT);
    // Built over the seeded documents, as setup builds them over a live store; D and the neighbour then
    // carry their dates mark (mail 0174) and are read by month, A (before its backfill) never is.
    await ensureWordIndex(base, { concurrently: false });
    await ensureDatedIndexes(base, { concurrently: false });
    for (const acct of [D, NOISE]) expect(await searchDatesFillPass({ db: base as never, accountId: acct, limit: 1_000_000 })).toMatchObject({ marked: true });
    // Settled as production's are: a vacuumed `messages` lets the History index answer without the
    // heap (fresh rows have no visibility map). The bodies are only analyzed: the page never scans
    // them, and their vacuum is a minute of disk here.
    // MESSAGE_SEARCH'S STATISTICS ARE THE WHOLE TABLE, so the harness's plans are the same every
    // run. ANALYZE reads a random sample of 300 x the target rows; at the default 100 that is
    // 30,000 of message_search's ~94,000, and on the same mailbox the same common query's page read
    // 32,069 shared buffers in one run and 11,986 in another, a different plan from a different
    // sample. At 1000 the sample is every row: over four runs of the pinned mailbox, each on a
    // database made from empty, every query read the same buffers to within ten, and the heaviest
    // kept its heavy plan (32,069), so the worst case is what is held. ONLY this table: whole-table
    // statistics on `messages` as well moved A's own pages onto slower plans (w1 p50 19 to 28 ms
    // here, w3000 at 8 ms a statement to 102-107 ms on CI's slowest runners), which measures a
    // planner state production does not have rather than the search.
    for (const t of ["messages", "message_search", "folder_state"]) {
      await base.execute(t === "message_search" ? sql`set default_statistics_target = 1000` : sql`reset default_statistics_target`);
      await base.execute(sql.raw(`vacuum (parallel 0, analyze) ${t}`));
    }
    await base.execute(sql`reset default_statistics_target`);
    await base.execute(sql`analyze message_bodies`);
    for (const h of HARNESS) {
      if (h.of !== undefined) {
        let q = h.of;
        for (const [m, k] of h.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k)));
        h.q = q;
      }
      h.q = h.q ?? (await vocabWord(h.k!));
    }
    await base.execute(sql`reset statement_timeout`);
    for (let i = 0; i < 5; i++) {
      const xs: number[] = [];
      for (let j = 0; j < 20; j++) xs.push(await refSample());
      noted(xs);
    }
  }, 900_000);

  afterAll(async () => {
    await base.execute(sql`set statement_timeout = '600s'`);
    await removeSeeded();
    await client.end({ timeout: 5 });
  }, 900_000);

  for (const q of ["w1", "w40", "w3000", "axa", "w100", "myax"]) {
    it(`"${q}": the first page inside ${BUDGET_MS} ms at p95, and no statement scans a table`, async () => {
      const svc = new SearchService();
      await svc.search(ctx(), { q, parts: "page" });
      const best = await bestOfRounds(q, async (tick) => {
        const ms: number[] = [];
        for (let i = 0; i < 20; i++) {
          ms.push((await svc.search(ctx(), { q, parts: "page" })).ms);
          await tick();
        }
        ms.sort((a, b) => a - b);
        return { p50: ms[10]!, p95: ms[18]! };
      });
      console.log(`search-budget ${q}: total ${(await svc.search(ctx(), { q, parts: "page" })).total}`);
      judge(best.p95!, `${q} page`);

      seen.length = 0;
      const r = await svc.search(ctx(), { q, parts: "page" });
      expect(r.tier).toBe("exact");
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.facets).toBeNull();
      const session = seen.filter(isSession);
      const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
      expect(reads.length, "the page's statements were not recorded").toBeGreaterThan(0);
      for (const st of reads) expect(await seqScans(st, session)).toEqual([]);
    }, 600_000);
  }

  // Two words on A before its backfill: the older columns are read per part, each off its own GIN.
  it(`before the backfill, two words answer page and count inside ${BUDGET_MS} ms at p95 and scan no table`, async () => {
    const svc = new SearchService();
    const QS = ["w3000 w1", "w2000 w2500"];
    for (const q of QS) await svc.search(ctx(), { q, parts: "page" });
    const best = await bestOfRounds("before two words", async (tick) => {
      const figures: Record<string, number> = {};
      for (const q of QS) {
        const page: number[] = [];
        const count: number[] = [];
        for (let i = 0; i < 20; i++) {
          page.push((await svc.search(ctx(), { q, parts: "page" })).ms);
          count.push((await svc.search(ctx(), { q, parts: "estimate" })).ms);
          await tick();
        }
        figures[`${q} page`] = p95Of(page);
        figures[`${q} count`] = p95Of(count);
      }
      return figures;
    });
    for (const [k, v] of Object.entries(best)) judge(v, k);
    for (const q of QS) {
      seen.length = 0;
      await svc.search(ctx(), { q, parts: "page" });
      const session = seen.filter(isSession);
      for (const st of seen.filter((x) => !isSession(x) && !isExplain(x))) expect(await seqScans(st, session), q).toEqual([]);
    }
  }, 600_000);

  it(`with an 8 ms round trip a statement, the first page still answers inside ${BUDGET_MS} ms at p95`, async () => {
    const svc = new SearchService();
    const count = { n: 0 };
    // Production's client over the same database: the pooler's `prepare: false`, four connections.
    const pooled = postgres(PG_URL, { max: 4, prepare: false, connection: { max_parallel_workers_per_gather: 0 } });
    const far = latent(brandDialect(drizzle(pooled, { schema }), "pg") as object, RTT_MS, count);
    const at = { ...ctx(), db: far as never };
    const QS = ["w1", "w40", "w3000", "axa", "w100", "myax"];
    for (const q of QS) await svc.search(at, { q, parts: "page" });
    // The fewest statements any read of a query paid: the round trip every one of them waited.
    const fewest: Record<string, number> = {};
    const best = await bestOfRounds("far", async (tick) => {
      const p95: Record<string, number> = {};
      for (const q of QS) {
        const ms: number[] = [];
        for (let i = 0; i < 20; i++) {
          count.n = 0;
          ms.push((await svc.search(at, { q, parts: "page" })).ms);
          fewest[q] = Math.min(fewest[q] ?? Infinity, count.n);
          await tick();
        }
        p95[q] = p95Of(ms);
      }
      return p95;
    }, (q) => RTT_MS * fewest[q]!);
    console.log(`search-budget far: ${count.n} statements a page`);
    await pooled.end({ timeout: 5 });
    for (const q of QS) judge(best[q]!, `far ${q}`);
  }, 600_000);

  // Each query is read as the median of five passes (a load spike on this host moves one pass, a
  // slow shape all five); a class's p95 is over its queries' medians, and the five passes are one
  // round of bestOfRounds. Red when a cut page asks the planner again (6-7 statements) or the typo
  // word is hidden from the planner (a broad typo's page, 220 ms).
  it(`the query harness in production's shape: every class's page and count inside ${BUDGET_MS} ms at p95, 8 ms a statement`, async () => {
    const svc = new SearchService();
    const count = { n: 0 };
    const pooled = postgres(PG_URL, { max: 4, prepare: false, connection: { max_parallel_workers_per_gather: 0 } });
    const far = latent(brandDialect(drizzle(pooled, { schema }), "pg") as object, RTT_MS, count);
    const at = { ...ctx(D), db: far as never };
    for (const h of HARNESS) await svc.search(at, { q: h.q!, parts: "page" });
    // The same pages with no round trip: the database's and the service's own share of the budget.
    const near = HARNESS.map(() => [] as number[]);
    for (let pass = 0; pass < 3; pass++) for (const [i, h] of HARNESS.entries()) near[i]!.push((await svc.search(ctx(D), { q: h.q!, parts: "page" })).ms);
    const CLASSES = ["common", "mid", "rare", "none", "typo"] as const;
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    // Every round's answers and statement counts, for the class's shape: a round is judged whole.
    const seenOf = HARNESS.map(() => ({ statements: [] as number[], counts: [] as number[], items: [] as number[] }));
    const best = await bestOfRounds("harness", async (tick) => {
      const reads = HARNESS.map(() => ({ page: [] as number[], count: [] as number[] }));
      for (let pass = 0; pass < 5; pass++) {
        for (const [i, h] of HARNESS.entries()) {
          count.n = 0;
          const page = await svc.search(at, { q: h.q!, parts: "page" });
          seenOf[i]!.statements.push(count.n);
          reads[i]!.page.push(page.ms);
          seenOf[i]!.items.push(page.tier === "exact" ? page.items.length : -page.items.length);
          count.n = 0;
          reads[i]!.count.push((await svc.search(at, { q: h.q!, parts: "estimate" })).ms);
          seenOf[i]!.counts.push(count.n);
          await tick();
        }
      }
      // Each query's page and count medians, so a red class names the query that made it.
      console.log(`search-budget harness by query: ${HARNESS.map((h, i) => `${h.of ?? h.q} ${median(reads[i]!.page)}/${median(reads[i]!.count)}`).join(", ")}`);
      const figures: Record<string, number> = {};
      for (const cls of CLASSES) {
        const of = reads.filter((_, i) => HARNESS[i]!.cls === cls);
        figures[`${cls} page`] = p95Of(of.map((r) => median(r.page)));
        figures[`${cls} count`] = p95Of(of.map((r) => median(r.count)));
      }
      return figures;
    }, (figure) => {
      const [cls, part] = figure.split(" ");
      return RTT_MS * Math.min(...seenOf.filter((_, i) => HARNESS[i]!.cls === cls).flatMap((r) => (part === "page" ? r.statements : r.counts)));
    });
    await pooled.end({ timeout: 5 });
    for (const cls of CLASSES) {
      const of = seenOf.filter((_, i) => HARNESS[i]!.cls === cls);
      const statements = of.flatMap((r) => r.statements);
      console.log(`search-budget harness ${cls}: page p95 ${best[`${cls} page`]!.ms} ms (margin ${BUDGET_MS - best[`${cls} page`]!.ms}), `
        + `count p95 ${best[`${cls} count`]!.ms} ms, the best of ${ROUNDS} rounds; statements ${Math.min(...statements)}-${Math.max(...statements)}, `
        + `no round trip p95 ${p95Of(near.filter((_, i) => HARNESS[i]!.cls === cls).flat())} ms`);
      // The class is what the harness says it is: a full exact page, a short one, none, guesses.
      const items = of.flatMap((r) => r.items);
      const shaped = cls === "common" || cls === "mid" ? items.every((n) => n === 50) : cls === "rare" ? items.every((n) => n > 0 && n < 50)
        : cls === "none" ? items.every((n) => n === 0) : items.every((n) => n < 0);
      expect(shaped, `${cls}: the answers are not this class's`).toBe(true);
      expect(Math.max(...statements), `${cls} statements`).toBeLessThanOrEqual(PAGE_STATEMENTS[cls]);
      judge(best[`${cls} page`]!, `${cls} page`);
      judge(best[`${cls} count`]!, `${cls} count`);
    }
  }, 600_000);

  /**
   * OLDEST FIRST, TIMED, in production's shape: the first page on D, read by month, for every harness query of
   * one word (beside an excluded word, for words across a letter's parts, and in every other order the search
   * reads 0.30.19's own statement); the p95 over its queries' medians inside the budget, 8 ms a statement.
   */
  it(`oldest first in production's shape: the first page inside ${BUDGET_MS} ms at p95, 8 ms a statement`, async () => {
    const svc = new SearchService();
    const count = { n: 0 };
    const pooled = postgres(PG_URL, { max: 4, prepare: false, connection: { max_parallel_workers_per_gather: 0 } });
    const far = latent(brandDialect(drizzle(pooled, { schema }), "pg") as object, RTT_MS, count);
    const at: ServiceContext = { ...ctx(D), db: far as never };
    const QS = HARNESS.filter((h) => h.cls !== "typo" && ONE_WORD.test(h.q!));
    type Case = { figure: string; sort: "date_asc"; q: string };
    const cases: Case[] = QS.map((h) => ({ figure: "date_asc", sort: "date_asc", q: h.q! }));
    const ask = (c: Case) => svc.search(at, { q: c.q, parts: "page", sort: c.sort });
    for (const c of cases) await ask(c);
    const fewest: Record<string, number> = {};
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const best = await bestOfRounds("orders", async (tick) => {
      const ms = cases.map(() => [] as number[]);
      for (let pass = 0; pass < 3; pass++) {
        for (const [i, c] of cases.entries()) {
          count.n = 0;
          ms[i]!.push((await ask(c)).ms);
          fewest[c.figure] = Math.min(fewest[c.figure] ?? Infinity, count.n);
          await tick();
        }
      }
      console.log(`search-budget orders by case: ${cases.map((c, i) => `${c.figure} ${c.q} ${median(ms[i]!)}`).join(", ")}`);
      const figures: Record<string, number> = {};
      for (const figure of new Set(cases.map((c) => c.figure))) figures[figure] = p95Of(cases.flatMap((c, i) => (c.figure === figure ? [median(ms[i]!)] : [])));
      return figures;
    }, (figure) => RTT_MS * fewest[figure]!);
    await pooled.end({ timeout: 5 });
    for (const [figure, v] of Object.entries(best)) judge(v, `order ${figure}`);
  }, 600_000);

  /**
   * FIRST ASKS: every harness query asked once a round, with no warm-up, on a new pool and a new service
   * each round (nothing it remembers per handle), in production's shape; each class's p95 inside the budget.
   */
  it(`every harness query asked once, with no warm-up: every class's page inside ${BUDGET_MS} ms at p95, 8 ms a statement`, async () => {
    const CLASSES = ["common", "mid", "rare", "none", "typo"] as const;
    const fewest: Record<string, number> = {};
    const best = await bestOfRounds("first asks", async (tick) => {
      const count = { n: 0 };
      const pooled = postgres(PG_URL, { max: 4, prepare: false, connection: { max_parallel_workers_per_gather: 0 } });
      const far = latent(brandDialect(drizzle(pooled, { schema }), "pg") as object, RTT_MS, count);
      const svc = new SearchService();
      const ms: Record<string, number[]> = {};
      for (const h of HARNESS) {
        count.n = 0;
        (ms[h.cls] ??= []).push((await svc.search({ ...ctx(D), db: far as never }, { q: h.q!, parts: "page" })).ms);
        fewest[h.cls] = Math.min(fewest[h.cls] ?? Infinity, count.n);
        await tick();
      }
      await pooled.end({ timeout: 5 });
      return Object.fromEntries(CLASSES.map((cls) => [`${cls} first`, p95Of(ms[cls] ?? [0])]));
    }, (figure) => RTT_MS * fewest[figure.split(" ")[0]!]!);
    for (const [figure, v] of Object.entries(best)) judge(v, figure);
  }, 600_000);

  it("the harness's page reads scan no table in production's shape either", async () => {
    const svc = new SearchService();
    for (const h of HARNESS) {
      seen.length = 0;
      await svc.search(ctx(D), { q: h.q!, parts: "page" });
      const session = seen.filter(isSession);
      const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
      expect(reads.length, `${h.q}: the page's statements were not recorded`).toBeGreaterThan(0);
      for (const st of reads) expect(await seqScans(st, session), h.q).toEqual([]);
    }
  }, 300_000);

  // The corpus's two sides, each read off its own trigram index: a part of a sender's address (`unlin` inside
  // `dunlin`, in a few letters, read whole as 0.30.19 reads it) through the header text's, a fragment of a scan's
  // file name through the names' (read by month, off its dated twin).
  it("the substring arm reads the header text's own index, and a file name's fragment the names' own index", async () => {
    const svc = new SearchService();
    for (const [q, index] of [["unlin", "message_search_head_terms_trgm_idx"], ["can0102", "message_search_dated_names_trgm_idx"]] as const) {
      seen.length = 0;
      const r = await svc.search(ctx(D), { q, parts: "page" });
      expect({ q, tier: r.tier, found: r.items.length > 0 }).toEqual({ q, tier: "exact", found: true });
      const session = seen.filter(isSession);
      const read = new Set<string>();
      for (const st of seen.filter((x) => !isSession(x) && !isExplain(x))) {
        for (const p of await planNodes(st, session)) if (p["Index Name"] !== undefined && Number(p["Actual Loops"]) > 0) read.add(String(p["Index Name"]));
      }
      expect([...read], `${q}: ${[...read].join(", ")}`).toContain(index);
    }
  }, 300_000);

  /**
   * THE ADDRESS ARM BY RECIPIENT (mail 0154) on A's N messages: the own address in To of every
   * one (the dense walk), a rare contact (the index read), a mid one, `any` over the own address,
   * and `from` as the control. The whole answer — count, page and its rows — inside the budget at
   * p95; the same statements a page as `from`; no statement scans a table.
   */
  const ADDRESS_CLASSES = [
    { cls: "to rare", address: RARE, direction: "to", total: 25 },
    { cls: "to mid", address: MID, direction: "to", total: 1480 },
    { cls: "to own", address: OWN, direction: "to", total: N },
    { cls: "any own", address: OWN.toLowerCase(), direction: "any", total: N },
    { cls: "any rare", address: RARE, direction: "any", total: 25 },
    { cls: "from", address: "news@axa.example", direction: "from", total: 222 },
  ] as const;

  it(`the address arm, every direction, answers inside ${BUDGET_MS} ms at p95 and scans no table`, async () => {
    const svc = new SearchService();
    const count = { n: 0 };
    const counting = latent(base as object, 0, count);
    const at = { ...ctx(), db: counting as never };
    const statements: Record<string, number> = {};
    for (const c of ADDRESS_CLASSES) {
      count.n = 0;
      const r = await svc.searchByAddress(at, { address: c.address, direction: c.direction });
      statements[c.cls] = count.n;
      // Exact up to 10,000 letters; past it "at least 10,000".
      expect({ total: r.total, exact: r.totalExact ?? true }, c.cls).toEqual({ total: Math.min(c.total, 10_000), exact: c.total <= 10_000 });
      expect(r.items.length, c.cls).toBe(Math.min(50, c.total));
      expect(r.direction).toBe(c.direction);
    }
    // The same round trips a page whatever the direction: begin, settings, count, commit, page, rows.
    for (const c of ADDRESS_CLASSES) expect(statements[c.cls], `${c.cls} statements`).toBe(statements.from);
    expect(statements.from).toBeLessThanOrEqual(6);
    const best = await bestOfRounds("address", async (tick) => {
      const figures: Record<string, number> = {};
      for (const c of ADDRESS_CLASSES) {
        const ms: number[] = [];
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          await svc.searchByAddress(ctx(), { address: c.address, direction: c.direction });
          ms.push(Math.round(performance.now() - t));
          await tick();
        }
        figures[c.cls] = p95Of(ms);
      }
      return figures;
    });
    for (const c of ADDRESS_CLASSES) {
      judge(best[c.cls]!, c.cls);
    }
    for (const c of ADDRESS_CLASSES) {
      seen.length = 0;
      await svc.searchByAddress(ctx(), { address: c.address, direction: c.direction });
      const session = seen.filter(isSession);
      const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
      expect(reads.length).toBeGreaterThan(0);
      for (const st of reads) expect(await seqScans(st, session), c.cls).toEqual([]);
    }
  }, 600_000);

  // Every count on an account still building reads its progress: only that account's documents.
  it("the backfill's progress reads only the account's own search documents", async () => {
    for (const [acct, done, most] of [[A, 0, 0], [D, N, N]] as const) {
      seen.length = 0;
      expect(await searchIndexProgress(db as never, acct)).toEqual({ done, total: N });
      expect(seen).toHaveLength(1);
      const nodes = await planNodes(seen[0]!, [pgDialect().search.searchSession({ preferIndexes: true })!]);
      const read = nodes.filter((p) => p["Relation Name"] === "message_search")
        .reduce((n, p) => n + (Number(p["Actual Rows"]) + Number(p["Rows Removed by Filter"] ?? 0)) * Number(p["Actual Loops"]), 0);
      expect(read, acct === A ? "A" : "D").toBeLessThanOrEqual(most);
    }
  }, 300_000);

  it("a broad page says its total is a lower bound, the summary says at least its cap, a rare word's is exact", async () => {
    const svc = new SearchService();
    const page = await svc.search(ctx(), { q: "w1", parts: "page" });
    expect(page.totalExact).toBe(false);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    // No count is read from planner statistics, which cover every account's mail.
    expect("totalEstimate" in page).toBe(false);
    const summary = await svc.search(ctx(), { q: "w1", parts: "summary" });
    expect(summary.items).toEqual([]);
    expect({ total: summary.total, exact: summary.totalExact }).toEqual({ total: 2_000, exact: false });
    expect(summary.facets, "past the cap the estimate's facets stand").toBeNull();
    const rare = await svc.search(ctx(D), { q: "osprey", parts: "summary" });
    expect({ total: rare.total, exact: rare.totalExact }).toEqual({ total: 4, exact: true });
  }, 300_000);

  /**
   * THE READS THAT GREW WITH THE MATCHES: the summary, newest first (a query with no excluded word), oldest
   * first for one word (read by month) and the address view each read at most 30,000 shared buffers a
   * statement (hit or read, from the statement's own plan as it ran), whatever the word's reach. Before the
   * caps a broad word's summary or date order read about a million buffers (4-8 s cold), and the own address's
   * count every letter; before mail 0174 oldest first read every match. Oldest first for words across a
   * letter's parts, the sender and mailbox orders and the date orders beside an excluded word read every match,
   * as before.
   */
  it("the summary, newest and oldest first and the address view read at most 30,000 buffers a statement", async () => {
    const svc = new SearchService();
    const BUFFERS = 30_000;
    const over: string[] = [];
    let heaviest = { label: "", n: 0 };
    const measure = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      seen.length = 0;
      await run();
      const session = seen.filter(isSession);
      for (const st of seen.filter((x) => !isSession(x) && !isExplain(x))) {
        const n = await buffersOf(base, st, session);
        if (n > heaviest.n) heaviest = { label, n };
        if (n > BUFFERS) over.push(`${label} ${n}`);
      }
    };
    for (const h of HARNESS) await measure(`summary ${h.of ?? h.q}`, () => svc.search(ctx(D), { q: h.q!, parts: "summary" }));
    const NEWEST = HARNESS.filter((h) => h.cls !== "typo").filter((_, i) => i % 3 === 0).filter((h) => !/(^|\s)-\S/.test(h.q!));
    for (const h of NEWEST) await measure(`date_desc ${h.of ?? h.q}`, () => svc.search(ctx(D), { q: h.q!, parts: "page", sort: "date_desc" }));
    const OLDEST = HARNESS.filter((h) => h.cls !== "typo" && ONE_WORD.test(h.q!));
    for (const h of OLDEST) await measure(`date_asc ${h.of ?? h.q}`, () => svc.search(ctx(D), { q: h.q!, parts: "page", sort: "date_asc" }));
    for (const c of ADDRESS_CLASSES) await measure(`address ${c.cls}`, () => svc.searchByAddress(ctx(), { address: c.address, direction: c.direction }));
    console.log(`search-budget buffers: heaviest ${heaviest.label} ${heaviest.n}; ${over.length === 0 ? "every statement within" : over.join(", ")}`);
    expect(over, `statements over ${BUFFERS} buffers`).toEqual([]);
    // Broad: the summary says at least its cap; the date order is still in order.
    const broad = await svc.search(ctx(D), { q: HARNESS[0]!.q!, parts: "summary" });
    expect({ total: broad.total, exact: broad.totalExact }).toEqual({ total: 2_000, exact: false });
    const dated = await svc.search(ctx(D), { q: HARNESS[0]!.q!, parts: "page", sort: "date_desc" });
    const dates = dated.items.map((m) => Date.parse(m.date!));
    expect(dates).toHaveLength(50);
    expect([...dates].sort((x, y) => y - x)).toEqual(dates);
  }, 600_000);
});

/**
 * READ BY MONTH, NEVER MORE THAN 0.30.19 ON ITS OWN INDEXES, AND ITS ANSWERS. On 40,000 letters two hours apart:
 * FIRSTBOX files the even letters in its first mailbox by address and the odd ones in a second, "quetzal" in one
 * in four, all in the second, and "veil" in every body but every 997th; SPARSE has four letters in ten from its
 * first sender by address, "zorilla" in one in 97 of those and in every tenth letter of the rest. WALKS has 20,000
 * letters, one in ten from its first sender: "alpha" is in that sender's newest 40 only, "beta" in every 18th of
 * its letters and "gamma" in every 8th, each in one in four of the rest; "delta" is in 34 letters, "qwyxz" in none.
 * KIWI has 30,000 letters with long bodies, one in ten from its first sender and in its first mailbox: "kiwi" is
 * in 14 of that sender's newest 256 letters and 6 of the next 256, in none after, and in every 18th of the rest,
 * with "zebra" in one in four of those. Every subject holds "item" and "lorem" and every body "body" and "ipsum",
 * so "lorem -ipsum" and "item -body" leave no letter and "lorem -veil" a few; "alpah" and "kiwii" match no letter
 * and are answered by the closest words. Each question is answered read by
 * month (the four dated indexes valid, the dates mark written) and again on 0.30.19's own index set (the dated
 * indexes dropped, so every read is 0.30.19's own statement): relevance, newest and oldest first and the sender
 * and mailbox orders page after page, the estimate and the summary answer alike, and read by month each reads at
 * most the shared buffers it read there, every statement replayed under its own session, on a handle that has
 * asked once already (a server's handle keeps what it learnt of its store).
 */
describe("read by month, every answer is 0.30.19's and reads at most its buffers on 0.30.19's indexes (real Postgres)", () => {
  // Its own connection: the suite above ends the file's.
  const own = postgres(PG_URL, { max: 1 });
  const on = brandDialect(drizzle(own, { schema }), "pg");
  const NOW = new Date("2026-09-23T12:00:00Z");
  const FIRSTBOX = "5eed0000-0000-4000-8000-0000000000f6";
  const SPARSE = "5eed0000-0000-4000-8000-0000000000f7";
  const WALKS = "5eed0000-0000-4000-8000-0000000000f8";
  const KIWI = "5eed0000-0000-4000-8000-0000000000f9";
  const g = sql`g`;

  /** `n` letters two hours apart, newest first by g, with their bodies, folders and search documents. */
  async function seedShaped(acct: string, o: { n: number; boxes: string[]; box: (ids: string[]) => SQL; from: SQL; subject: SQL; body: SQL }): Promise<void> {
    const ids: string[] = [];
    for (const name of o.boxes) {
      const [mb] = await on.insert(mailboxes).values({ accountId: acct, provider: "imap", address: `${name}-${acct.slice(-4)}@shaped.example` }).returning();
      ids.push(mb!.id);
    }
    await on.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select ${idOf(acct, g)}, ${acct}::uuid, ${o.box(ids)}, 'h', 'shaped:' || ${acct} || ':' || g, ${o.subject}, ${o.from},
        ${NOW.toISOString()}::timestamptz - make_interval(hours => g * 2), g % 3 = 0, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(1, ${o.n}) g`);
    await on.execute(sql`insert into message_bodies (message_id, text)
      select m.id, ${o.body} from messages m cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x where m.account_id = ${acct}::uuid`);
    await on.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${acct}::uuid`);
    await on.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id,
        setweight(to_tsvector('english', coalesce(m.subject, '')), 'A') || setweight(to_tsvector('simple', m.from_address), 'B'),
        to_tsvector('english', b.text), left(lower(trim(coalesce(m.subject, '') || ' ' || m.from_address)), 2048), 'text'
      from messages m join message_bodies b on b.message_id = m.id where m.account_id = ${acct}::uuid`);
    await on.execute(sql`insert into account_settings (account_id, search_index_built_at) values (${acct}::uuid, ${NOW.toISOString()}::timestamptz)
      on conflict (account_id) do update set search_index_built_at = excluded.search_index_built_at`);
  }

  async function removeShaped(): Promise<void> {
    for (const acct of [FIRSTBOX, SPARSE, WALKS, KIWI]) {
      await on.execute(sql`delete from message_search where account_id = ${acct}::uuid`);
      await on.execute(sql`delete from account_settings where account_id = ${acct}::uuid`);
      await on.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${acct}::uuid)`);
      await on.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${acct}::uuid)`);
      await on.execute(sql`delete from messages where account_id = ${acct}::uuid`);
      await on.execute(sql`delete from mailboxes where account_id = ${acct}::uuid`);
    }
  }

  /** KIWI's word: in 14 of its first sender's newest 256 letters, 6 of the next 256, none after, and every 18th of the rest. */
  const kiwi = (x: SQL): SQL => sql`((${x} % 10 = 0 and ((${x} / 10 <= 256 and (${x} / 10) % 19 = 1) or (${x} / 10 between 257 and 512 and (${x} / 10) % 40 = 1)))
    or (${x} % 10 <> 0 and ${x} % 18 = 1))`;

  beforeAll(async () => {
    await runMigrations(PG_URL);
    await ensureSearchExtensions(on, { concurrently: false });
    await ensureHotPathIndexes(on, { concurrently: false });
    await on.execute(sql`set statement_timeout = '600s'`);
    await removeShaped();
    await seedShaped(FIRSTBOX, {
      n: 40_000, boxes: ["a", "b"], box: (ids) => sql`case when ${g} % 2 = 0 then ${ids[0]}::uuid else ${ids[1]}::uuid end`,
      from: sql`'p' || (${g} % 50) || '@first.example'`,
      subject: sql`'item ' || ${g} || ' lorem' || case when ${g} % 4 = 1 then ' quetzal' else '' end`,
      body: sql`'body text ipsum' || case when x.g % 4 = 1 then ' quetzal notes' else '' end || case when x.g % 997 = 0 then '' else ' veil' end`,
    });
    await seedShaped(SPARSE, {
      n: 40_000, boxes: ["a"], box: (ids) => sql`${ids[0]}::uuid`,
      from: sql`case when ${g} % 10 < 4 then 'aa-news@sparse.example' else 'p' || (${g} % 50) || '@sparse.example' end`,
      subject: sql`'item ' || ${g} || ' lorem' || case when ${g} % 10 = 5 or (${g} % 10 < 4 and ${g} % 97 = 0) then ' zorilla' else '' end`,
      body: sql`'body text ipsum' || case when x.g % 10 = 5 or (x.g % 10 < 4 and x.g % 97 = 0) then ' zorilla seen' else '' end`,
    });
    // The first sender's letters are g = 10, 20, 30 ... newest first; the rest are split over seven senders after it.
    await seedShaped(WALKS, {
      n: 20_000, boxes: ["a"], box: (ids) => sql`${ids[0]}::uuid`,
      from: sql`case when ${g} % 10 = 0 then 'aa-first@walks.example' else 'p' || (${g} % 7) || '@walks.example' end`,
      subject: sql`'item ' || ${g} || ' lorem'
        || case when (${g} % 10 = 0 and ${g} <= 400) or (${g} % 10 <> 0 and ${g} % 4 = 1) then ' alpha' else '' end
        || case when (${g} % 10 = 0 and ${g} % 180 = 0) or (${g} % 10 <> 0 and ${g} % 4 = 3) then ' beta' else '' end
        || case when (${g} % 10 = 0 and ${g} % 80 = 0) or (${g} % 10 <> 0 and ${g} % 4 = 3) then ' gamma' else '' end
        || case when ${g} % 600 = 7 then ' delta' else '' end`,
      body: sql`'body text ipsum'`,
    });
    // Long bodies, about 250 words each, so a body's vector is stored apart as a long letter's is.
    await seedShaped(KIWI, {
      n: 30_000, boxes: ["a", "b"], box: (ids) => sql`case when ${g} % 10 = 0 then ${ids[0]}::uuid else ${ids[1]}::uuid end`,
      from: sql`case when ${g} % 10 = 0 then 'aa-first@kiwi.example' else 'p' || (${g} % 7) || '@kiwi.example' end`,
      subject: sql`'item ' || ${g} || ' lorem' || case when ${kiwi(g)} then ' kiwi' || case when ${g} % 4 = 1 then ' zebra' else '' end else '' end`,
      body: sql`'body text ipsum ' || (select string_agg('w' || ((x.g * 7919 + i * 104729) % 20000), ' ') from generate_series(1, 250) i)
        || case when ${kiwi(sql`x.g`)} then ' kiwi notes' else '' end`,
    });
    await ensureWordIndex(on, { concurrently: false });
    await ensureDatedIndexes(on, { concurrently: false });
    for (const acct of [FIRSTBOX, SPARSE, WALKS, KIWI]) expect(await searchDatesFillPass({ db: on as never, accountId: acct, limit: 1_000_000 })).toMatchObject({ marked: true });
    // Every table settled, so no autovacuum runs between the two readings: one that clears an earlier test's dead
    // rows (the large mailbox's attachments) while 0.30.19's answers are read moves what its statements read.
    await on.execute(sql.raw("vacuum (parallel 0, analyze)"));
    await on.execute(sql`reset statement_timeout`);
  }, 900_000);

  afterAll(async () => {
    await on.execute(sql`set statement_timeout = '600s'`);
    await removeShaped();
    // The test drops the dated indexes; whatever runs next on this database finds them as setup leaves them.
    await ensureDatedIndexes(on, { concurrently: false });
    await own.end({ timeout: 5 });
  }, 900_000);

  // An excluded word that leaves no letter or a few, in every order, beside the dated questions.
  const QUESTIONS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["FIRSTBOX", FIRSTBOX, ["quetzal", "lorem", "quetzal notes", "lorem -ipsum", "quetzal -notes", "quetzal -lorem", "lorem -veil"]],
    ["SPARSE", SPARSE, ["zorilla", "zorilla -seen", "lorem -ipsum", "item -body"]],
    ["WALKS", WALKS, ["alpha", "beta", "gamma", "delta", "qwyxz", "lph", "alpah", "alpha -gamma"]],
    ["KIWI", KIWI, ["kiwi", "kiw", "kiwii", "kiwi notes", "kiwi lor", "lorem kiw", "kiwi -zebra", "kiwi -lorem", "item -body"]],
  ];
  const ORDERS = [["relevance", 3], ["date_desc", 3], ["date_asc", 2], ["sender", 2], ["mailbox", 2]] as const;
  type Reading = { answer: string; buffers: number };
  /** One question's readings: each order's pages and the two counts, on a new handle and service. */
  const readingsOf = async (acct: string, q: string): Promise<Map<string, Reading>> => {
    const svc = new SearchService();
    const at: ServiceContext = { db: wrap(brandDialect(drizzle(own, { schema }), "pg")), accountId: acct, userId: null, now: () => NOW, requestId: "search-budget-month" };
    await svc.search(at, { q, parts: "page" });
    const out = new Map<string, Reading>();
    for (const [sort, pages] of ORDERS) {
      let cursor: string | undefined;
      for (let p = 1; p <= pages; p++) {
        const { out: r, buffers } = await readsOf(on, seen, () => svc.search(at, { q, parts: "page", sort, ...(cursor ? { cursor } : {}) }));
        out.set(`${sort} ${p}`, { answer: JSON.stringify({ tier: r.tier, ids: r.items.map((m) => m.id), next: r.nextCursor, bounded: r.bounded }), buffers });
        cursor = r.nextCursor ?? undefined;
        if (!cursor) break;
      }
    }
    for (const parts of ["estimate", "summary"] as const) {
      const { out: r, buffers } = await readsOf(on, seen, () => svc.search(at, { q, parts }));
      out.set(parts, { answer: JSON.stringify({ tier: r.tier, total: r.total, exact: r.totalExact, facets: r.facets }), buffers });
    }
    return out;
  };

  it("every answer read by month is 0.30.19's own, and reads at most the buffers it reads there", async () => {
    const dated = new Map<string, Map<string, Reading>>();
    for (const [, acct, qs] of QUESTIONS) for (const q of qs) dated.set(`${acct} ${q}`, await readingsOf(acct, q));
    for (const spec of DATED_INDEX_SPECS) await on.execute(sql.raw(`drop index if exists "${spec.name}"`));
    const wrong: string[] = [];
    for (const [name, acct, qs] of QUESTIONS) {
      for (const q of qs) {
        const was = await readingsOf(acct, q);
        const now = dated.get(`${acct} ${q}`)!;
        console.log(`search-budget by month ${name} "${q}" (by month/0.30.19): ${[...was].map(([k, w]) => `${k} ${now.get(k)?.buffers ?? "-"}/${w.buffers}`).join(", ")}`);
        for (const k of new Set([...was.keys(), ...now.keys()])) {
          const w = was.get(k);
          const n = now.get(k);
          if (w === undefined || n === undefined || n.answer !== w.answer) wrong.push(`${name} "${q}" ${k}: not 0.30.19's answer`);
          else if (n.buffers > w.buffers) wrong.push(`${name} "${q}" ${k}: ${n.buffers} buffers, 0.30.19 ${w.buffers}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 1_800_000);
});
