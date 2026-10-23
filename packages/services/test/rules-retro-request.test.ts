import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules } from "@trafficflow/db";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/* Every case in this file runs as the ORGANIZER, where a rule edit is written locally. `create`
 * and `update` answer a union — that mutation, or a request routed to the install that organizes
 * the mailbox — so the local arm is narrowed once here instead of at each call: `mutated` refuses
 * the routed arm by name, where a cast would leave `rule` reading as `undefined`. */
const createRule = async (...a: Parameters<typeof rulesService.create>) =>
  mutated(await rulesService.create(...a));
const updateRule = async (...a: Parameters<typeof rulesService.update>) =>
  mutated(await rulesService.update(...a));

/**
 * WHO ASKS FOR A RULE TO REACH MAIL THAT IS ALREADY FILED.
 *
 * The service's whole job here is one column. `rules.retro_requested_at` set with
 * `retro_done_at` NULL is the only definition of owed work in the system; the worker's
 * `ruleRetroPass` reads exactly that and nothing else. So these tests are about the REQUEST —
 * that it defaults on, that declining it is honoured, and that a retarget re-asks — and the work
 * itself is proven in `apps/worker/test/rule-retro.test.ts`.
 *
 * The retarget case is the one that would otherwise be missed, and it is not an edge: the sender
 * sheet refuses to write a second rule for a subject it already covers (two `manual` rules with
 * the same kind, match, priority and effect tie down to an arbitrary id tie-break in
 * `core/rules.ts#compareRules`), so a user changing their mind about a sender they have already
 * ruled on takes the PATCH path, not the POST one. A retarget that re-applied to nothing while
 * the sheet said otherwise would be the shipped feature quietly not working for its commonest
 * case.
 */

const NOW = new Date("2026-08-04T12:00:00Z");

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `retro-${accountId.slice(0, 8)}` });
  const ctx = { db, accountId, now: () => NOW } as unknown as ServiceContext;
  return { db, ctx };
}

const row = async (db: Db, id: string) => {
  const [r] = await db.select().from(rules).where(eq(rules.id, id));
  return r!;
};

const BODY = { kind: "sender", match: "news@atelier.example", destination: "ohmail/News" };

describe("the retroactive request on create", () => {
  it("is ON when the caller says nothing — a DEFAULT, not an option", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });

    const stored = await row(db, rule.id);
    expect(stored.retroRequestedAt).toEqual(NOW);
    expect(stored.retroDoneAt, "nothing has run yet — owed, not done").toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
  });

  it("is OFF when the caller declines, and that is the only thing that turns it off", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, applyRetro: false });

    // NULL, not a stamped-then-cleared value: nobody ever asked, which is a different fact from
    // "asked and finished" and is what the worker's owed predicate distinguishes.
    expect((await row(db, rule.id)).retroRequestedAt).toBeNull();
  });

  it("refuses a non-boolean rather than coercing it", async () => {
    const { ctx } = await world();
    // `applyRetro: "false"` is TRUTHY in JavaScript. Reading a client's attempt to decline as
    // consent to reorganize a mailbox is the failure this check exists for, so it is a 400.
    await expect(
      createRule(ctx, { ...BODY, applyRetro: "false" as unknown as boolean }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });
});

describe("a RETARGET asks again, because the destination changed", () => {
  it("re-requests and CLEARS the marker and cursor when the destination moves", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    // Pretend the pass finished it.
    await db.update(rules)
      .set({ retroDoneAt: NOW, retroCursor: randomUUID(), retroMoved: 12 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { destination: "ohmail/Receipts" });

    const stored = await row(db, rule.id);
    expect(stored.destination).toBe("ohmail/Receipts");
    expect(stored.retroRequestedAt).toEqual(NOW);
    // The WHOLE state is reset, not just the request. Mail this rule already moved to the OLD
    // destination is a candidate again, and a stale cursor would skip everything before it.
    expect(stored.retroDoneAt).toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
  });

  it("does NOT re-request for a PATCH that does not carry the flag and moves nothing", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done, retroMoved: 12 }).where(eq(rules.id, rule.id));

    // A PATCH that re-states the destination it already has, which is what a habit-click sends.
    await updateRule(ctx, rule.id, { destination: "ohmail/News" });

    const stored = await row(db, rule.id);
    expect(stored.retroDoneAt, "re-applying finished work on every PATCH").toEqual(done);
    expect(stored.retroMoved).toBe(12);
  });

  it("does NOT re-request for a PATCH that only pauses the rule", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { enabled: false });

    // Nothing about where this rule sends mail moved, so there is nothing to re-apply.
    expect((await row(db, rule.id)).retroDoneAt).toEqual(done);
  });

  /**
   * THE PAIR THAT IS THE RULING, and either half alone is satisfied by the wrong implementation:
   * gate the re-arm on `validApplyRetro` (absent ⇒ true) and the case above goes red; drop the
   * explicit arm and this one does. A rule already pointing where the person wants is the only
   * rule they cannot otherwise ask for the backlog — the sheet's *also move the mail already in
   * your mailbox*, pressed on a sender who already has a rule.
   */
  it("re-requests when the caller EXPLICITLY asks, even though the destination did not move", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules)
      .set({ retroDoneAt: done, retroCursor: randomUUID(), retroMoved: 12 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { destination: "ohmail/News", applyRetro: true });

    const stored = await row(db, rule.id);
    expect(stored.destination, "nothing about the routing moved").toBe("ohmail/News");
    expect(stored.retroRequestedAt).toEqual(NOW);
    // The whole state resets, exactly as a retarget's does: a stale cursor would resume at the end
    // of the previous walk and reconsider nothing.
    expect(stored.retroDoneAt).toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
    // …and `release_held_at` stays null, so `rule-retro.ts#isReleaseRun` reads this as an ordinary
    // unnarrowed retro rather than the gate-only release walk.
    expect(stored.releaseHeldAt).toBeNull();
  });

  it("honours a DECLINED retro on a retarget — the user may retarget without re-applying", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, {
      destination: "ohmail/Receipts", applyRetro: false,
    });

    const stored = await row(db, rule.id);
    expect(stored.destination).toBe("ohmail/Receipts");
    expect(stored.retroDoneAt, "the opt-out must work on the retarget path too").toEqual(done);
  });
});

describe("a DECLINED edit of a rule still walking its backlog ends the walk", () => {
  /* "The rest of their mail here stays where it is": a walk left owed (parked behind a mailbox this
     install only reads) would otherwise re-arm later and file that rest by the edited rule. */
  const PARKED = "ffffffff-ffff-ffff-0000-000000000001";
  const owed = async (body: Record<string, unknown>) => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, ...body });
    await db.update(rules).set({ retroCursor: PARKED, retroMoved: 3 }).where(eq(rules.id, rule.id));
    return { db, ctx, id: rule.id };
  };

  it("on a retarget", async () => {
    const { db, ctx, id } = await owed({});
    await updateRule(ctx, id, { destination: "ohmail/Receipts", applyRetro: false });

    const stored = await row(db, id);
    expect(stored.retroDoneAt, "a declined retarget left the walk owed").toEqual(NOW);
    expect(stored.retroCursor).toBe(PARKED);
    expect(stored.retroMoved).toBe(3);
  });

  it("on a term edit", async () => {
    const { db, ctx, id } = await owed({ subjectContains: "invoice" });
    await updateRule(ctx, id, { subjectContains: "receipt", applyRetro: false });

    expect((await row(db, id)).retroDoneAt, "a declined term edit left the walk owed").toEqual(NOW);
  });
});
