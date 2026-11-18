import { describe, it, expect } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, RULE_PRIORITY_MAX as DRAIN_MAX, validateRulePayload } from "@trafficflow/db";
import { RULE_PRIORITY_MAX } from "@trafficflow/core/rule-order";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * ONE PRIORITY BOUND AT EVERY DOOR. A value `RulesService` stored and the
 * organizer's drain refused made the drain drop a whole rule request; the service, the drain's
 * pinned copy and core's constant now say the same thing.
 */
async function world(): Promise<ServiceContext> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `prio-${accountId.slice(0, 8)}` });
  return { db: dbFor(db, accountId), accountId, now: () => new Date("2026-09-25T13:00:00Z") } as unknown as ServiceContext;
}

const RULE = { kind: "domain", match: "shop.example", destination: "ohmail/News" };

describe("a rule's priority has one bound", () => {
  it("the drain's copy is core's constant", () => {
    expect(DRAIN_MAX).toBe(RULE_PRIORITY_MAX);
  });

  it("the service stores the bound and refuses past it or below zero, with a 400", async () => {
    const ctx = await world();
    const { rule } = mutated(await rulesService.create(ctx, { ...RULE, priority: RULE_PRIORITY_MAX }));
    expect(rule.priority).toBe(RULE_PRIORITY_MAX);
    for (const priority of [RULE_PRIORITY_MAX + 1, -1]) {
      await expect(rulesService.create(ctx, { ...RULE, match: `${priority}.example`, priority }))
        .rejects.toMatchObject({ httpStatus: 400 });
    }
    await expect(rulesService.update(ctx, rule.id, { priority: RULE_PRIORITY_MAX + 1 }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("the drain refuses the same values and admits the bound", () => {
    const key = { kind: "domain", match: "shop.example" };
    const create = (priority: number) => validateRulePayload("rule.create", { key, destination: "reads", priority });
    expect(create(RULE_PRIORITY_MAX)).not.toBeNull();
    expect(create(RULE_PRIORITY_MAX + 1)).toBeNull();
    expect(validateRulePayload("rule.update", { key, set: { priority: RULE_PRIORITY_MAX + 1 } })).toBeNull();
  });
});
