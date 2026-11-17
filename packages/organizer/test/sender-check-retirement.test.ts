import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import {
  senderCheckBackfillPass, senderCheckRetirement, type SenderCheckBackfillResult,
} from "../src/sender-check-backfill.js";

/**
 * THE IDENTITY BACKFILL RETIRES (IDENTITY-BACKFILL-NEVER-RETIRES): an account whose call answered
 * both sets empty costs no page on later tails, and a row entering the scope unchecked re-arms
 * that account alone. Each walk is driven the way the cycle tail drives it: `enter` once, then
 * `run` for every account it returned; the counter is the pass's own calls.
 */
async function world(opts: { now?: () => number; overlapMs?: number } = {}) {
  const db = await makeTestDb();
  const mk = async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `scr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@scr.invalid` }).returning();
    return { accountId, mailboxId: mb!.id };
  };
  const a = await mk();
  const b = await mk();
  const row = async (who: { accountId: string; mailboxId: string }, folder: string, check: "none" | null = null) => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: who.accountId, mailboxId: who.mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "Hallo", fromAddress: "x@gmail.invalid", fromName: "PostFinance", nativeLocator: { folder, ref: "1:1" },
      senderCheck: check,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled",
    });
    return m!.id;
  };
  const checkOf = async (id: string) =>
    (await db.select({ c: messages.senderCheck }).from(messages).where(eq(messages.id, id)))[0]!.c;
  const calls: Array<{ accountId: string; r: SenderCheckBackfillResult }> = [];
  const tail = senderCheckRetirement({
    ...opts,
    pass: async (h, d) => {
      const r = await senderCheckBackfillPass(h, d);
      calls.push({ accountId: d.accountId, r });
      return r;
    },
  });
  /** One cycle-tail walk over both accounts; the accounts the section walked. */
  const walk = async (handle: Tx = db as unknown as Tx) => {
    const list = await tail.enter(handle, [a.accountId, b.accountId]);
    for (const id of list) await tail.run(handle, id);
    return list;
  };
  const emptyPages = (accountId: string) =>
    calls.filter((c) => c.accountId === accountId && c.r.checked === 0).length;
  const pages = (accountId: string) => calls.filter((c) => c.accountId === accountId).length;
  return { db, a, b, row, checkOf, walk, emptyPages, pages, calls };
}

const N = 6;

describe("the identity backfill retires per account", () => {
  it("RED: one empty page per account across N walks, where the walk without the retirement pays N", async () => {
    const w = await world();
    const owed = await w.row(w.a, "INBOX");
    await w.row(w.b, "Archive");
    for (let i = 0; i < N; i++) await w.walk();
    expect(await w.checkOf(owed), "the backlog is still worked").toBe("impersonation");
    expect(w.pages(w.a.accountId), "A: one page with its row, then retired").toBe(1);
    expect(w.emptyPages(w.b.accountId), "B: one empty page, then retired").toBe(1);

    // The control through the same counter: the base's composition, the pass on every walk.
    const base = await world();
    await base.row(base.b, "Archive");
    let baseEmpty = 0;
    for (let i = 0; i < N; i++) {
      const r = await senderCheckBackfillPass(base.db as unknown as Tx, { accountId: base.b.accountId });
      if (r.checked === 0) baseEmpty++;
    }
    expect(baseEmpty).toBe(N);
  });

  it("RED: a new unchecked row re-arms exactly its account, and an archived row moved into the Ohbox does too", async () => {
    const w = await world();
    await w.walk();
    await w.walk();
    expect(w.pages(w.a.accountId) + w.pages(w.b.accountId)).toBe(2);

    const arrived = await w.row(w.a, "ohmail/Screener");
    expect(await w.walk(), "only A is walked").toEqual([w.a.accountId]);
    expect(await w.checkOf(arrived)).toBe("impersonation");
    expect(await w.walk(), "A retired again in the same call").toEqual([]);

    const archived = await w.row(w.b, "Archive");
    expect(await w.walk()).toEqual([]);
    await w.db.update(folderState).set({ desiredFolder: "INBOX", updatedAt: new Date() })
      .where(eq(folderState.messageId, archived));
    expect(await w.walk(), "only B is walked").toEqual([w.b.accountId]);
    expect(await w.checkOf(archived)).toBe("impersonation");
    expect(w.pages(w.a.accountId)).toBe(2);
    expect(w.pages(w.b.accountId)).toBe(2);
  });

  it("a checked arrival re-arms nobody, and neither does an unchecked row outside the scope", async () => {
    const w = await world();
    await w.walk();
    await w.row(w.a, "INBOX", "none");
    await w.row(w.b, "Sent");
    expect(await w.walk()).toEqual([]);
  });

  it("a writer clock behind the worker's, inside the overlap, still re-arms; with no overlap it is missed", async () => {
    const ahead = () => Date.now() + 5 * 60_000;
    const w = await world({ now: ahead });
    await w.walk();
    const late = await w.row(w.a, "INBOX");
    expect(await w.walk()).toEqual([w.a.accountId]);
    expect(await w.checkOf(late)).toBe("impersonation");

    const blind = await world({ now: ahead, overlapMs: 0 });
    await blind.walk();
    await blind.row(blind.a, "INBOX");
    expect(await blind.walk(), "the control: the overlap is what catches it").toEqual([]);
  });

  it("a failed re-arm read re-arms nobody and keeps the readings, so the next walk covers its window", async () => {
    // No overlap and a worker clock that moves past the row's stamp before the failed read: only
    // the KEPT reading reaches that row.
    let clock = Date.now() - 60_000;
    const w = await world({ now: () => clock, overlapMs: 0 });
    await w.walk();
    const owed = await w.row(w.a, "INBOX");
    clock = Date.now() + 60_000;
    let fail = true;
    const flaky = new Proxy(w.db, {
      get(t, k, r) {
        if (k === "selectDistinct" && fail) { fail = false; return () => { throw new Error("db down"); }; }
        return Reflect.get(t, k, r);
      },
    }) as unknown as Tx;
    expect(await w.walk(flaky)).toEqual([]);
    expect(fail, "the read was attempted").toBe(false);
    expect(await w.walk()).toEqual([w.a.accountId]);
    expect(await w.checkOf(owed)).toBe("impersonation");
  });

  it("source-less contacts past one batch keep the account walking until they are done", async () => {
    const w = await world();
    await w.db.insert(contacts).values(Array.from({ length: 5001 }, (_, i) => ({
      accountId: w.a.accountId, address: `c${i}@firma.invalid`, source: null,
    })));
    expect(await w.walk()).toEqual([w.a.accountId, w.b.accountId]);
    expect(w.calls[0]!.r).toMatchObject({ done: true, contactsDone: false });
    expect(await w.walk(), "A again for its last contact").toEqual([w.a.accountId]);
    expect(await w.walk()).toEqual([]);
    const left = await w.db.select({ n: sql<number>`count(*)` }).from(contacts).where(sql`${contacts.source} is null`);
    expect(Number(left[0]!.n)).toBe(0);
  });

  it("an account that leaves the walk forgets its retirement and pays one page when it returns", async () => {
    const w = await world();
    const tail = senderCheckRetirement();
    const db = w.db as unknown as Tx;
    for (const id of await tail.enter(db, [w.a.accountId])) await tail.run(db, id);
    expect(await tail.enter(db, [w.a.accountId])).toEqual([]);
    expect(await tail.enter(db, [w.b.accountId])).toEqual([w.b.accountId]);
    expect(await tail.enter(db, [w.a.accountId])).toEqual([w.a.accountId]);
  });
});
