// @postpush: alone
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { availableParallelism, loadavg } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect, pgDialect } from "@trafficflow/db/dialect";
import { mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes, ensureWordIndex } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { searchIndexProgress } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { CALIBRATED_REF_MS, LOADED_CEILING, QUIET_RATIO, clockOf, isQuiet, judgedClockOf, judgedVerdicts, mustJudge, outcomeOf, scaleOf, verdicts, windowOf, type Round, type Verdict, type Window } from "./_budget-clock.js";
import {
  D, D_SALT, MATRIX_DELETED, MATRIX_REST, NOISE, NOISE_SALT, autovacuum, coldReads, draw, idOf, isExplain, isSession, matrixCells, matrixOldest,
  matrixFolderBounds, matrixOver, matrixWalk, matrixWhole, matrixWork, planNodes, plantMatrix, recording, seedDocumented, vocabWord, type MatrixBounds,
  type MatrixFilters, type PlanNode,
} from "./_search-budget-fixture.js";

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
/** The file's connection, closed while a cold copy of its database is made and opened again ({@link reconnect}). */
let client = postgres(PG_URL, { max: 1 });
let base = brandDialect(drizzle(client, { schema }), "pg");
const BUDGET_MS = 100;
const N = 74_000;
/** A's mailbox, before its backfill; `D` and its neighbour are the fixture's ({@link seedDocumented}). */
const A = "5eed0000-0000-4000-8000-00000000000a";
const A_SALT = "budget-a";

/** Every statement the service sends, as `search-budget-fixture`'s recorder sees it. */
const seen: SQL[] = [];
let db = recording(base, seen);
/** A new connection after a cold copy, with the session setting `beforeAll` gave the first. */
async function reconnect(): Promise<void> {
  client = postgres(PG_URL, { max: 1 });
  base = brandDialect(drizzle(client, { schema }), "pg");
  db = recording(base, seen);
  await base.execute(sql`set max_parallel_workers_per_gather = 0`);
}

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
    insert into message_bodies (message_id, account_id, text)
    select m.id, m.account_id, ${aWords(sql`x.g`, "b", sql`100 + (hashtext(x.g::text) & 127)`)}
    from messages m cross join lateral (select split_part(m.dedup_key, ':', 3)::int as g) x where m.account_id = ${acct}::uuid`);
  await base.execute(sql`
    insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by)
    select m.id, m.account_id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${acct}::uuid`);
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

/** The shared buffers (hit and read) a statement touched as it ran, under the session settings. */
async function buffersOf(st: SQL, session: SQL[]): Promise<number> {
  const r = (await base.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(sql`explain (analyze, buffers, format json) ${st}`);
  })) as unknown as Array<Record<string, unknown>>;
  const top = ((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode;
  return Number(top["Shared Hit Blocks"] ?? 0) + Number(top["Shared Read Blocks"] ?? 0);
}
/** The relations a statement read by a sequential scan, from its own plan, under the session settings. */
async function seqScans(st: SQL, session: SQL[]): Promise<string[]> {
  return (await planNodes(st, session, base)).filter((p) => p["Node Type"] === "Seq Scan").map((p) => String(p["Relation Name"]))
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
  // A list of words joined by `or`: one arm reads every side, not one branch a side.
  { cls: "common", of: "{0} or {2} or {5} or {40} or {100} or {300} or {1000} or {1500}" },
  ...["heron or dunlin or egret or avocet or plover or osprey or kestrel or unlin", "heron or dunlin or egret or avocet or plover or osprey or kestrel or unlin -{3000}"]
    .map((of) => ({ cls: "mid" as const, of })),
  ...["kestrel or osprey or plover or dunlin or unlin or zqxjv or quokka or xylograph", "kestrel or osprey or plover or dunlin or unlin or zqxjv or quokka or xylograph -{3000}"]
    .map((of) => ({ cls: "rare" as const, of })),
  // Parts of file names: alone and beside other words (a sender's in the last), and fragments typed with
  // their marks, which only the file names' own index reads.
  { cls: "common", q: "image001" },
  ...["pdf", "jpg", "scan", "img", "scan pdf", "invoice pdf", "invoice 2025", "{0} pdf", "{0} {1} jpg", "ice_2025-02", "img_20240"].map((of) => ({ cls: "mid" as const, of })),
  ...["heron pdf", "avocet pdf", "sender1237 pdf", "can0102"].map((of) => ({ cls: "rare" as const, of })),
  ...["zqxjv", "quokka", "xylograph"].map((q) => ({ cls: "none" as const, q })),
  { cls: "typo", k: 77_777 }, { cls: "typo", q: "heorn" },
  // Parts of words and a word beside a common excluded word: the held reads date thousands of a term's matches.
  ...["ginanas -{1}", "{200} -{1}"].map((of) => ({ cls: "mid" as const, of })),
  ...["gikena -{1}", "barir -{1}", "sonan -{1}"].map((of) => ({ cls: "rare" as const, of })),
];
/** A first page is begin, the session's settings, one read and commit; the typo tier is in that read. */
const PAGE_STATEMENTS: Record<Cls, number> = { common: 4, mid: 4, rare: 4, none: 4, typo: 4 };
/** The shape matrix on D (`_search-budget-fixture.ts`), each cell's query spelled as the harness spells its own. */
const MATRIX = matrixCells(N).map((c) => ({ ...c, q: "" }));

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
 * times the budget, which load alone has never reached; under OHMAIL_BUDGET_MUST_JUDGE=1 (search-budget.yml's nightly job
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
    // The planted documents lie where the plant wrote them: no vacuum of the server's frees space under it.
    await autovacuum(base, false);
    await seed(A, N);
    await seedDocumented(base, D, N, D_SALT);
    await seedDocumented(base, NOISE, 20_000, NOISE_SALT);
    await plantMatrix(base, D, N);
    // Built over the seeded documents, as setup builds it over a live store.
    await ensureWordIndex(base, { concurrently: false });
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
    await autovacuum(base, true);
    for (const h of HARNESS) {
      if (h.of !== undefined) {
        let q = h.of;
        for (const [m, k] of h.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k), base));
        h.q = q;
      }
      h.q = h.q ?? (await vocabWord(h.k!, base));
    }
    for (const c of MATRIX) {
      let q = c.of;
      for (const [m, k] of c.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k), base));
      c.q = q;
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
    await autovacuum(base, true);
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

  // The corpus's two sides, each read off its own trigram index: a part of a sender's address (`unlin`
  // inside `dunlin`) through the header text's, a fragment of a scan's file name through the names'.
  it("the substring arm reads the header text's own index, and a file name's fragment the names' own index", async () => {
    const svc = new SearchService();
    for (const [q, index] of [["unlin", "message_search_head_terms_trgm_idx"], ["can0102", "message_search_names_trgm_idx"]] as const) {
      seen.length = 0;
      const r = await svc.search(ctx(D), { q, parts: "page" });
      expect({ q, tier: r.tier, found: r.items.length > 0 }).toEqual({ q, tier: "exact", found: true });
      const session = seen.filter(isSession);
      const read = new Set<string>();
      for (const st of seen.filter((x) => !isSession(x) && !isExplain(x))) {
        for (const p of await planNodes(st, session, base)) if (p["Index Name"] !== undefined && Number(p["Actual Loops"]) > 0) read.add(String(p["Index Name"]));
      }
      expect([...read], q).toContain(index);
    }
  }, 300_000);

  // A typo with few guesses among thousands of trigram candidates: each candidate costs a similarity, so read once.
  it("a typo with few guesses reads the trigram index once a page", async () => {
    const svc = new SearchService();
    await svc.search(ctx(D), { q: "egrit", parts: "page" });
    seen.length = 0;
    const r = await svc.search(ctx(D), { q: "egrit", parts: "page" });
    expect(r.tier).toBe("similar");
    const session = seen.filter(isSession);
    const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
    expect(reads).toHaveLength(1);
    const nodes = await planNodes(reads[0]!, session, base);
    expect(nodes.filter((p) => p["Index Name"] === "message_search_terms_trgm_idx").reduce((n, p) => n + Number(p["Actual Loops"] ?? 0), 0)).toBe(1);
  }, 120_000);

  // A typo with thousands of guesses (`ginanasu`, about 2,000 here): its newest K are History newest first, each
  // letter asked whether it is a guess, never a join, which hashed every letter of the mailbox.
  it("a typo with thousands of guesses reads less than half the mailbox's letters off History", async () => {
    const svc = new SearchService();
    await svc.search(ctx(D), { q: "ginanasu", parts: "page" });
    seen.length = 0;
    const r = await svc.search(ctx(D), { q: "ginanasu", parts: "page" });
    expect(r.tier).toBe("similar");
    const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
    expect(reads).toHaveLength(1);
    const letters = (await planNodes(reads[0]!, seen.filter(isSession), base)).filter((p) => p["Index Name"] === "messages_account_msg_order_idx")
      .reduce((n, p) => n + (Number(p["Actual Rows"] ?? 0) + Number(p["Rows Removed by Filter"] ?? 0)) * Number(p["Actual Loops"] ?? 0), 0);
    expect(letters).toBeLessThan(N / 2);
  }, 120_000);

  /**
   * A WARM PAGE PAYS NOTHING FOR THE COLD PAGE'S GATE (search-budget-cold.pg). A statement is planned
   * each time it runs (the pooler's `prepare: false`), and the planner prices a pattern clause over the
   * column's statistics, a `<%` about 5 ms here: every first page plans its typo arm, so the arm reads
   * its guesses off the trigram index through one read. A term the gate reads off the word index is
   * the set's own read, never read again.
   */
  /** The page statement and its session as the service sent them for `q`, the second time it is asked. */
  const pageOf = async (q: string, filters?: MatrixFilters): Promise<{ page: SQL; session: SQL[] }> => {
    const svc = new SearchService();
    const opts = { q, parts: "page" as const, ...(filters ? { filters } : {}) };
    await svc.search(ctx(D), opts);
    seen.length = 0;
    await svc.search(ctx(D), opts);
    const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
    expect(reads, q).toHaveLength(1);
    return { page: reads[0]!, session: seen.filter(isSession) };
  };

  it("every first page plans at most one read of its typo arm's guesses", async () => {
    for (const h of HARNESS) {
      const { page, session } = await pageOf(h.q!);
      const reads = (await planNodes(page, session, base, false)).filter((p) => p["Index Name"] === "message_search_terms_trgm_idx");
      expect(reads.length, `${h.of ?? h.q}: reads of the typo arm's guesses`).toBeLessThanOrEqual(1);
    }
  }, 300_000);

  // The unfiltered guesses read asks the typed word as a value the planner cannot price (a `<%` over the
  // column's statistics is milliseconds of every first page's planning); the trigram index still serves it.
  it("the unfiltered read of a typo's guesses asks the trigram index for a run-time value, never the typed word", async () => {
    for (const q of ["egrit", HARNESS.find((h) => h.cls === "typo" && h.k !== undefined)!.q!]) {
      const { page, session } = await pageOf(q);
      const conds = (await planNodes(page, session, base, false))
        .filter((p) => p["Index Name"] === "message_search_terms_trgm_idx").map((p) => String(p["Index Cond"]));
      expect(conds, q).toHaveLength(1);
      expect(conds[0], q).not.toContain(q);
      expect(conds[0], q).toMatch(/InitPlan|\$\d/);
    }
  }, 120_000);

  // A word whose english and simple readings agree is asked once of the head: asked twice, the planner
  // took it for twice as common and walked 20,382 letters (97,289 buffers) for `{1}`'s page.
  it("a common word's first page reads at most the buffers it read before the head asked each form twice", async () => {
    const { page, session } = await pageOf(HARNESS.find((h) => h.cls === "common" && h.k === 1)!.q!);
    expect(await buffersOf(page, session)).toBeLessThanOrEqual(22_700);
  }, 120_000);

  it("no first page reads a term off the word index twice", async () => {
    for (const h of HARNESS) {
      const { page, session } = await pageOf(h.q!);
      const terms = (await planNodes(page, session, base))
        .filter((p) => p["Index Name"] === "message_search_words_idx" && Number(p["Actual Loops"] ?? 0) > 0).map((p) => String(p["Index Cond"]));
      expect(terms.filter((t, i) => terms.indexOf(t) !== i), `${h.of ?? h.q}: a term read twice`).toEqual([]);
    }
  }, 300_000);

  /**
   * A WORD, OR A PART OF ONE, BESIDE AN EXCLUDED WORD reads at most the shared buffers its page read before
   * the gate, to the hundred above. A held read dates a term the gate read as a set, never by a join planned
   * on the term's estimate: under the word index's key 11,922 matches of `ginana:*` were planned as 76 and
   * each dated one lookup (78,453 buffers for `ginanas -letumitu`). The base's figures are those of this
   * mailbox with the matrix's recent layouts planted in it.
   */
  const HELD_READS: ReadonlyArray<readonly [string, number]> = [
    ["ginanas -{1}", 44_000], ["{200} -{1}", 40_300], ["gikena -{1}", 40_500], ["barir -{1}", 41_700], ["sonan -{1}", 36_900],
  ];
  it("a word or a part of one beside an excluded word reads at most what its page read before the gate", async () => {
    const read: Array<readonly [string, number, number]> = [];
    for (const [of, most] of HELD_READS) {
      const { page, session } = await pageOf(HARNESS.find((h) => h.of === of)!.q!);
      read.push([of, await buffersOf(page, session), most]);
    }
    console.log(`search-budget held: ${read.map(([of, n, most]) => `${of} ${n} of ${most}`).join(", ")}`);
    for (const [of, n, most] of read) expect(n, of).toBeLessThanOrEqual(most);
  }, 300_000);

  /**
   * THE SHAPE MATRIX (`_search-budget-fixture.ts`): no page scans a table or plans a second read of its typo
   * arm's guesses, and no cell does the work the cold gate had added. Under a filter the typo arm read every
   * guess of the account before the filter: under a sender the planner reads the sender's dozen letters
   * instead of 1,500 guesses (a pair's guesses had cost 7,206 buffers where the sender's letters cost 943;
   * its bound is main's buffers and a tenth, to the hundred above, as under a date), under unread or
   * attachments the guesses were looked for along the whole History, and under a folder the folder table was
   * read a third time. Under a date the planner walks the History for a typo (5,221 buffers) on a database
   * made from empty, as CI runs this file; on one that earlier seeds have bloated it reads the guesses first
   * (10,764), main's statement both times.
   * NO SET READ WALKS PAST THE BOUND IT IS CHOSEN WITH, whatever its members' dates, and a walk is taken only where a
   * window inside its range saw members, at a rate that puts what it is asked within 60 letters a member: newest first
   * at the rate of the 2,400 letters after the newest 1,200, within twice the letters that rate assumed (`matrixWalk`);
   * oldest first, for every member those two windows did not see, at the rate of the oldest 3,600 letters, within those
   * and twice the letters assumed past them (`matrixOldest`), where that is the shorter estimate; neither past 140
   * letters a member. Where the account holds at most 60 letters a member (the catalog's estimate), History is walked
   * whole newest first instead (`matrixWhole`): here every set the matrix reads whole, sets of 1,461 to 2,400 on 74,000
   * letters, where the base walks History whole too. Anything else is dated, and the members a walk did not meet are
   * dated. A walking cell's History is bounded at the page's other History reads (`MATRIX_REST`) and that construction,
   * from the cell's layout here: a set of `s` members, `h` of the newest 1,200 letters, `j` of the 2,400 after them and
   * `o` of the oldest 3,600 (the typo arm's windows 200, the 2,400 after its newest, and the oldest 2,600). Oldest
   * first: the oldest 1,500, burst and mix, 1,497 of the oldest 3,600, 3,608 letters assumed (a typo's 2,606); the old
   * run's 1,467 (0, 0, 140), 37,723 (a typo's 43,344 at (0, 0, 88)); behindfar's 1,472 (0, 2, 151), 35,047 (a typo's
   * 37,868 at (0, 1, 101)); newestfar's 1,515 (20, 2, 93), 57,794, where the 2,400 after the newest letters' two
   * members put its 1,200 newest 1,440,000 letters away. Every other walking set walks History whole: spread, the gap,
   * the recent layouts, the late block, oldtail, sampled and newestfar's typo, so no walking cell dates its set. Walked
   * at one window's rate, or over a sample's span, behindfar's and newestfar's typos read 16,000 and 26,668 letters for
   * two and 22 guesses and then looked up 1,521 and 1,544 letters, and beside a rare excluded word behindfar, newestfar
   * and sampled looked up 1,503, 1,532 and 1,164. A subject word of the oldest letters is read by the head arm
   * through the whole History as main reads it (`mix`): there the bound is on every other arm's History (`walks`), so a
   * whole-History walk of any other arm is red. No page writes a temporary file. The same matrix on 240,000 letters is
   * search-budget-matrix.pg.
   */
  /** History whole newest first, within its construction: the whole mailbox here. */
  const whole = (members: number): number => Math.min(N, matrixWhole(members));
  const MATRIX_BOUNDS: MatrixBounds = {
    "typo old sender": { guesses: 100 }, "typo spread sender": { guesses: 100 }, "pair spread sender": { buffers: 1_100, guesses: 100 },
    "typo old unread": { history: N / 10 }, "typo spread unread": { history: N / 10 },
    "typo old attachments": { history: N / 10 }, "typo spread attachments": { history: N / 10 },
    ...matrixFolderBounds(),
    // Common words under a folder, as search-budget-matrix.pg bounds them on 240,000 letters: the page's work and about a tenth.
    "plain common Archive": { folderPasses: 0, buffers: 260_000, folderRows: 59_000 },
    "plain common Old": { folderPasses: 0, buffers: 132_000, folderRows: 20_400 },
    "plain common INBOX": { folderPasses: 0, buffers: 74_000, folderRows: 9_600 },
    "pair common Archive": { folderPasses: 0, buffers: 151_000, folderRows: 29_500 },
    "pair common Old": { folderPasses: 0, buffers: 59_100, folderRows: 5_900 },
    "pair common INBOX": { folderPasses: 0, buffers: 47_000, folderRows: 2_600 },
    "beside common Archive": { folderPasses: 0, buffers: 387_000, folderRows: 87_800 },
    "beside common Old": { folderPasses: 0, buffers: 138_300, folderRows: 15_200 },
    "beside common INBOX": { folderPasses: 0, buffers: 102_900, folderRows: 7_800 },
    "typo common Archive": { folderPasses: 0, buffers: 125_300, folderRows: 28_600 },
    "typo common Old": { folderPasses: 0, buffers: 52_500, folderRows: 9_300 },
    "typo common INBOX": { folderPasses: 0, buffers: 27_600, folderRows: 3_100 },
    "typo old dateTo": { buffers: 5_800 }, "typo spread dateTo": { buffers: 5_800 },
    "typo old none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
    "typo spread none": { history: MATRIX_REST.typo + whole(1_510), lookups: 200 },
    "typo deleted none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
    "typo gap none": { history: MATRIX_REST.typo + whole(1_483), lookups: 200 },
    "typo burst none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
    "typo mix none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
    "typo lateblock none": { history: MATRIX_REST.typo + whole(2_206), lookups: 200 },
    "typo oldthin none": { history: MATRIX_REST.typo + Math.min(N, matrixOldest(43_344, 2_600, 1_467)), lookups: 200 },
    "typo recent none": { history: MATRIX_REST.typo + matrixWalk(5_000, 2_400), lookups: 200 },
    "typo recentthin none": { history: MATRIX_REST.typo + matrixWalk(4_000, 3_598), lookups: 200 },
    "typo oldtail none": { history: MATRIX_REST.typo + whole(1_500), lookups: 200 },
    "typo behindfar none": { history: MATRIX_REST.typo + Math.min(N, matrixOldest(37_868, 2_600, 1_472)), lookups: 200 },
    "typo sampled none": { history: MATRIX_REST.typo + whole(1_513), lookups: 200 },
    "typo newestfar none": { history: MATRIX_REST.typo + whole(1_515), lookups: 200 },
    "beside old none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 200 },
    "beside spread none": { history: MATRIX_REST.beside + whole(1_510), lookups: 200 },
    "beside deleted none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 200 },
    "beside gap none": { history: MATRIX_REST.beside + whole(1_483), lookups: 200 },
    "beside burst none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 200 },
    "beside mix none": { walks: matrixOldest(3_608, 3_600, 1_500), lookups: 2_000 },
    "beside lateblock none": { history: MATRIX_REST.beside + whole(1_500), lookups: 200 },
    "beside oldthin none": { history: MATRIX_REST.beside + Math.min(N, matrixOldest(37_723, 3_600, 1_467)), lookups: 200 },
    "beside recent none": { history: MATRIX_REST.beside + whole(2_400), lookups: 200 },
    "beside recentthin none": { history: MATRIX_REST.beside + whole(1_500), lookups: 200 },
    "beside oldtail none": { history: MATRIX_REST.beside + whole(1_500), lookups: 200 },
    "beside behindfar none": { history: MATRIX_REST.beside + Math.min(N, matrixOldest(35_047, 3_600, 1_472)), lookups: 200 },
    "beside sampled none": { history: MATRIX_REST.beside + whole(1_513), lookups: 200 },
    "beside newestfar none": { history: MATRIX_REST.beside + Math.min(N, matrixOldest(57_794, 3_600, 1_515)), lookups: 200 },
    "besiderare old none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_478), lookups: 200 },
    "besiderare spread none": { history: MATRIX_REST.besiderare + whole(1_487), lookups: 200 },
    "besiderare deleted none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_478), lookups: 200 },
    "besiderare gap none": { history: MATRIX_REST.besiderare + whole(1_461), lookups: 200 },
    "besiderare burst none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_478), lookups: 200 },
    "besiderare mix none": { walks: matrixOldest(3_608, 3_600, 1_500), lookups: 2_000 },
    "besiderare lateblock none": { history: MATRIX_REST.besiderare + whole(1_482), lookups: 200 },
    "besiderare oldthin none": { history: MATRIX_REST.besiderare + Math.min(N, matrixOldest(37_800, 3_600, 1_449)), lookups: 200 },
    "besiderare oldtail none": { history: MATRIX_REST.besiderare + whole(1_476), lookups: 200 },
    "besiderare behindfar none": { history: MATRIX_REST.besiderare + Math.min(N, matrixOldest(34_848, 3_600, 1_454)), lookups: 200 },
    "besiderare sampled none": { history: MATRIX_REST.besiderare + whole(1_494), lookups: 200 },
    "besiderare newestfar none": { history: MATRIX_REST.besiderare + Math.min(N, matrixOldest(57_953, 3_600, 1_503)), lookups: 200 },
  };
  /**
   * COLD, NEVER ABOVE THE BASE: the page read once on a fresh copy of this file's database (`coldReads`, the
   * connection closed meanwhile), the blocks it reads from outside the cache at most the base's here, to the
   * hundred below. Dated where a walk meets them, the recent layouts beside a common excluded word had read 7,205
   * and 5,386 blocks (the base 4,018 and 3,663); the old run's typo and the old run beside a rare excluded word, whose
   * empty newest letters were walked before every member was dated, 3,749 and 4,221 (the base 2,314 and 2,556); walked
   * at one window's rate or over a sample's span and then dated, behindfar's and newestfar's typos 4,054 and 4,274
   * (the base 2,632 and 2,899), behindfar, newestfar and sampled beside a rare excluded word 4,496, 4,844 and 4,309
   * (2,892, 3,124 and 3,054), and sampled beside a common one 4,708 (3,925).
   */
  const MATRIX_COLD: Readonly<Record<string, number>> = {
    "beside recent none": 4_000, "beside recentthin none": 3_600, "typo oldthin none": 2_300, "besiderare oldthin none": 2_500,
    "typo behindfar none": 2_600, "typo newestfar none": 2_800, "besiderare behindfar none": 2_800, "besiderare newestfar none": 3_100,
    "besiderare sampled none": 3_000, "beside sampled none": 3_900,
  };
  it("the shape matrix: no page scans a table or reads its guesses twice, and no cell does the work the gate had added", async () => {
    const [counted] = (await base.execute(sql`select count(*)::int as n from folder_state`)) as unknown as Array<{ n: number }>;
    const read: string[] = [];
    const over: string[] = [];
    for (const c of MATRIX) {
      const { page, session } = await pageOf(c.q, c.filters);
      const f = await matrixWork(page, session, base, counted!.n);
      read.push(`${c.label} ${f.buffers}/${f.history}/${f.lookups}/${f.folderPasses}/${f.folderRows}/${f.guesses}`);
      expect(f.scans, c.label).toEqual([]);
      expect(f.guessReads, `${c.label}: reads of the typo arm's guesses`).toBeLessThanOrEqual(1);
      over.push(...matrixOver(c.label, f, MATRIX_BOUNDS), ...(f.temp > 0 ? [`${c.label} temp ${f.temp} of 0`] : []));
    }
    console.log(`search-budget matrix (buffers/History letters/lookups/folder passes/folder rows/guesses read): ${read.join(", ")}`);
    expect(over).toEqual([]);
  }, 600_000);

  it("no layout a set read had read past the base reads more blocks cold than the base", async () => {
    const pages: Array<{ label: string; page: SQL; session: SQL[] }> = [];
    for (const c of MATRIX.filter((x) => MATRIX_COLD[x.label] !== undefined)) pages.push({ label: c.label, ...(await pageOf(c.q, c.filters)) });
    // Nothing may be connected to the database while it is copied.
    await client.end({ timeout: 5 });
    const read: string[] = [];
    const over: string[] = [];
    try {
      for (const p of pages) {
        const blocks = await coldReads(PG_URL, p.page, p.session);
        read.push(`${p.label} ${blocks}`);
        if (blocks > MATRIX_COLD[p.label]!) over.push(`${p.label} ${blocks} of ${MATRIX_COLD[p.label]}`);
      }
    } finally {
      await reconnect();
    }
    console.log(`search-budget matrix cold (blocks read from outside the cache): ${read.join(", ")}`);
    expect(over).toEqual([]);
  }, 600_000);

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
    // The matrix deletes three of D's letters (`MATRIX_DELETED`): progress counts the living ones.
    const living = N - MATRIX_DELETED.length;
    for (const [acct, done, total, most] of [[A, 0, N, 0], [D, living, living, N]] as const) {
      seen.length = 0;
      expect(await searchIndexProgress(db as never, acct)).toEqual({ done, total });
      expect(seen).toHaveLength(1);
      const nodes = await planNodes(seen[0]!, [pgDialect().search.searchSession({ preferIndexes: true })!], base);
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
   * THE READS THAT GREW WITH THE MATCHES: the summary, newest first (a query with no excluded word)
   * and the address view each read at most 30,000 shared buffers a statement (hit or read, from the
   * statement's own plan as it ran), whatever the word's reach. Before the caps a broad word's summary
   * or date order read about a million buffers (4-8 s cold), and the own address's count every letter.
   * Oldest first, the sender and mailbox orders and newest first beside an excluded word read every
   * match, as before.
   */
  it("the summary, newest first and the address view read at most 30,000 buffers a statement", async () => {
    const svc = new SearchService();
    const BUFFERS = 30_000;
    const over: string[] = [];
    let heaviest = { label: "", n: 0 };
    const measure = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      seen.length = 0;
      await run();
      const session = seen.filter(isSession);
      for (const st of seen.filter((x) => !isSession(x) && !isExplain(x))) {
        const n = await buffersOf(st, session);
        if (n > heaviest.n) heaviest = { label, n };
        if (n > BUFFERS) over.push(`${label} ${n}`);
      }
    };
    for (const h of HARNESS) await measure(`summary ${h.of ?? h.q}`, () => svc.search(ctx(D), { q: h.q!, parts: "summary" }));
    const NEWEST = HARNESS.filter((h) => h.cls !== "typo").filter((_, i) => i % 3 === 0).filter((h) => !/(^|\s)-\S/.test(h.q!));
    for (const h of NEWEST) await measure(`date_desc ${h.of ?? h.q}`, () => svc.search(ctx(D), { q: h.q!, parts: "page", sort: "date_desc" }));
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
