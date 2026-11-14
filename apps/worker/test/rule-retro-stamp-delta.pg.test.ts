import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THE FINISHED STAMP IS ANNOUNCED ONCE. A rule's pass over past mail stamps `retro_done_at` and
 * files one rule delta in the same transaction, so a client learns the pass finished. Two drivers
 * finishing the same rule at once write one stamp and one delta between them (`WHERE retro_done_at
 * IS NULL`). Real Postgres: two connections, run in both orders (B then A as the control).
 */

const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const AVAILABLE = await realPgAvailable();
const SENDER = "alerts@kestrel.example";
const NOW = new Date("2026-09-25T13:05:00Z");

describe.skipIf(!AVAILABLE)("the rule pass's finished stamp and its delta", () => {
  let dbA: ReturnType<typeof drizzle<typeof schema>>;
  let dbB: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    dbA = brandDialect(drizzle(postgres(PG_TEST_URL, { max: 2, onnotice: () => {} }), { schema }), "pg");
    dbB = brandDialect(drizzle(postgres(PG_TEST_URL, { max: 2, onnotice: () => {} }), { schema }), "pg");
  }, 120_000);

  async function world(): Promise<{ accountId: string; ruleId: string }> {
    const accountId = randomUUID();
    await dbA.insert(accounts).values({ id: accountId, name: `f025s-${accountId.slice(0, 8)}` });
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    const dedup = `mid:${randomUUID()}`;
    const [m] = await dbA.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "Invoice ready", fromAddress: SENDER, nativeLocator: { folder: "ohmail/News", ref: "1:1" },
    }).returning();
    await dbA.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/News", observedFolder: "ohmail/News",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    const [r] = await dbA.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: "INBOX", provenance: "manual", enabled: true,
      retroRequestedAt: new Date("2026-09-25T13:02:00Z"),
    }).returning({ id: rules.id });
    return { accountId, ruleId: r!.id };
  }

  const deltas = (w: { accountId: string; ruleId: string }) => dbA.select({ op: changeLog.op }).from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "rule"), eq(changeLog.entityId, w.ruleId)));
  const pass = (db: typeof dbA, accountId: string) =>
    ruleRetroPass(db as unknown as Tx, { accountId, trustedAuthservIdsFor: NONE }, NOW);

  for (const order of ["A then B", "B then A"] as const) {
    it(`two drivers finishing at once: one stamp, one delta (${order})`, async () => {
      const w = await world();
      const [first, second] = order === "A then B" ? [dbA, dbB] : [dbB, dbA];
      const results = await Promise.all([pass(first, w.accountId), pass(second, w.accountId)]);
      expect(results.reduce((n, r) => n + r.completed, 0), "both drivers claimed the finish").toBe(1);
      const [row] = await dbA.select({ doneAt: rules.retroDoneAt }).from(rules).where(eq(rules.id, w.ruleId));
      expect(row!.doneAt).not.toBeNull();
      expect(await deltas(w)).toEqual([{ op: "update" }]);
    }, 120_000);
  }
});
