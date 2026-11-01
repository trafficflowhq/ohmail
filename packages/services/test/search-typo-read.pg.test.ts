import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions, ensureDatedIndexes } from "@trafficflow/db/admin";
import { searchDatesFillPass } from "@trafficflow/core/mail";
import { pgTestUrl } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { seedTypoMailbox, typoOracle, TYPO_CASES, typoPages, typoPaths, type TypoFilters } from "./_typo-read-fixture.js";

/**
 * THE TYPO ARM ANSWERS WHAT THE OPERATOR ANSWERS, by whichever read is cheaper (real Postgres,
 * pg_trgm, documents built). A page of 5 makes the cut 20, the probe the newest 20 and the walk the
 * newest half of the fixture's messages: a typo dense in the newest mail is walked and its GIN read never
 * starts; a sparse one reads the GIN and walks nothing past the probe; one the probe finds but the
 * walk holds too few of is walked AND read; one whose filtered mailbox is shorter than the walk its
 * probe asks for is read. Every relevance page equals the oracle — the newest
 * cut of `q <% terms`, ranked by `word_similarity`, date, id — with a filter and outside ASCII too.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 3, onnotice: () => {} });
const logged: Array<{ q: string; p: unknown[] }> = [];
const db = brandDialect(drizzle(client, { schema, logger: { logQuery: (q, p) => { logged.push({ q, p }); } } }), "pg");
const svc = new SearchService();
const A = randomUUID();
const ctx = (): ServiceContext => ({ db, accountId: A, userId: null, now: () => new Date("2026-08-20T12:00:00Z"), requestId: "typo-read" });

/** The page statement's plan, run under the search session's settings. */
async function planOf(q: string, filters?: TypoFilters): Promise<Record<string, unknown>> {
  logged.length = 0;
  await svc.search(ctx(), { q, parts: "page", limit: 5, ...(filters === undefined ? {} : { filters }) });
  const page = logged.find((l) => l.q.includes("fused_s"));
  expect(page, `${q}: the page statement was not logged`).toBeDefined();
  const out = await client.begin(async (tx) => {
    await tx.unsafe("select set_config('pg_trgm.word_similarity_threshold', '0.3', true), set_config('enable_seqscan', 'off', true)");
    return tx.unsafe(`explain (analyze, format json) ${page!.q}`, page!.p as never[]);
  });
  return ((out[0] as Record<string, Array<Record<string, unknown>>>)["QUERY PLAN"]![0]!)["Plan"] as Record<string, unknown>;
}

beforeAll(async () => {
  await runMigrations(URL);
  await ensureSearchExtensions(db, { concurrently: false });
  await seedTypoMailbox(db, A);
}, 120_000);

afterAll(async () => {
  for (const t of ["message_search", "folder_state", "message_bodies"]) {
    await db.execute(sql.raw(`delete from ${t} where message_id in (select id from messages where account_id = '${A}')`));
  }
  await db.execute(sql`delete from account_settings where account_id = ${A}`);
  await db.execute(sql`delete from messages where account_id = ${A}`);
  await db.execute(sql`delete from mailboxes where account_id = ${A}`);
  await client.end({ timeout: 5 });
});

describe("the typo arm's read (real Postgres, pg_trgm)", () => {
  it.each(TYPO_CASES)("$q $filters: every relevance page equals the newest cut of the operator's matches", async ({ q, filters }) => {
    const want = await typoOracle(db, A, q, filters);
    const got = await typoPages(svc, ctx(), q, filters);
    expect(want.length, `${q}: the oracle found nothing, so the case measures nothing`).toBeGreaterThan(0);
    expect(got.tier).toBe("similar");
    expect(got.ids).toEqual(want);
  });

  it.each(TYPO_CASES.filter((c) => c.path !== undefined))("$q $filters: read by the $path", async ({ q, filters, path }) => {
    const p = typoPaths(await planOf(q, filters));
    expect(p, q).toEqual(path === "walk" ? { walked: true, read: false } : path === "index" ? { walked: false, read: true } : { walked: true, read: true });
  });

  // Read by month (mail 0174), once the documents carry their months: the same pages, the oracle's.
  it("read by month, every relevance page still equals the newest cut of the operator's matches", async () => {
    await ensureDatedIndexes(db, { concurrently: false });
    expect(await searchDatesFillPass({ db: db as never, accountId: A, limit: 1_000_000 })).toMatchObject({ marked: true });
    const c = { ...ctx(), db: brandDialect(drizzle(client, { schema }), "pg") };
    for (const { q, filters } of TYPO_CASES) {
      expect(await typoPages(svc, c, q, filters), `${q} ${JSON.stringify(filters)}`).toMatchObject({ tier: "similar", ids: await typoOracle(db, A, q, filters) });
    }
  }, 120_000);
});
