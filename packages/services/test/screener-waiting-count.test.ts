import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { waitingFixture } from "./_screener-waiting-count.js";

/**
 * THE WAITING SENDERS OF ONE MAILBOX (R20-03). Setup for an added mailbox said "37 senders are
 * waiting" — the whole install's queue — one screen after counting that mailbox's own 24. The
 * first decision's sentence names the Screener's queue, so its count is the queue's own statement
 * (activity in any mailbox, decided and own excluded, in-flight decisions subtracted) narrowed to
 * senders with held mail in the mailbox. A sender held in two mailboxes counts in each.
 *
 * Mutations watched: drop the mailbox filter (the first mailbox reads 4); drop the cutline term (d counts);
 * drop the in-flight subtraction (f counts); limit activity to the mailbox (g is lost).
 */

describe("ScreenerReadService.waitingCount", () => {
  it("counts each mailbox's own waiting senders", async () => {
    const w = await waitingFixture(await makeTestDb());
    expect(await w.svc.waitingCount(w.ctx(), w.m1)).toEqual({ senders: 3 });
    expect(await w.svc.waitingCount(w.ctx(), w.m2)).toEqual({ senders: 2 });
  });

  it("equals the queue's own senders with held mail in that mailbox, walking every page", async () => {
    const w = await waitingFixture(await makeTestDb());
    const listed = await w.listed();
    expect(new Set(listed)).toEqual(new Set(["a@x.test", "b@x.test", "c@x.test", "g@x.test"]));
    for (const mb of [w.m1, w.m2]) {
      const here = [];
      for (const s of listed) if (await w.heldIn(mb, s)) here.push(s);
      expect((await w.svc.waitingCount(w.ctx(), mb)).senders, mb).toBe(here.length);
    }
  });

  it("CONTROL: on a single mailbox it equals the queue's total", async () => {
    const w = await waitingFixture(await makeTestDb(), { single: true });
    const page = await w.svc.list(w.ctx());
    expect(page.total).toBe(4);
    expect(await w.svc.waitingCount(w.ctx(), w.m1)).toEqual({ senders: page.total });
  });

  it("another account's mailbox is 404, and so is a removed one", async () => {
    const db = await makeTestDb();
    const w = await waitingFixture(db);
    const other = randomUUID();
    await db.insert(accounts).values({ id: other, name: "swc-other" });
    await expect(w.svc.waitingCount(w.ctx(other), w.m1)).rejects.toMatchObject({ httpStatus: 404 });
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.m2));
    await expect(w.svc.waitingCount(w.ctx(), w.m2)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
