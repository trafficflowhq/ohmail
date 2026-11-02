// @postpush: alone
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes, ensureWordIndex } from "@trafficflow/db/admin";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, throwawayDb } from "@trafficflow/db/testing";
import { SearchService, SearchTiming } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { D, D_SALT, NOISE, NOISE_SALT, isExplain, isSession, planNodes, recording, seedDocumented, vocabWord, type BudgetHandle, type PlanNode } from "./_search-budget-fixture.js";

/**
 * A COLD FIRST PAGE: after the database's cache has gone cold (production's after a few idle minutes),
 * the first relevance page of a rare word, a word nothing matches, a typo with few guesses and a rare
 * word beside an excluded word reads at most 150 blocks from outside the cache, and 12 for each row it
 * shows (dating, showing and asking it). Counted from each page statement's own plan on a fresh copy
 * of a 120,000-letter mailbox (`CREATE DATABASE ... TEMPLATE`: a new database starts with none of its
 * blocks in the cache, read 0 again in the same copy), never in milliseconds. Alone, apart from the warm
 * budget (search-budget.pg): it seeds 150,000 letters in a database of its own.
 */
const COLD_N = 120_000;
/**
 * Kinds the thin reads leave as they were, bounded at what they read before them (`reads`): two words
 * beside an excluded one 3,240, a broad typo 1,845. A typo of a word only another account holds read
 * 779 before and 10,846 with its guesses counted along the account's own index.
 */
const COLD_PAIR_READS = 3_300;
const COLD_BROAD_TYPO_READS = 1_845;
const COLD_NEIGHBOUR_READS = 300;
const COLD_KINDS: Array<{ kind: string; of: string; reads?: number; empty?: true; typo?: true }> = [
  { kind: "rare", of: "osprey" }, { kind: "none", of: "zqxjv", empty: true }, { kind: "typo", of: "heorn" }, { kind: "excluded", of: "heron -{3000}" },
  // Two words beside an excluded one, each in a few percent of the letters: held at the reads they had before the thin read.
  { kind: "excluded pair", of: "{1000} {1500} -{3000}", reads: COLD_PAIR_READS },
  // A typo of a word only another account's subjects hold: its guesses are never counted along this account's own index.
  { kind: "typo of a neighbour's word", of: "kundenkonot", reads: COLD_NEIGHBOUR_READS, empty: true, typo: true },
  { kind: "broad typo", of: "{77777}", reads: COLD_BROAD_TYPO_READS },
  // A word, `_` and one letter, found nowhere: a one-letter prefix would read every account's postings of l.
  { kind: "underscore and one letter", of: "osprey_l", empty: true },
];
/** The other account's letters, every subject leading with the word the typo misspells. */
const NEIGHBOUR = "5eed0000-0000-4000-8000-00000000000f";
const COLD_BASE_READS = 150;
const COLD_READS_A_ROW = 12;

describe("a cold first page reads a bounded number of blocks (real Postgres, 120,000 letters)", () => {
  const seedDb = throwawayDb("search_cold_seed");
  const recorded: Array<{ kind: string; page: SQL; session: SQL[]; items: number }> = [];
  const into: SQL[] = [];
  let seedClient: ReturnType<typeof postgres> | null = null;
  let seedHandle: BudgetHandle;
  const ctx = (accountId: string, db: unknown): ServiceContext =>
    ({ db: db as never, accountId, userId: null, now: () => new Date("2026-09-23T12:00:00Z"), requestId: "search-budget-cold" });
  const closeSeed = async (): Promise<void> => {
    await seedClient?.end({ timeout: 5 });
    seedClient = null;
  };
  /** The page statement and its session as the service sent them for `q`, the second time it is asked. */
  const pageOf = async (q: string): Promise<{ page: SQL; session: SQL[]; items: number }> => {
    const svc = new SearchService();
    const at = ctx(D, recording(seedHandle, into));
    await svc.search(at, { q, parts: "page" });
    into.length = 0;
    const r = await svc.search(at, { q, parts: "page" });
    const reads = into.filter((st) => !isSession(st) && !isExplain(st));
    expect(reads, q).toHaveLength(1);
    return { page: reads[0]!, session: into.filter(isSession), items: r.items.length };
  };

  beforeAll(async () => {
    await seedDb.create(runMigrations);
    seedClient = postgres(seedDb.url, { max: 1, connection: { max_parallel_workers_per_gather: 0 } });
    seedHandle = brandDialect(drizzle(seedClient, { schema }), "pg");
    await ensureSearchExtensions(seedHandle, { concurrently: false });
    await ensureHotPathIndexes(seedHandle, { concurrently: false });
    await seedHandle.execute(sql`set statement_timeout = '600s'`);
    await seedDocumented(seedHandle, D, COLD_N, D_SALT);
    await seedDocumented(seedHandle, NOISE, 20_000, NOISE_SALT);
    await seedDocumented(seedHandle, NEIGHBOUR, 10_000, "budget-neighbour", "Kundenkonto ");
    await ensureWordIndex(seedHandle, { concurrently: false });
    // Settled as search-budget.pg settles its mailboxes: `message_search`'s statistics the whole table.
    for (const t of ["messages", "message_search", "folder_state"]) {
      await seedHandle.execute(t === "message_search" ? sql`set default_statistics_target = 1000` : sql`reset default_statistics_target`);
      await seedHandle.execute(sql.raw(`vacuum (parallel 0, analyze) ${t}`));
    }
    await seedHandle.execute(sql`reset default_statistics_target`);
    await seedHandle.execute(sql`analyze message_bodies`);
    await seedHandle.execute(sql`reset statement_timeout`);
    for (const c of COLD_KINDS) {
      let q = c.of;
      for (const [m, k] of c.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k), seedHandle));
      recorded.push({ kind: c.kind, ...(await pageOf(q)) });
    }
  }, 900_000);

  afterAll(async () => {
    await closeSeed();
    await seedDb.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("search_timing names the mailbox's size in one closed word, from the catalog's statistics", async () => {
    const svc = new SearchService();
    for (const [acct, size] of [[D, "large"], [NOISE, "small"]] as const) {
      const timing = new SearchTiming();
      await svc.search({ ...ctx(acct, seedHandle), timing }, { q: "osprey", parts: "page" });
      expect(timing.fields().searchSize, acct === D ? "D" : "noise").toBe(size);
    }
  }, 120_000);

  it("a common word's first page reads no set off the word index", async () => {
    const { page, session } = await pageOf(await vocabWord(0, seedHandle));
    const nodes = await planNodes(page, session, seedHandle);
    const loops = nodes.filter((p) => p["Index Name"] === "message_search_words_idx").reduce((n, p) => n + Number(p["Actual Loops"] ?? 0), 0);
    expect(loops).toBe(0);
  }, 120_000);

  for (const c of COLD_KINDS) {
    it(`${c.kind} (${c.of}): the cold first page reads at most ${c.reads ?? `${COLD_BASE_READS} blocks and ${COLD_READS_A_ROW} a row`} from outside the cache`, async () => {
      await closeSeed();
      const { page, session, items } = recorded.find((r) => r.kind === c.kind)!;
      const clone = throwawayDb("search_cold_copy");
      const admin = postgres(Object.assign(new URL(seedDb.url), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => { /* quiet */ } });
      let top: PlanNode;
      try {
        await admin`set statement_timeout = 0`;
        await admin.unsafe(`CREATE DATABASE "${clone.name}" TEMPLATE "${seedDb.name}" STRATEGY FILE_COPY`);
        const cold = postgres(clone.url, { max: 1, connection: { max_parallel_workers_per_gather: 0 } });
        try {
          const h = brandDialect(drizzle(cold, { schema }), "pg");
          top = await h.transaction(async (tx) => {
            for (const s of session) await tx.execute(s);
            const r = (await tx.execute(sql`explain (analyze, buffers, format json) ${page}`)) as unknown as Array<Record<string, unknown>>;
            return ((r[0]!["QUERY PLAN"] as PlanNode[])[0]!)["Plan"] as PlanNode;
          });
        } finally {
          await cold.end({ timeout: 5 });
        }
      } finally {
        await admin.end({ timeout: 5 });
        await clone.drop();
      }
      const reads = Number(top["Shared Read Blocks"] ?? 0);
      console.log(`search-budget cold ${c.kind}: ${reads} blocks read for ${items} rows`);
      expect(items > 0, `${c.kind}: rows shown`).toBe(c.empty !== true);
      expect(reads, `${c.kind}: blocks read from outside the cache`).toBeLessThanOrEqual(c.reads ?? COLD_BASE_READS + COLD_READS_A_ROW * items);
      if (c.typo) {
        // The typo arm (`sa0`) reads its guesses off the trigram index: never along the account's rows.
        const arm: PlanNode[] = [];
        const walk = (n: PlanNode, inArm: boolean): void => {
          const at = inArm || n["Subplan Name"] === "CTE sa0";
          if (at) arm.push(n);
          for (const ch of (n["Plans"] as PlanNode[] | undefined) ?? []) walk(ch, at);
        };
        walk(top, false);
        expect(arm.length, "the typo arm's plan").toBeGreaterThan(0);
        const along = arm.filter((n) => (String(n["Node Type"]).startsWith("Index") && n["Index Name"] === "message_search_account_idx")
          || (n["Node Type"] === "Seq Scan" && n["Relation Name"] === "message_search"));
        expect(along.map((n) => `${String(n["Node Type"])} ${String(n["Index Name"] ?? n["Relation Name"])}`)).toEqual([]);
      }
    }, 300_000);
  }
});
