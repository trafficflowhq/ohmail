import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "../src/index.js";
import { ctxOf, cutlineMatchesGrouped, seed, walksMatch } from "./_screener-same-answer.js";

/**
 * THE SCREENER'S READS ANSWER WHAT THEY ANSWERED BEFORE THEY WERE MADE CHEAP, here, on the device's
 * store (`pnpm test:sqlite`) and on the server's (`.pg`). The old shapes are kept verbatim in
 * `_screener-same-answer.ts` — the cutline grouped per sender, the claim asked of every sender, whole
 * rows through the window, `total` from a second statement — and every page of every walk and the
 * first page's total must match under no cutline, a window with and without a baseline, all time and
 * a window per mailbox. Watched red: the claim gate reading `sender_marked = 0`; the per-message
 * cutline retiring a mailbox its set does not name; the total counting in-flight senders as waiting.
 */

describe("the Screener's reads answer what they answered before", () => {
  it("the cutline asked per message names the same senders as the grouped form, under every window", async () => {
    await cutlineMatchesGrouped(await seed());
  });

  it("every page of every walk and the first page's total are equal, row for row", async () => {
    await walksMatch(await seed());
  });

  it("the route states the first page's total, and an empty queue states 0", async () => {
    const w = await seed();
    const svc = new ScreenerService({});
    const page = await svc.list(ctxOf(w), { limit: 5 });
    expect(page.total).toBeGreaterThan(0);
    const quiet = await makeTestDb();
    const accountId = randomUUID();
    await quiet.insert(accounts).values({ id: accountId, name: `quiet-${accountId.slice(0, 8)}` });
    const empty = await svc.list({ ...ctxOf(w), db: quiet as unknown as ServiceContext["db"], accountId });
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
  });
});
