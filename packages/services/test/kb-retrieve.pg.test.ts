import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { kbEntries } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { KbService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";

/**
 * Phase 3a — KbService.retrieve on REAL Postgres, where pg_trgm lives (RC8; PGlite
 * cannot host it). Proves the dedicated KB lexical retrieval ranks the
 * right entry top for an exact query, surfaces a TYPO via the fuzzy arm (the
 * offline ILIKE degrade would MISS it), and stays accountId-scoped.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
// BRANDED, like every production factory: a handle with no dialect brand refuses at the first
// statement the seam composes for it.
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new KbService();

const A = randomUUID();
const B = randomUUID();
const NOW = new Date("2026-07-28T12:00:00.000Z");
const ids: Record<string, string> = {};

function ctx(accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: "kb-test" };
}

describe("KbService.retrieve (lexical + pg_trgm fuzzy) on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });

    async function seed(accountId: string, key: string, title: string, content: string) {
      const [r] = await db.insert(kbEntries).values({ accountId, title, content }).returning();
      ids[key] = r!.id;
    }
    await seed(A, "refund", "Refund policy", "We refund purchases within 30 days.");
    await seed(A, "shipping", "Shipping information", "Orders ship in two business days.");
    await seed(A, "warranty", "Warranty terms", "Hardware is covered for twelve months.");
    // Account B decoy that matches an A query but must stay invisible to A.
    await seed(B, "otherRefund", "Refund policy other tenant", "Different account refund text.");
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("(a) an exact query ranks the relevant entry top", async () => {
    const hits = await svc.retrieve(ctx(A), "refund");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(ids.refund);
  });

  it("(b) a TYPO surfaces the entry via the pg_trgm fuzzy arm", async () => {
    const hits = await svc.retrieve(ctx(A), "warrenty");   // misspelled 'warranty'
    expect(hits.map((h) => h.id)).toContain(ids.warranty);
  });

  it("(c) accountId isolation — another account's entry never appears", async () => {
    const hits = await svc.retrieve(ctx(A), "refund");
    expect(hits.map((h) => h.id)).not.toContain(ids.otherRefund);
    const hb = await svc.retrieve(ctx(B), "refund");
    expect(hb.map((h) => h.id)).toContain(ids.otherRefund);
    expect(hb.map((h) => h.id)).not.toContain(ids.refund);
  });
});
