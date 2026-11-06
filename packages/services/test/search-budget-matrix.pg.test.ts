// @postpush: alone
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureHotPathIndexes, ensureWordIndex } from "@trafficflow/db/admin";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, throwawayDb } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import {
  D, D_SALT, MATRIX_REST, NOISE, NOISE_SALT, autovacuum, coldReads, isExplain, isSession, matrixCells, matrixOldest, matrixOver, matrixWalk, matrixWork,
  matrixFolderBounds, plantMatrix, recording, seedDocumented, vocabWord, type BudgetHandle, type MatrixBounds,
} from "./_search-budget-fixture.js";

/**
 * THE SHAPE MATRIX ON 240,000 LETTERS (`_search-budget-fixture.ts`; search-budget.pg reads it on 74,000):
 * how a set's newest letters are read rests on where its members lie and on how many letters lie between,
 * so the same cells are read on a mailbox three times the size. No page scans a table or reads its typo
 * arm's guesses twice, and no set read walks past the bound it is chosen with. Its bounds under a filter are
 * search-budget.pg's, History's in tenths of these letters and buffers the base's and a tenth, to the hundred
 * above. Alone: it seeds 260,000 letters in a database of its own (the file took 7 minutes on a loaded
 * workstation, the seed most of it), and copies it nine times for the cold pages.
 */
const N = 240_000;
/**
 * NO SET READ WALKS PAST ITS BOUND (search-budget.pg says how), and no page writes a temporary file. A walking cell's
 * History is bounded at the page's other History reads (`MATRIX_REST`) and its walk as chosen (`matrixWalk` newest
 * first, `matrixOldest` oldest first), from its layout here: a set of `s` members, `h` of the newest 1,200 letters, `j`
 * of the 2,400 after them and `o` of the oldest 3,600 (the typo arm's windows 200, the 2,400 after its newest, and the
 * oldest 2,600). On 240,000 letters no set the matrix reads holds one member in 60 letters, so none walks History
 * whole: a set no window places is dated, as the base dates it. Newest first at the rate of the 2,400 letters after
 * the newest, beside a rare excluded word: spread's 1,501 (8, 15, 23), 32,000 letters assumed for 200, the gap's 1,501
 * (0, 14, 23) 34,286; the recent layouts' 2,400 (48, 96, 0) and 2,000 (12, 24, 0), 30,000 and 120,000 for 1,200 beside a
 * common excluded word, the second's 20,870 for 200 beside a rare one; the typo arm's guesses: spread's 32,000, the
 * gap's 60,000, the late block's 3,790 (1, 38, 25) 12,632, sampled's 1,507 (1, 7, 9) 68,572, newestfar's 1,515
 * (3, 18, 54) 26,667, after which it dates the guesses it did not meet. Oldest first, for every member the newest
 * windows did not see: the oldest 1,500, burst and mix, 3,608 letters assumed (a typo's 2,606), the old run's 1,467
 * (0, 0, 140) 37,723 (a typo's 43,344), behindfar's 1,472 (0, 2, 151) 35,047 (a typo's 37,868), newestfar's 1,515
 * (20, 2, 93) 57,794. Dated, their lookups every member and the rows shown and no History past the page's other
 * reads: spread's and the gap's 1,529 and 1,520 beside a common excluded word, whose next letters' rate puts 1,200 of
 * them 192,000 and 205,715 letters away, and the late block, oldtail and sampled, which no window places. Walked as one
 * window's rate put them, or over a sample's span, and then dated, oldtail's typo and oldtail beside a common and a rare
 * excluded word had read 150,000, 210,000 and 206,640 letters, newestfar and behindfar beside a common one 144,000 and
 * 92,904, sampled beside a common and a rare one 22,605 and 22,425; walked to their answers, a set of the oldest letters
 * holding deleted members read all 240,000 (a typo's 240,237 letters, 1,025 blocks on disk), one of the oldest letters
 * and one recent letter all of them newest first (242,320 beside a common excluded word).
 */
const MATRIX_BOUNDS: MatrixBounds = {
  "typo old sender": { guesses: 100 }, "typo spread sender": { guesses: 100 }, "pair spread sender": { buffers: 1_900, guesses: 100 },
  "typo old unread": { history: N / 10 }, "typo spread unread": { history: N / 10 },
  "typo old attachments": { history: N / 10 }, "typo spread attachments": { history: N / 10 },
  ...matrixFolderBounds(),
  // COMMON WORDS UNDER A FOLDER (`MATRIX_COMMON`), each the page's work and about a tenth: Archive's walk of the newest
  // 48,000 letters, and past it the index read of a common word's subject matches, each asked its folder by key; Old
  // and INBOX walk. The typo walks Archive on past that bound to its newest 200 guesses, a folder row a letter of this
  // account. Main read 0.4 to 2.1 million folder rows a cell (one to eight passes over the table), and the folder
  // filter asked of each match read up to 3.6 million buffers (a pair in Archive), 0.7-1.7 s.
  "plain common Archive": { folderPasses: 0, buffers: 326_000, folderRows: 72_300 },
  "plain common Old": { folderPasses: 0, buffers: 186_900, folderRows: 29_900 },
  "plain common INBOX": { folderPasses: 0, buffers: 195_700, folderRows: 30_100 },
  "pair common Archive": { folderPasses: 0, buffers: 164_600, folderRows: 32_600 },
  "pair common Old": { folderPasses: 0, buffers: 82_000, folderRows: 10_200 },
  "pair common INBOX": { folderPasses: 0, buffers: 74_700, folderRows: 7_500 },
  "beside common Archive": { folderPasses: 0, buffers: 730_600, folderRows: 166_000 },
  "beside common Old": { folderPasses: 0, buffers: 138_500, folderRows: 15_200 },
  "beside common INBOX": { folderPasses: 0, buffers: 103_100, folderRows: 7_800 },
  "typo common Archive": { buffers: 928_400, folderRows: 228_500 },
  "typo common Old": { folderPasses: 0, buffers: 52_500, folderRows: 9_300 },
  "typo common INBOX": { folderPasses: 0, buffers: 27_600, folderRows: 3_100 },
  "typo old dateTo": { history: N / 10, buffers: 12_100 }, "typo spread dateTo": { history: N / 10, buffers: 12_200 },
  "typo old none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
  "typo spread none": { history: MATRIX_REST.typo + matrixWalk(32_000, 1_529), lookups: 200 },
  "typo deleted none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
  "typo gap none": { history: MATRIX_REST.typo + matrixWalk(60_000, 1_520), lookups: 200 },
  "typo burst none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
  "typo mix none": { history: MATRIX_REST.typo + matrixOldest(2_606, 2_600, 1_500), lookups: 200 },
  "typo lateblock none": { history: MATRIX_REST.typo + matrixWalk(12_632, 3_790), lookups: 200 },
  "typo oldthin none": { history: MATRIX_REST.typo + matrixOldest(43_344, 2_600, 1_467), lookups: 200 },
  "typo recent none": { history: MATRIX_REST.typo + matrixWalk(5_000, 2_400), lookups: 200 },
  "typo recentthin none": { history: MATRIX_REST.typo + matrixWalk(5_715, 8_801), lookups: 200 },
  "typo oldtail none": { history: MATRIX_REST.typo, lookups: 1_600 },
  "typo behindfar none": { history: MATRIX_REST.typo + matrixOldest(37_868, 2_600, 1_472), lookups: 200 },
  "typo sampled none": { history: MATRIX_REST.typo + matrixWalk(68_572, 1_507), lookups: 200 },
  "typo newestfar none": { history: MATRIX_REST.typo + matrixWalk(26_667, 1_515), lookups: 1_600 },
  "beside old none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 300 },
  "beside spread none": { history: MATRIX_REST.beside, lookups: 1_700 },
  "beside deleted none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 300 },
  "beside gap none": { history: MATRIX_REST.beside, lookups: 1_600 },
  "beside burst none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500), lookups: 300 },
  "beside mix none": { history: MATRIX_REST.beside + matrixOldest(3_608, 3_600, 1_500) },
  "beside lateblock none": { history: MATRIX_REST.beside, lookups: 1_700 },
  "beside oldthin none": { history: MATRIX_REST.beside + matrixOldest(37_723, 3_600, 1_467), lookups: 300 },
  "beside recent none": { history: MATRIX_REST.beside + matrixWalk(30_000, 2_400), lookups: 300 },
  "beside recentthin none": { history: MATRIX_REST.beside + matrixWalk(120_000, 2_000), lookups: 300 },
  "beside oldtail none": { history: MATRIX_REST.beside, lookups: 1_600 },
  "beside behindfar none": { history: MATRIX_REST.beside + matrixOldest(35_047, 3_600, 1_472), lookups: 300 },
  "beside sampled none": { history: MATRIX_REST.beside, lookups: 1_600 },
  "beside newestfar none": { history: MATRIX_REST.beside + matrixOldest(57_794, 3_600, 1_515), lookups: 300 },
  "besiderare old none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_479), lookups: 200 },
  "besiderare spread none": { history: MATRIX_REST.besiderare + matrixWalk(32_000, 1_501), lookups: 200 },
  "besiderare deleted none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_479), lookups: 200 },
  "besiderare gap none": { history: MATRIX_REST.besiderare + matrixWalk(34_286, 1_501), lookups: 200 },
  "besiderare burst none": { history: MATRIX_REST.besiderare + matrixOldest(3_608, 3_600, 1_479), lookups: 200 },
  "besiderare lateblock none": { history: MATRIX_REST.besiderare, lookups: 1_600 },
  "besiderare oldthin none": { history: MATRIX_REST.besiderare + matrixOldest(38_277, 3_600, 1_446), lookups: 200 },
  "besiderare recentthin none": { history: MATRIX_REST.besiderare + matrixWalk(20_870, 1_977), lookups: 200 },
  "besiderare oldtail none": { history: MATRIX_REST.besiderare, lookups: 1_600 },
  "besiderare behindfar none": { history: MATRIX_REST.besiderare + matrixOldest(35_535, 3_600, 1_453), lookups: 200 },
  "besiderare sampled none": { history: MATRIX_REST.besiderare, lookups: 1_600 },
  "besiderare newestfar none": { history: MATRIX_REST.besiderare + matrixOldest(58_194, 3_600, 1_493), lookups: 200 },
};
/**
 * COLD, NEVER ABOVE THE BASE: the first page read once on a fresh copy of the seeded database
 * (`coldReads`), the blocks it reads from outside the cache at most the base's on this mailbox, to the
 * hundred below; a set dated as the base dates it (oldtail) at most the base's and a tenth, to the hundred below.
 * Dated where a walk meets them, the recent layouts had read 7,143 and 6,780 blocks beside a common excluded word and
 * 5,624 beside a rare one (the base 5,118, 5,234 and 5,205); the old run beside a rare one, whose empty newest letters
 * were walked before every member was dated, 4,572 (the base 4,294); walked as one window's rate put them and then
 * dated, oldtail's typo and oldtail beside a common and a rare excluded word 3,334, 5,370 and 4,594 (2,795, 4,446 and
 * 3,233), newestfar and behindfar beside a common one 6,556 and 6,075 (6,167 and 6,014).
 */
const MATRIX_COLD: Readonly<Record<string, number>> = {
  "beside recent none": 5_100, "beside recentthin none": 5_200, "besiderare recentthin none": 5_200, "besiderare oldthin none": 4_200,
  "typo oldtail none": 3_000, "beside oldtail none": 4_800, "besiderare oldtail none": 3_500, "beside newestfar none": 6_100,
  "beside behindfar none": 6_000,
};

describe("the shape matrix on a 240,000-letter mailbox (real Postgres)", () => {
  const db = throwawayDb("search_matrix_large");
  let client: ReturnType<typeof postgres> | null = null;
  let h: BudgetHandle;
  const seen: SQL[] = [];
  /** One handle for every search, as the server holds one: the store's facts are read once a handle. */
  let recorded: BudgetHandle;
  const ctx = (): ServiceContext =>
    ({ db: recorded as never, accountId: D, userId: null, now: () => new Date("2026-09-23T12:00:00Z"), requestId: "search-budget-matrix" });

  beforeAll(async () => {
    await db.create(runMigrations);
    client = postgres(db.url, { max: 1, connection: { max_parallel_workers_per_gather: 0 } });
    h = brandDialect(drizzle(client, { schema }), "pg");
    recorded = recording(h, seen);
    await ensureSearchExtensions(h, { concurrently: false });
    await ensureHotPathIndexes(h, { concurrently: false });
    await h.execute(sql`set statement_timeout = '1200s'`);
    // The planted documents lie where the plant wrote them: no vacuum of the server's frees space under it.
    await autovacuum(h, false);
    await seedDocumented(h, D, N, D_SALT);
    await seedDocumented(h, NOISE, 20_000, NOISE_SALT);
    await plantMatrix(h, D, N);
    await ensureWordIndex(h, { concurrently: false });
    // Settled as search-budget.pg settles its mailboxes: `message_search`'s statistics the whole table.
    for (const t of ["messages", "message_search", "folder_state"]) {
      await h.execute(t === "message_search" ? sql`set default_statistics_target = 1000` : sql`reset default_statistics_target`);
      await h.execute(sql.raw(`vacuum (parallel 0, analyze) ${t}`));
    }
    await h.execute(sql`reset default_statistics_target`);
    await h.execute(sql`analyze message_bodies`);
    await autovacuum(h, true);
    await h.execute(sql`reset statement_timeout`);
  }, 1_200_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await db.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("no page scans a table or reads its guesses twice, and no set read walks past the bound it is chosen with", async () => {
    const svc = new SearchService();
    const [counted] = (await h.execute(sql`select count(*)::int as n from folder_state`)) as unknown as Array<{ n: number }>;
    const read: string[] = [];
    const over: string[] = [];
    for (const c of matrixCells(N)) {
      let q = c.of;
      for (const [m, k] of c.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k), h));
      const opts = { q, parts: "page" as const, ...(Object.keys(c.filters).length > 0 ? { filters: c.filters } : {}) };
      await svc.search(ctx(), opts);
      seen.length = 0;
      await svc.search(ctx(), opts);
      const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
      expect(reads, c.label).toHaveLength(1);
      const f = await matrixWork(reads[0]!, seen.filter(isSession), h, counted!.n);
      read.push(`${c.label} ${f.buffers}/${f.history}/${f.lookups}/${f.folderPasses}/${f.folderRows}/${f.guesses}`);
      expect(f.scans, c.label).toEqual([]);
      expect(f.guessReads, `${c.label}: reads of the typo arm's guesses`).toBeLessThanOrEqual(1);
      over.push(...matrixOver(c.label, f, MATRIX_BOUNDS), ...(f.temp > 0 ? [`${c.label} temp ${f.temp} of 0`] : []));
    }
    console.log(`search-budget matrix on ${N} letters (buffers/History letters/lookups/folder passes/folder rows/guesses read): ${read.join(", ")}`);
    expect(over).toEqual([]);
  }, 600_000);

  it("no layout a set read had read past the base reads more blocks cold than its bound", async () => {
    const svc = new SearchService();
    const pages: Array<{ label: string; page: SQL; session: SQL[] }> = [];
    for (const c of matrixCells(N).filter((x) => MATRIX_COLD[x.label] !== undefined)) {
      let q = c.of;
      for (const [m, k] of c.of.matchAll(/\{(\d+)\}/g)) q = q.replace(m, await vocabWord(Number(k), h));
      await svc.search(ctx(), { q, parts: "page" });
      seen.length = 0;
      await svc.search(ctx(), { q, parts: "page" });
      const reads = seen.filter((st) => !isSession(st) && !isExplain(st));
      expect(reads, c.label).toHaveLength(1);
      pages.push({ label: c.label, page: reads[0]!, session: seen.filter(isSession) });
    }
    // Nothing may be connected to the database while it is copied.
    await client?.end({ timeout: 5 });
    client = null;
    const read: string[] = [];
    const over: string[] = [];
    for (const p of pages) {
      const blocks = await coldReads(db.url, p.page, p.session);
      read.push(`${p.label} ${blocks}`);
      if (blocks > MATRIX_COLD[p.label]!) over.push(`${p.label} ${blocks} of ${MATRIX_COLD[p.label]}`);
    }
    console.log(`search-budget matrix cold on ${N} letters (blocks read from outside the cache): ${read.join(", ")}`);
    expect(over).toEqual([]);
  }, 600_000);
});
