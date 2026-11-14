import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accounts, accountSettings, folderState, mailboxes, mailboxProfileMirror, messages,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { ScreenerService, cutlineCounts, effectiveScreeningWindows, type ServiceContext } from "../src/index.js";

/**
 * EACH MAILBOX IS SCREENED BY ITS ORGANIZER'S WINDOW (RULING-026), ON BOTH STORES. A reader applies
 * the window the organizer published (`organizer`); with no document (`unread`) or one stating no
 * window (`unstated`) it lists the Screener folder whole; an organizer applies its own (`own`). The
 * reader's own row is inert on a mailbox it reads (a held press recorded one there).
 * Run in the default project and in `pnpm test:sqlite`: the standalone phone serves the queue from
 * the device store.
 */

const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-12T01:00:00.000Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
const RECENT = "recent@sender.test";
const OLD = "only-old-letters@sender.test";

type Role = "reader" | "organizer";
type Window = { baselineAt: string | null; dormancyDays: number; scope: "window" | "all_time" };

async function world(o: { ownBaseline?: Date | null; ownDays?: number; mailboxes: Array<{ role: Role; published?: Window | "none" | "no-key" }> }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `uqg-${accountId.slice(0, 8)}` });
  if (o.ownBaseline != null || o.ownDays !== undefined) {
    await db.insert(accountSettings).values({ accountId, screeningBaselineAt: o.ownBaseline ?? null, dormancyDays: o.ownDays ?? null });
  }
  const ids: string[] = [];
  for (const [i, m] of o.mailboxes.entries()) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `own${i}-${accountId.slice(0, 8)}@example.test`, organizerRole: m.role,
      ...(m.role === "reader" ? { organizedByKind: "local", organizedByName: "Studio Mac" } : {}),
    }).returning();
    ids.push(mb!.id);
    if (m.published !== undefined && m.published !== "none") {
      const doc = {
        v: 2, updatedAt: daysAgo(0).toISOString(), producer: { kind: "local", version: "t" },
        screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
        ...(m.published === "no-key" ? {} : { screening: m.published }),
      };
      await db.insert(mailboxProfileMirror).values({
        mailboxId: mb!.id, accountId, uidvalidity: 7n, uid: 1, doc, readAt: daysAgo(0),
      });
    }
  }
  let n = 0;
  const hold = async (mailbox: number, from: string, at: Date, unread: boolean): Promise<void> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: ids[mailbox]!, bodyHash: `h${i}`, dedupKey: `uqg:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date: at, arrivedAt: at, createdAt: at, unread,
      nativeLocator: { folder: GATE, ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: `uqg-${randomUUID().slice(0, 8)}`,
  };
  return { ctx, db, ids, hold };
}

/** The tester's shape in one mailbox: a recent unread sender, and one whose letters are read and old. */
async function testersShape(w: Awaited<ReturnType<typeof world>>, mailbox = 0): Promise<void> {
  await w.hold(mailbox, RECENT, daysAgo(2), true);
  await w.hold(mailbox, OLD, daysAgo(96), false);
  await w.hold(mailbox, OLD, daysAgo(150), false);
}

async function queue(ctx: ServiceContext): Promise<{ senders: string[]; total: number | undefined; counted: number }> {
  const page = await new ScreenerService({}).list(ctx, { limit: 50 });
  const counts = await cutlineCounts(ctx, { windows: await effectiveScreeningWindows(ctx) });
  return { senders: page.items.map((i) => i.sender.address).sort(), total: page.total, counted: counts.activeUndecidedSenders };
}

const WINDOW_30: Window = { baselineAt: daysAgo(1).toISOString(), dormancyDays: 30, scope: "window" };
const WINDOW_365: Window = { baselineAt: daysAgo(1).toISOString(), dormancyDays: 365, scope: "window" };

describe("a reading install's queue reads the organizer's window", () => {
  it("unread (no document yet): the folder whole, whatever answer this store recorded", async () => {
    const w = await world({ ownBaseline: daysAgo(1), mailboxes: [{ role: "reader" }] });
    await testersShape(w);
    expect(await queue(w.ctx)).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
    expect((await effectiveScreeningWindows(w.ctx)).get(w.ids[0]!)?.source).toBe("unread");
  });

  it("unstated (a document from an organizer that states no window): the folder whole", async () => {
    const w = await world({ ownBaseline: daysAgo(1), mailboxes: [{ role: "reader", published: "no-key" }] });
    await testersShape(w);
    expect(await queue(w.ctx)).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
    const win = (await effectiveScreeningWindows(w.ctx)).get(w.ids[0]!);
    expect(win?.source).toBe("unstated");
    expect(win?.holder?.name).toBe("Studio Mac");
  });

  it("organizer (a published 30-day window): the organizer's view — the old read sender retired", async () => {
    const w = await world({ mailboxes: [{ role: "reader", published: WINDOW_30 }] });
    await testersShape(w);
    expect(await queue(w.ctx)).toEqual({ senders: [RECENT], total: 1, counted: 1 });
  });

  it("the organizer's dial moved to 365 days: the old sender is back, with no press here", async () => {
    const w = await world({ ownDays: 7, mailboxes: [{ role: "reader", published: WINDOW_365 }] });
    await testersShape(w);
    expect(await queue(w.ctx)).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
  });

  it("CONTROL: an organizing install keeps its own window", async () => {
    const w = await world({ ownBaseline: daysAgo(1), mailboxes: [{ role: "organizer", published: WINDOW_365 }] });
    await testersShape(w);
    expect(await queue(w.ctx)).toEqual({ senders: [RECENT], total: 1, counted: 1 });
  });
});

describe("mixed role: one window per mailbox", () => {
  it("old read mail in the organized mailbox, fresh mail in the read one: listed once", async () => {
    const w = await world({ ownBaseline: daysAgo(1), mailboxes: [{ role: "organizer" }, { role: "reader", published: WINDOW_30 }] });
    await w.hold(0, OLD, daysAgo(150), false);
    await w.hold(1, OLD, daysAgo(3), false);
    expect(await queue(w.ctx)).toEqual({ senders: [OLD], total: 1, counted: 1 });
  });

  it("reversed: old read mail in the read mailbox only, a long window of this install's own — not listed", async () => {
    // The organizer's 30 days retire the sender; this install's own 365 days, if applied, would not.
    const w = await world({ ownBaseline: daysAgo(1), ownDays: 365, mailboxes: [{ role: "organizer" }, { role: "reader", published: WINDOW_30 }] });
    await w.hold(1, OLD, daysAgo(150), false);
    expect(await queue(w.ctx)).toEqual({ senders: [], total: 0, counted: 0 });
  });

  it("the read mailbox's longer window keeps a sender the organized one's retires", async () => {
    const w = await world({ ownBaseline: daysAgo(1), mailboxes: [{ role: "organizer" }, { role: "reader", published: WINDOW_365 }] });
    await w.hold(0, RECENT, daysAgo(2), true);
    await w.hold(1, OLD, daysAgo(150), false);
    expect(await queue(w.ctx)).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
  });
});

describe("a fresh reader before its first lease peek, in today's state", () => {
  it("organizer_role defaults to organizer, so the install's own window applies until a peek writes reader", async () => {
    const w = await world({ ownBaseline: daysAgo(1), ownDays: 30, mailboxes: [] });
    // A mailbox row as a fresh attach writes it: no role stated, so the column's default.
    const [mb] = await w.db.insert(mailboxes).values({
      accountId: w.ctx.accountId, provider: "imap", address: `fresh-${w.ctx.accountId.slice(0, 8)}@example.test`,
    }).returning();
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId: mb!.id, accountId: w.ctx.accountId, uidvalidity: 7n, uid: 1, readAt: daysAgo(0),
      doc: { v: 2, updatedAt: daysAgo(0).toISOString(), producer: { kind: "local", version: "t" }, screening: WINDOW_365 },
    });
    const win = (await effectiveScreeningWindows(w.ctx)).get(mb!.id);
    expect(win).toMatchObject({ source: "own", dormancyDays: 30 });
    // …and the first peek that writes `reader` hands it to the organizer's window, with no other change.
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mb!.id));
    expect((await effectiveScreeningWindows(w.ctx)).get(mb!.id)).toMatchObject({ source: "organizer", dormancyDays: 365 });
  });
});

describe("the resolver is the account's own", () => {
  it("a foreign account's mirror row under this mailbox's id is not read", async () => {
    const w = await world({ mailboxes: [{ role: "reader" }] });
    const foreign = randomUUID();
    await w.db.insert(accounts).values({ id: foreign, name: `uqg-f-${foreign.slice(0, 8)}` });
    // The composite key refuses this row; the join's account term is the second ring, so the
    // plant goes past the first (each store's own switch) to measure the second alone.
    const d = dialect(w.db as never);
    await d.exec(w.db as never, d.name === "sqlite" ? sql`PRAGMA foreign_keys = OFF` : sql`SET session_replication_role = replica`);
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId: w.ids[0]!, accountId: foreign, uidvalidity: 7n, uid: 1, readAt: daysAgo(0),
      doc: { v: 2, updatedAt: daysAgo(0).toISOString(), producer: { kind: "local", version: "t" }, screening: WINDOW_30 },
    });
    expect((await effectiveScreeningWindows(w.ctx)).get(w.ids[0]!)?.source).toBe("unread");
  });
});
