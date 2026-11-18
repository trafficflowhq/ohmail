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
 * A rule PATCH compares WHERE a rule files, not how the folder is spelled. Rules stored before the
 * News rename say `ohmail/Reads`; a PATCH naming the same place keeps that spelling and is not a
 * retarget, so it re-walks no backlog unless it asks (`applyRetro: true`). A move elsewhere still
 * retargets.
 */

const NOW = new Date("2026-09-25T12:00:00Z");
const DONE = new Date("2026-09-25T09:00:00Z");

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `place-${accountId.slice(0, 8)}` });
  return { db, ctx: { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext };
}

/** A rule as a pre-rename install stored it, its backlog walk already finished. */
async function storedRule(db: Db, ctx: ServiceContext, destination: string): Promise<string> {
  const { rule } = mutated(await rulesService.create(ctx, {
    kind: "sender", match: `${randomUUID()}@digest.example`, destination: "ohmail/News",
  }));
  await db.update(rules)
    .set({ destination, retroRequestedAt: DONE, retroDoneAt: DONE, retroCursor: randomUUID(), retroMoved: 7 })
    .where(eq(rules.id, rule.id));
  return rule.id;
}

const row = async (db: Db, id: string) => (await db.select().from(rules).where(eq(rules.id, id)))[0]!;

describe("a rule PATCH compares the place, not the spelling", () => {
  it("the new spelling of a pre-rename rule's place moves nothing and keeps the stored name", async () => {
    const { db, ctx } = await world();
    const id = await storedRule(db, ctx, "ohmail/Reads");
    mutated(await rulesService.update(ctx, id, { destination: "ohmail/News" }));
    const r = await row(db, id);
    expect.soft(r.destination).toBe("ohmail/Reads");
    expect.soft(r.retroDoneAt, "a same-place PATCH re-walked the backlog").toEqual(DONE);
    expect(r.retroMoved).toBe(7);
  });

  it("the stored spelling sent back as is moves nothing either", async () => {
    const { db, ctx } = await world();
    const id = await storedRule(db, ctx, "ohmail/Reads");
    mutated(await rulesService.update(ctx, id, { destination: "ohmail/Reads" }));
    const r = await row(db, id);
    expect.soft(r.destination).toBe("ohmail/Reads");
    expect.soft(r.retroDoneAt).toEqual(DONE);
  });

  it("the re-arm (same place, applyRetro: true) re-walks the backlog and keeps the stored name", async () => {
    const { db, ctx } = await world();
    const id = await storedRule(db, ctx, "ohmail/Reads");
    mutated(await rulesService.update(ctx, id, { destination: "ohmail/Reads", applyRetro: true }));
    const r = await row(db, id);
    expect(r.destination).toBe("ohmail/Reads");
    expect(r.retroRequestedAt).toEqual(NOW);
    expect(r.retroDoneAt).toBeNull();
    expect(r.retroMoved).toBe(0);
  });

  it("a rule stored as News keeps News when the old spelling is sent (control)", async () => {
    const { db, ctx } = await world();
    const id = await storedRule(db, ctx, "ohmail/News");
    mutated(await rulesService.update(ctx, id, { destination: "ohmail/Reads" }));
    const r = await row(db, id);
    expect(r.destination).toBe("ohmail/News");
    expect(r.retroDoneAt).toEqual(DONE);
  });

  it("a move to another place still retargets (control)", async () => {
    const { db, ctx } = await world();
    const id = await storedRule(db, ctx, "ohmail/Reads");
    mutated(await rulesService.update(ctx, id, { destination: "ohmail/Receipts" }));
    const r = await row(db, id);
    expect(r.destination).toBe("ohmail/Receipts");
    expect(r.retroRequestedAt).toEqual(NOW);
    expect(r.retroDoneAt).toBeNull();
  });
});
