import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, auditLog, folderState, mailboxes, messages, routingDecisions, rules, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ScreenerService, rulesService, type ServiceContext } from "@trafficflow/services";
import { gapCatchupPass } from "../src/gap-catchup.js";

/**
 * A SCREENER RULE THAT FILED A GAP BATCH IS REVOKED, on real Postgres: the rule is
 * the Screener's own decision, the batch is the gap pass's own filing, and the revoke is
 * `RulesService.remove` under a key, as the route calls it. At the base the delete was refused by
 * the decision rows' key to the rule (23503) and the route answered 500 every time.
 */

const AVAILABLE = await realPgAvailable();
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
/** Settled rules: the settings folder read cleanly with no import question open. */
const CLEAR = () => ({ kind: "clear" }) as const;
const NEWS = "ohmail/News";
const SCREENER = "ohmail/Screener";
const DECIDED = new Date("2026-10-02T09:00:00Z");
const GAP = new Date("2026-10-03T00:00:00Z");
const IN_GAP = new Date("2026-10-03T10:00:00Z");

describe.skipIf(!AVAILABLE)("the revoke of a rule that filed a gap batch, on real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  const ctxOf = (accountId: string): ServiceContext => ({
    db: db as unknown as ServiceContext["db"], accountId, userId: null,
    now: () => DECIDED, requestId: randomUUID(),
  });

  /** A sender ruled to News by the Screener, then `letters` of theirs filed by the gap pass. */
  async function world(from: string, letters: number) {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `gr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `gr-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    }).returning();
    const put = async (folder: string, i: number, arrivedAt: Date | null, lastSetBy: string) => {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: `letter ${i}`, fromAddress: from, nativeLocator: { folder, ref: `1:${i + 1}` }, arrivedAt,
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: folder, observedFolder: folder,
        lastSetBy, reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const held = await put(SCREENER, 0, null, "us");
    await new ScreenerService({}).decide(ctxOf(accountId), held, { decision: "yes", dest: NEWS, applyRetro: false });
    const [rule] = await db.select({ id: rules.id }).from(rules)
      .where(and(eq(rules.accountId, accountId), eq(rules.match, from)));
    expect(rule, "the Screener decision wrote no rule").toBeDefined();

    await db.update(mailboxes).set({ gapSince: GAP }).where(eq(mailboxes.id, mb!.id));
    const ids: string[] = [];
    for (let i = 1; i <= letters; i++) ids.push(await put("INBOX", i, IN_GAP, "peer"));
    if (letters > 0) {
      const opts = { accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
      expect(await gapCatchupPass(db as unknown as Tx, opts)).toMatchObject({ offered: 1 });
      await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, mb!.id));
      expect(await gapCatchupPass(db as unknown as Tx, opts), "the File press filed nothing").toMatchObject({ moved: letters });
    }
    return { accountId, ruleId: rule!.id, ids };
  }

  it("revokes, keeps every filing's decision and undo, and drops only their pointer", async () => {
    const w = await world("letters@gap-revoke.test", 3);
    const filed = await db.select({ r: routingDecisions.matchedRuleId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(filed.map((d) => d.r), "the gap pass names the rule it filed by").toEqual([w.ruleId, w.ruleId, w.ruleId]);

    const out = await rulesService.remove(ctxOf(w.accountId), w.ruleId, {
      idempotency: { key: `revoke-${randomUUID()}`, requestHash: "h" },
    });
    expect("pending" in out, "a revoke on an organized mailbox was queued").toBe(false);
    expect(await db.select().from(rules).where(eq(rules.id, w.ruleId))).toHaveLength(0);

    const after = await db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId));
    expect(after.map((d) => [d.destination, d.status, d.matchedRuleId]))
      .toEqual(w.ids.map(() => [NEWS, "auto_applied", null]));
    const undo = await db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(undo.filter((u) => u.a === "gap_catchup_move")).toHaveLength(3);
  }, 60_000);

  it("the control: the same Screener rule with no gap batch behind it", async () => {
    const w = await world("other@gap-revoke.test", 0);
    const out = await rulesService.remove(ctxOf(w.accountId), w.ruleId);
    expect("pending" in out).toBe(false);
    expect(await db.select().from(rules).where(eq(rules.id, w.ruleId))).toHaveLength(0);
  }, 60_000);
});
