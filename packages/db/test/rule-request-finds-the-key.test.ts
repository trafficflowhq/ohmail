import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, validateRulePayload, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, changeLog, rules } from "../src/schema-mail.js";
import { RULE_REMOVAL_KEY_MAX_BYTES, readRuleRemovals, recordRuleRemovals } from "../src/rule-removals.js";
import { writeRuleUnderKey } from "../src/rule-key.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

/**
 * A TRAVELLED RULE REQUEST FINDS THE RULE BY ITS KEY, whatever bytes the row was stored with
 * (`POST /rules` stored a match verbatim), and acts on the sender's rule as a whole: the router's
 * acting twin is the one edited, and a delete removes every twin under the key with one delta each.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");
type Seed = { match: string; destination?: string; priority?: number; createdAt?: Date };

async function world(seeds: Seed[]) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rrfk-${accountId.slice(0, 8)}` });
  const ids: string[] = [];
  for (const r of seeds) {
    const [row] = await db.insert(rules).values({
      accountId, kind: "sender", match: r.match, destination: r.destination ?? "ohmail/News",
      priority: r.priority ?? 0, enabled: true, provenance: "manual",
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    }).returning({ id: rules.id });
    ids.push(row!.id);
  }
  const apply = (payload: ValidatedRuleRequest) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now: NOW }));
  const left = async () => (await db.select({ id: rules.id, destination: rules.destination })
    .from(rules).where(eq(rules.accountId, accountId)));
  const deltas = async (op: string) => (await db.select({ id: changeLog.entityId }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, op))))
    .map((r) => r.id).sort();
  const removed = async () => (await readRuleRemovals(db as unknown as Tx, accountId)).map((r) => [r.match, r.removedAt.toISOString(), r.removedBy]);
  return { db, accountId, ids, apply, left, deltas, removed };
}

const req = (kind: string, match: string, extra: Record<string, unknown> = {}) =>
  validateRulePayload(kind, { key: { kind: "sender", match }, ...extra })!;

describe("the key finds the row whatever bytes it was stored with", () => {
  it("a delete keyed on the rule's key finds a row POST /rules stored padded", async () => {
    const w = await world([{ match: "  ann@shop.example " }]);
    expect(await w.apply(req("rule.delete", "ann@shop.example"))).toMatchObject({ applied: true, op: "delete" });
    expect(await w.left()).toEqual([]);
  });

  it("…and one stored in another case", async () => {
    const w = await world([{ match: "Ann@Shop.example" }]);
    expect(await w.apply(req("rule.delete", "ann@shop.example"))).toMatchObject({ applied: true, op: "delete" });
  });

  it("the request's own spelling is keyed too: a padded, re-cased key finds the plain row", async () => {
    const w = await world([{ match: "ann@shop.example" }]);
    expect(await w.apply(req("rule.delete", " Ann@Shop.EXAMPLE  "))).toMatchObject({ applied: true, op: "delete" });
  });

  it("CONTROL: an exact key deletes, and another sender's key finds nothing", async () => {
    const w = await world([{ match: "ann@shop.example" }]);
    expect(await w.apply(req("rule.delete", "bob@shop.example"))).toEqual({ applied: false, refusal: "no_such_rule" });
    expect(await w.apply(req("rule.delete", "ann@shop.example"))).toMatchObject({ applied: true, op: "delete" });
  });

  it("a key of spaces is no key", () => {
    expect(validateRulePayload("rule.delete", { key: { kind: "sender", match: "   " } })).toBeNull();
  });
});

describe("two rows under one key act as the sender's one rule", () => {
  it("a delete removes every twin, one delete delta per row", async () => {
    const w = await world([{ match: "  Ann@Shop.example " }, { match: "ann@shop.example" }]);
    const res = await w.apply(req("rule.delete", "ann@shop.example"));
    expect(res).toMatchObject({ applied: true, op: "delete" });
    expect(await w.left()).toEqual([]);
    expect(await w.deltas("delete")).toEqual([...w.ids].sort());
    expect(await w.removed(), "the person's removal, at the press's instant").toEqual([["ann@shop.example", NOW.toISOString(), null]]);
  });

  it("an update edits the twin the router runs (the higher priority, not the oldest) and collapses the other", async () => {
    const w = await world([
      { match: "ann@shop.example", priority: 0, createdAt: new Date("2026-01-01T00:00:00Z") },
      { match: "  Ann@Shop.example ", priority: 3, createdAt: new Date("2026-06-01T00:00:00Z") },
    ]);
    const res = await w.apply(req("rule.update", "ann@shop.example", { set: { destination: "receipts" } }));
    expect(res).toMatchObject({ applied: true, op: "update", ruleId: w.ids[1] });
    expect(await w.left()).toEqual([{ id: w.ids[1], destination: "ohmail/Receipts" }]);
    expect(await w.deltas("delete")).toEqual([w.ids[0]]);
    expect(await w.deltas("update")).toEqual([w.ids[1]]);
    expect(await w.removed(), "a collapsed twin is no rule removed").toEqual([]);
  });

  it("a create on an existing key reconciles the acting twin and collapses the rest", async () => {
    const w = await world([{ match: "ann@shop.example" }, { match: "Ann@Shop.example" }]);
    const res = await w.apply(req("rule.create", "ann@shop.example", { destination: "receipts" }));
    expect(res).toMatchObject({ applied: true, op: "update" });
    expect((await w.left()).map((r) => r.id)).toHaveLength(1);
  });

  it("a create the acting twin already satisfies answers unchanged, with the seq of the twin it collapsed", async () => {
    const w = await world([{ match: "ann@shop.example" }, { match: "Ann@Shop.example" }]);
    const res = await w.apply(req("rule.create", "ann@shop.example", { destination: "reads" }));
    expect(res).toMatchObject({ applied: true, op: "unchanged" });
    expect((res as { lastSeq: bigint | null }).lastSeq, "the twin's delete is a change a client must drain").not.toBeNull();
    expect(await w.left()).toHaveLength(1);
    expect(await w.deltas("delete")).toHaveLength(1);
    expect(await w.deltas("update")).toEqual([]);
  });

  it("CONTROL: a single row under its key is updated in place and nothing is deleted", async () => {
    const w = await world([{ match: "ann@shop.example" }]);
    await w.apply(req("rule.update", "ann@shop.example", { set: { destination: "receipts" } }));
    expect(await w.left()).toEqual([{ id: w.ids[0], destination: "ohmail/Receipts" }]);
    expect(await w.deltas("delete")).toEqual([]);
  });
});

describe("a removal is recorded under a key the store's btree can hold", () => {
  it("a key past its byte bound goes unrecorded, and one at the bound is recorded", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `rrb-${accountId.slice(0, 8)}` });
    // ["sender","<match>","",""] is 19 bytes around the match; "é" is two.
    const fits = `${"é".repeat((RULE_REMOVAL_KEY_MAX_BYTES - 20) / 2)}a`;
    await (db as unknown as Tx).transaction((tx) => recordRuleRemovals(tx as unknown as Tx, accountId, [
      { kind: "sender", match: fits }, { kind: "sender", match: `${fits}x` },
    ], NOW));
    expect((await readRuleRemovals(db as unknown as Tx, accountId)).map((r) => r.match)).toEqual([fits]);
  });
});

/* A RULE MADE AGAIN UNDER ITS KEY ENDS THE KEY'S REMOVAL. Kept, the removal would travel again once the rule
   left by a door that records nothing, and an Import elsewhere would retire the rule the person made again. */
describe("a rule made again under its key ends the key's recorded removal", () => {
  /** Removals of ann and bob here an hour ago, and of ann on another account; reads that account's. */
  async function removedBefore(w: Awaited<ReturnType<typeof world>>): Promise<() => Promise<string[]>> {
    const earlier = new Date(NOW.getTime() - 60 * 60 * 1000);
    const other = randomUUID();
    await w.db.insert(accounts).values({ id: other, name: `rrm-${other.slice(0, 8)}` });
    await (w.db as unknown as Tx).transaction(async (tx) => {
      await recordRuleRemovals(tx as unknown as Tx, w.accountId, [
        { kind: "sender", match: "ann@shop.example" }, { kind: "sender", match: "bob@shop.example" },
      ], earlier);
      await recordRuleRemovals(tx as unknown as Tx, other, [{ kind: "sender", match: "ann@shop.example" }], earlier);
    });
    return async () => (await readRuleRemovals(w.db as unknown as Tx, other)).map((r) => r.match);
  }

  it("a create applied under the key, in another spelling, clears it; another key's and another account's stay", async () => {
    const w = await world([]);
    const otherAccount = await removedBefore(w);
    expect(await w.apply(req("rule.create", " Ann@Shop.example", { destination: "receipts" }))).toMatchObject({ applied: true, op: "create" });
    expect((await w.removed()).map(([match]) => match)).toEqual(["bob@shop.example"]);
    expect(await otherAccount()).toEqual(["ann@shop.example"]);
  });

  it("so does the insert of the writer for a door that names a sender (a Screener decision, a promotion)", async () => {
    const w = await world([]);
    await removedBefore(w);
    const out = await (w.db as unknown as Tx).transaction((tx) => writeRuleUnderKey(tx as unknown as Tx, {
      accountId: w.accountId, now: NOW, overExisting: "converge",
      key: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null },
      diff: () => ({}), insert: { destination: "INBOX", provenance: "promoted", enabled: true, retroRequestedAt: null },
    }));
    expect(out.op).toBe("create");
    expect((await w.removed()).map(([match]) => match)).toEqual(["bob@shop.example"]);
  });
});
