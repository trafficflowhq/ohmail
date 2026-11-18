import type { RuleDTO, SyncChange } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { accounts, graduations, rules, applyRuleRequest, type LedgerTx, type Tx } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import type { MigrationObservation } from "@trafficflow/core";
import { learningService } from "../src/learning-service.js";
import { HeyMigrationService } from "../src/hey-migration.js";

/**
 * ═══ A RULE WHOSE STATE MOVED REACHES THE CLIENT ════════════════════════════════════════════
 *
 * Every case here asks the question a client asks and nothing else: "what changed since the
 * cursor I hold?" — `SyncService.getChanges`, the same call the webapp's mirror polls. Reading
 * the `rules` table instead would pass for every one of these writers at the base, because the
 * ROW was always right; what was missing was the announcement.
 *
 * RED AT THE BASE for the promotion, the re-enable, the lifetime-net demotion and the migration's
 * retarget — four writers that moved a rule and told nobody. GREEN AT THE BASE for the request
 * applier, which is the positive control: the same reader, the same assertion, a writer that
 * already filed. A case list where every case is red proves the READER, not the writers.
 *
 * WHY POSTGRES. These are deltas allocated inside transactions — a seq from the account's counter
 * row, appended and committed with the row it describes. `promoteOrDemote` now opens a
 * transaction of its own for exactly that reason, and PGlite's single connection cannot tell a
 * committed pair from two writes that happened to follow each other.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const owned = makeOwnedDb(PG_TEST_URL);
const db = owned.db;

const NOW = new Date("2026-09-12T10:00:00.000Z");
const SENDER = "digest@rulestate.example";
const READS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";

const ctx = (accountId: string): ServiceContext => ({
  db: dbFor(db, accountId), accountId, userId: null,
  now: () => NOW, requestId: "rule-state-deltas",
});

/** A fresh account per case: the cursor arithmetic below is per-account by construction. */
async function freshAccount(): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, name: `rsd-${id.slice(0, 8)}` });
  return id;
}

/** The client's cursor RIGHT NOW — everything asserted below is what arrives after it. */
async function cursorNow(accountId: string): Promise<string> {
  return (await syncService.getChanges(ctx(accountId), { limit: 200 })).cursor;
}

/** Every `rule` change the client is handed after `since`, flattened in wire order. */
async function ruleDeltasSince(accountId: string, since: string): Promise<SyncChange<RuleDTO>[]> {
  const res = await syncService.getChanges(ctx(accountId), { since, limit: 200 });
  const { creates, updates, moves, deletes } = res.changes;
  return [...creates, ...updates, ...moves, ...deletes]
    .filter((c) => c.type === "rule") as SyncChange<RuleDTO>[];
}

/** The graduation row a promotion or a demotion is decided from. */
async function graduation(
  accountId: string, patternKey: string,
  counts: { positives: number; negatives: number; graduated: boolean },
): Promise<void> {
  await db.insert(graduations).values({
    accountId, patternKey, action: "route",
    positives: counts.positives, negatives: counts.negatives, graduated: counts.graduated,
  });
}

describe.skipIf(!PG_UP)("every rule-state writer reaches the client's delta", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 120_000);
  afterAll(async () => { await owned.close(); await client.end({ timeout: 5 }); });

  it("PROMOTION — a graduated route mints a rule, and the client is handed it", async () => {
    const accountId = await freshAccount();
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 4, negatives: 0, graduated: true,
    });
    const since = await cursorNow(accountId);

    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.map((d) => d.op)).toEqual(["create"]);
    expect(deltas[0]!.entity).toMatchObject({
      kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: true,
    });
    // …and the delta names the row that was actually written, not a shape composed beside it.
    const [row] = await db.select({ id: rules.id }).from(rules)
      .where(eq(rules.accountId, accountId));
    expect(deltas[0]!.id).toBe(row!.id);
  });

  it("RE-ENABLE — a rule switched back on is announced as an update", async () => {
    const accountId = await freshAccount();
    const [row] = await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: false,
    }).returning({ id: rules.id });
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 5, negatives: 1, graduated: true,
    });
    const since = await cursorNow(accountId);

    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.map((d) => ({ op: d.op, id: d.id }))).toEqual([{ op: "update", id: row!.id }]);
    expect(deltas[0]!.entity).toMatchObject({ enabled: true });
  });

  it("RE-ENABLE — a rule already standing that way is announced to nobody", async () => {
    const accountId = await freshAccount();
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: true,
    });
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 4, negatives: 0, graduated: true,
    });
    const since = await cursorNow(accountId);

    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);

    // The other half of the same rule: a delta a client cannot tell from a real move is noise.
    expect(await ruleDeltasSince(accountId, since)).toEqual([]);
  });

  it("DEMOTION on the lifetime net — the rule goes off, and the client is told", async () => {
    const accountId = await freshAccount();
    const [row] = await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 1, negatives: 4, graduated: true,
    });
    const since = await cursorNow(accountId);

    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.map((d) => ({ op: d.op, id: d.id }))).toEqual([{ op: "update", id: row!.id }]);
    // The state a client showing the rule ON would have kept showing for ever.
    expect(deltas[0]!.entity).toMatchObject({ enabled: false, stats: { demotions: 1 } });
    // And the route stops auto-applying, in the same transaction.
    const [g] = await db.select({ graduated: graduations.graduated }).from(graduations)
      .where(eq(graduations.accountId, accountId));
    expect(g!.graduated).toBe(false);
  });

  it("MIGRATION RETARGET — a migrated rule pointed elsewhere is announced", async () => {
    const accountId = await freshAccount();
    const hey = new HeyMigrationService();
    await hey.migrateFromObservations(ctx(accountId), {
      observations: [
        { kind: "sender", senderOrDomain: SENDER, destination: READS } as MigrationObservation,
      ],
    });
    const since = await cursorNow(accountId);

    // The SAME sender, observed into a different folder — the rule is rewritten in place.
    const again = await hey.migrateFromObservations(ctx(accountId), {
      observations: [
        { kind: "sender", senderOrDomain: SENDER, destination: RECEIPTS } as MigrationObservation,
      ],
    });
    expect(again).toMatchObject({ created: 0, unchanged: 1 });

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.map((d) => d.op)).toEqual(["update"]);
    expect(deltas[0]!.entity).toMatchObject({ destination: RECEIPTS, provenance: "migrated" });
  });

  it("MIGRATION RE-RUN — an observation that moved nothing is announced to nobody", async () => {
    const accountId = await freshAccount();
    const hey = new HeyMigrationService();
    const observations: MigrationObservation[] = [
      { kind: "sender", senderOrDomain: SENDER, destination: READS },
    ];
    await hey.migrateFromObservations(ctx(accountId), { observations });
    const since = await cursorNow(accountId);

    await hey.migrateFromObservations(ctx(accountId), { observations });

    expect(await ruleDeltasSince(accountId, since)).toEqual([]);
  });

  it("POSITIVE CONTROL — the request applier already filed, and still does", async () => {
    const accountId = await freshAccount();
    await (db as unknown as Tx).transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as LedgerTx, {
        accountId, now: NOW,
        payload: {
          op: "create",
          key: { kind: "sender", match: SENDER, subjectContains: null, bodyContains: null },
          destination: READS, priority: 0, enabled: true, applyRetro: false,
        },
      });
    });
    const since = await cursorNow(accountId);

    await (db as unknown as Tx).transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as LedgerTx, {
        accountId, now: NOW,
        payload: {
          op: "update",
          key: { kind: "sender", match: SENDER, subjectContains: null, bodyContains: null },
          set: { destination: RECEIPTS }, applyRetro: false, retroAsked: false,
        },
      });
    });

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.map((d) => d.op)).toEqual(["update"]);
    expect(deltas[0]!.entity).toMatchObject({ destination: RECEIPTS });
  });

  it("the reader is asked about rules only — a case list that passes for the wrong reason", async () => {
    // Every assertion above filters to `type === "rule"`. If the filter matched nothing the
    // `toEqual([])` cases would pass by accident, so one case proves the filter selects.
    const accountId = await freshAccount();
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 4, negatives: 0, graduated: true,
    });
    const since = await cursorNow(accountId);
    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);
    const all = await syncService.getChanges(ctx(accountId), { since, limit: 200 });
    const flat = [
      ...all.changes.creates, ...all.changes.updates,
      ...all.changes.moves, ...all.changes.deletes,
    ];
    expect(flat.length).toBe(1);
    expect(flat[0]!.type).toBe("rule");
  });

  it("the promoted rule the demotion looks for is the one it disables, not any rule", async () => {
    // A manual rule for the same sender and folder is somebody's own decision; only the route's
    // own promoted row may be switched off by evidence about the route.
    const accountId = await freshAccount();
    const [manual] = await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: RECEIPTS,
      provenance: "manual", enabled: true,
    }).returning({ id: rules.id });
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: true,
    });
    await graduation(accountId, `sender:${SENDER}→${READS}`, {
      positives: 0, negatives: 3, graduated: true,
    });
    const since = await cursorNow(accountId);

    await learningService.promoteOrDemote(ctx(accountId), `sender:${SENDER}→${READS}`);

    const deltas = await ruleDeltasSince(accountId, since);
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.id).not.toBe(manual!.id);
    const [stillOn] = await db.select({ enabled: rules.enabled }).from(rules)
      .where(and(eq(rules.id, manual!.id), eq(rules.accountId, accountId)));
    expect(stillOn!.enabled).toBe(true);
  });
});
