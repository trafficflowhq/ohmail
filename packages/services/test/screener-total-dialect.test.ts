import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accounts, folderState, mailboxes, messages, organizerRequests, rules,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "../src/index.js";

/**
 * THE QUEUE'S SIZE, ON BOTH STORES. `GET /screener` states `total` on its first page so a client
 * can show the count of the whole queue while holding one page of it. Run in the default project
 * and in `pnpm test:sqlite`, because the standalone phone serves this route from the device
 * store. `screener-total.pg.test.ts` is the same fixture on the server's own Postgres.
 */

const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-26T09:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 86_400_000);

type World = Awaited<ReturnType<typeof world>>;

async function world(label: string) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `stt-${label}-${accountId.slice(0, 8)}` });
  const own = `own-${accountId.slice(0, 8)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: own }).returning();
  return { db, accountId, mailboxId: mb!.id, own };
}

let n = 0;
async function hold(w: World, from: string, ageMs = 0): Promise<string> {
  const i = n++;
  const at = new Date(RECENT.getTime() - ageMs);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `stt:${randomUUID()}`,
    subject: `Note ${i}`, snippet: `snippet ${i}`, fromAddress: from, date: at, createdAt: at,
    nativeLocator: { folder: GATE, ref: `1:${i}` },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const ctxOf = (w: World): ServiceContext => ({
  db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `stt-${randomUUID().slice(0, 8)}`,
});

async function walk(w: World, limit: number): Promise<{ senders: string[]; totals: Array<number | undefined> }> {
  const svc = new ScreenerService({});
  const senders: string[] = [];
  const totals: Array<number | undefined> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const p = await svc.list(ctxOf(w), { limit, ...(cursor ? { cursor } : {}) });
    senders.push(...p.items.map((i) => i.sender.address.toLowerCase()));
    totals.push(p.total);
    if (p.nextCursor === null) return { senders, totals };
    cursor = p.nextCursor;
  }
  throw new Error("the walk did not end");
}

describe("GET /screener states the whole queue's size, on either store", () => {
  it("counts held senders minus decided and own: held 3, decided 1, own 1 -> 1", async () => {
    const w = await world("a");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@x.test", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await hold(w, "stranger@x.test");
    await hold(w, "stranger@x.test", 60_000);
    await hold(w, "ruled@x.test");
    await hold(w, w.own);

    const page = await new ScreenerService({}).list(ctxOf(w));
    expect(page.items.map((i) => i.sender.address)).toEqual(["stranger@x.test"]);
    expect(page.total).toBe(1);
  });

  it("is the account's own count: another account's held senders read 0 here", async () => {
    const busy = await world("busy");
    await hold(busy, "one@y.test");
    await hold(busy, "two@y.test");
    const quiet = await world("quiet");

    expect((await new ScreenerService({}).list(ctxOf(busy))).total).toBe(2);
    const page = await new ScreenerService({}).list(ctxOf(quiet));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("equals a walk of every page, and only the first page states it", async () => {
    const w = await world("walk");
    for (let s = 0; s < 7; s++) await hold(w, `s${s}@z.test`, s * 60_000);
    const { senders, totals } = await walk(w, 2);
    expect(new Set(senders).size).toBe(7);
    expect(totals[0]).toBe(7);
    expect(totals.slice(1).every((t) => t === undefined)).toBe(true);
  });

  it("leaves out a sender an in-flight decision already took off every page", async () => {
    const w = await world("out");
    await hold(w, "decided@q.test");
    await hold(w, "a@dom.test");
    await hold(w, "b@dom.test");
    await hold(w, "left@q.test");
    await w.db.insert(organizerRequests).values([
      { accountId: w.accountId, mailboxId: w.mailboxId, kind: "screener.decide",
        payload: { scope: "sender", match: "decided@q.test" }, decidedAt: NOW, state: "pending" },
      { accountId: w.accountId, mailboxId: w.mailboxId, kind: "screener.decide",
        payload: { scope: "domain", match: "dom.test" }, decidedAt: NOW, state: "sent" },
    ]);
    const { senders, totals } = await walk(w, 1);
    expect(senders).toEqual(["left@q.test"]);
    expect(totals[0]).toBe(1);
  });
});
