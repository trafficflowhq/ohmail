// @postpush: alone
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { schema } from "@trafficflow/db/cloud";
import {
  BUDGET, EXPECTED_FACTS, costOf, ctxOf, factsOf, seed74k, svc, timed, withoutAccountBound, type PlanNode,
} from "./helpers/mailbox-facts-74k.js";
import { outstandingDrift, type Db } from "./helpers/mailbox-facts-seed.js";

/**
 * GET /mailboxes AT 74k ON REAL POSTGRES — `mailbox-facts-budget.test.ts`'s budget, through the
 * driver Cloud runs, with sequential scans priced as the server prices them and priced out. A
 * database of its own; alone, because it seeds a 94k-row store.
 */
const PG_UP = await realPgAvailable(PG_TEST_URL);
const NAME = `ohmail_mfbudget_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const urlFor = (name: string): string => { const u = new URL(PG_TEST_URL); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!PG_UP)("GET /mailboxes at 74k on real Postgres", () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres> | undefined;
  let db: Db;
  const sent: Array<{ text: string; params: unknown[] }> = [];

  beforeAll(async () => {
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${NAME}"`);
    await runMigrations(urlFor(NAME));
    client = postgres(urlFor(NAME), {
      max: 1, onnotice: () => {},
      connection: { statement_timeout: 600_000, max_parallel_workers_per_gather: 0 },
    });
    db = brandDialect(drizzle(client, {
      schema, logger: { logQuery: (text, params) => { sent.push({ text, params }); } },
    }), "pg") as unknown as Db;
    await seed74k(db, false);
  }, 240_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`drop database if exists "${NAME}" with (force)`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  it("reads the caller's outstanding filings alone, in five statements", async () => {
    sent.length = 0;
    const rows = await svc.list(ctxOf(db));
    const statements = [...sent];
    expect(factsOf(rows)).toEqual(EXPECTED_FACTS);
    expect(statements, "the list read and four facts").toHaveLength(5);
    const filing = statements.find((s) => s.text.includes('"folder_state"'))!;
    const cost = async (text: string) => {
      const r = await client!.unsafe(`explain (analyze, buffers, format json) ${text}`, filing.params as never[]);
      const v = Object.values(r[0]!)[0];
      return costOf(((typeof v === "string" ? JSON.parse(v) : v) as Array<{ Plan: PlanNode }>)[0]!.Plan);
    };
    for (const mode of ["on", "off"] as const) {
      await db.execute(sql.raw(`set enable_seqscan = ${mode}`));
      try {
        const got = await cost(filing.text);
        const why = `seqscan ${mode}: ${JSON.stringify(got, null, 1)}`;
        expect(got.buffers, why).toBeLessThanOrEqual(BUDGET.buffers);
        expect(got.folderState, why).toBeLessThanOrEqual(BUDGET.folderState);
        expect(got.messages, why).toBeLessThanOrEqual(BUDGET.messages);
        const loose = withoutAccountBound(filing.text, false);
        expect(loose.replaced).toBe(3);
        expect((await cost(loose.text)).folderState, `seqscan ${mode}: the control`).toBeGreaterThan(BUDGET.folderState);
      } finally {
        await db.execute(sql`reset enable_seqscan`);
      }
    }
    expect(await outstandingDrift(db)).toBe(0);
    console.log(`mailbox-facts-budget pg: list() ${JSON.stringify(await timed(() => svc.list(ctxOf(db))))} ms`);
  }, 120_000);
});
