import { describe, it, expect } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules } from "@trafficflow/db";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * THE SENDER SHEET'S PRESS OVER A TWIN IT ALREADY HAS IS THE PERSON'S RULE FROM THEN ON.
 * "All their mail -> Ohbox" over a twin the Screener promoted is a PATCH, and it kept the twin's
 * `promoted` provenance — an inference `people_only` may refile, so the sender's next newsletter
 * went to News under the rule just pressed. A PATCH naming the place makes the rule `manual`; one
 * that names no place (priority, on/off) leaves the provenance alone.
 */

const NOW = new Date("2026-10-01T21:00:00Z");
const updateRule = async (...a: Parameters<typeof rulesService.update>) => mutated(await rulesService.update(...a));

async function world(provenance: "promoted" | "seeded-from-sent", destination = "ohmail/News") {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `press-${accountId.slice(0, 8)}` });
  const ctx = { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext;
  const [r] = await db.insert(rules).values({
    accountId, kind: "sender", match: `${randomUUID()}@letter.example`, destination, priority: 0, provenance,
  }).returning();
  const row = async () => (await db.select().from(rules).where(eq(rules.id, r!.id)))[0]!;
  return { ctx, id: r!.id, row };
}

describe("a sheet press over an existing twin makes the rule the person's", () => {
  it("retarget (News -> Ohbox, also move what is here): manual, re-armed", async () => {
    const { ctx, id, row } = await world("promoted");
    await updateRule(ctx, id, { destination: "INBOX", applyRetro: true });
    const r = await row();
    expect(r.destination).toBe("INBOX");
    expect(r.provenance, "the twin stayed an inference under the person's press").toBe("manual");
    expect(r.retroRequestedAt).toEqual(NOW);
  });

  it("re-arm (the twin already files there, the press asks for the backlog): manual", async () => {
    const { ctx, id, row } = await world("seeded-from-sent", "INBOX");
    await updateRule(ctx, id, { destination: "INBOX", applyRetro: true });
    const r = await row();
    expect(r.destination).toBe("INBOX");
    expect(r.provenance).toBe("manual");
  });

  it("an edit naming no place keeps an inferred rule inferred (the positive control)", async () => {
    const { ctx, id, row } = await world("promoted");
    await updateRule(ctx, id, { priority: 2 });
    await updateRule(ctx, id, { enabled: false });
    const r = await row();
    expect(r.priority).toBe(2);
    expect(r.enabled).toBe(false);
    expect(r.provenance).toBe("promoted");
  });
});
