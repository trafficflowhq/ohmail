import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, accountSettings, changeLog, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { screenUnscreened, unscreenedSummary, type ServiceContext } from "../src/mail.js";

/**
 * SCREEN N LEAVES A PLACE SOMEBODY DECIDED, as the organize decision's walk does, through the one
 * predicate both scopes ask: an answer the gate admitted for itself alone, and a letter the person
 * filed into the INBOX, are neither counted nor screened. Undecided mail of the same senders' kind
 * still is. And it takes only letters inside the account's window, as the window step promised:
 * older mail and mail with no recorded arrival stay in the Inbox, untouched. Run in both projects
 * (PGlite here, `pnpm test:sqlite`).
 */

const OHBOX = "INBOX";
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-10T09:00:00.000Z");
const ARRIVED = new Date("2026-10-01T08:00:00.000Z");
const DAY = 86_400_000;

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `uod-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `uod-${accountId.slice(0, 8)}@example.test`, organizerRole: "organizer",
  }).returning();
  // A one-year window, as the window step stores it.
  await db.insert(accountSettings).values({ accountId, screeningBaselineAt: NOW, dormancyDays: 365, screeningScope: "window" });
  let n = 0;
  const letter = async (
    from: string, placed: { setBy: "us" | "external"; decidedAt: Date | null }, arrivedAt: Date | null = ARRIVED,
    date: Date = arrivedAt ?? ARRIVED,
  ): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `uod:${randomUUID()}`, subject: `Note ${i}`,
      fromAddress: from, date, createdAt: ARRIVED, arrivedAt, unread: true,
      nativeLocator: { folder: OHBOX, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: placed.setBy,
      reconcileStatus: "reconciled", conflict: false, decidedAt: placed.decidedAt,
    });
    return m!.id;
  };
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: `uod-${randomUUID().slice(0, 8)}`,
  };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  /** Where the letter is, whether it is unread, and how many change rows name it. */
  const untouched = async (id: string) => {
    const [fs] = await db.select({ d: folderState.desiredFolder, o: folderState.observedFolder })
      .from(folderState).where(eq(folderState.messageId, id));
    const [m] = await db.select({ unread: messages.unread }).from(messages).where(eq(messages.id, id));
    const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, id)));
    return { desired: fs!.d, observed: fs!.o, unread: m!.unread, changes: rows.length };
  };
  return { db, accountId, ctx, letter, desired, untouched };
}

describe("Screen N leaves a place somebody decided", () => {
  it("counts the undecided letter and neither the admitted answer nor the person's own filing", async () => {
    const w = await world();
    await w.letter("stranger@x.test", { setBy: "external", decidedAt: null });
    await w.letter("answerer@x.test", { setBy: "us", decidedAt: new Date("2026-10-02T08:00:00.000Z") });
    await w.letter("filed@x.test", { setBy: "external", decidedAt: new Date("2026-10-03T08:00:00.000Z") });
    // CONTROL: undecided too, but older than the window.
    await w.letter("olden@x.test", { setBy: "external", decidedAt: null }, new Date(NOW.getTime() - 800 * DAY));
    const summary = await unscreenedSummary(w.db as never, w.accountId, NOW);
    expect(summary.groups.map((g) => g.address)).toEqual(["stranger@x.test"]);
    expect(summary.total).toBe(1);
  });

  it("the press screens only the undecided letter", async () => {
    const w = await world();
    const open = await w.letter("stranger@x.test", { setBy: "external", decidedAt: null });
    const answer = await w.letter("answerer@x.test", { setBy: "us", decidedAt: new Date("2026-10-02T08:00:00.000Z") });
    const pressed = await screenUnscreened(w.ctx);
    expect(pressed.total).toBe(1);
    expect([await w.desired(open), await w.desired(answer)]).toEqual([GATE, OHBOX]);
  });
});

describe("Screen N takes only the letters inside the window", () => {
  const stay = { desired: OHBOX, observed: OHBOX, unread: true, changes: 0 };

  it("a letter 800 days old, and one with no recorded arrival, are neither counted nor moved", async () => {
    const w = await world();
    const fresh = await w.letter("fresh@x.test", { setBy: "external", decidedAt: null });
    const old = await w.letter("olden@x.test", { setBy: "external", decidedAt: null }, new Date(NOW.getTime() - 800 * DAY));
    const mixed = await w.letter("fresh@x.test", { setBy: "external", decidedAt: null }, new Date(NOW.getTime() - 800 * DAY));
    const undated = await w.letter("undated@x.test", { setBy: "external", decidedAt: null }, null);
    const summary = await unscreenedSummary(w.db as never, w.accountId, NOW);
    expect(summary).toMatchObject({ groups: [{ address: "fresh@x.test", count: 1 }], total: 1 });
    expect(await screenUnscreened(w.ctx)).toMatchObject({ total: 1 });
    expect(await w.desired(fresh)).toBe(GATE);
    for (const id of [old, mixed, undated]) expect(await w.untouched(id)).toEqual(stay);
  });

  it("migrated mail, an old Date header over a recent arrival, is neither counted nor moved", async () => {
    const w = await world();
    const fresh = await w.letter("fresh@x.test", { setBy: "external", decidedAt: null });
    const migrated = await w.letter("mig@x.test", { setBy: "external", decidedAt: null }, ARRIVED, new Date(NOW.getTime() - 800 * DAY));
    expect(await unscreenedSummary(w.db as never, w.accountId, NOW)).toMatchObject({ groups: [{ address: "fresh@x.test" }], total: 1 });
    expect(await screenUnscreened(w.ctx)).toMatchObject({ total: 1 });
    expect(await w.desired(fresh)).toBe(GATE);
    expect(await w.untouched(migrated)).toEqual(stay);
  });

  it("CONTROL — under All time the old letter is offered and moved; the undated one still stays", async () => {
    const w = await world();
    await w.db.update(accountSettings).set({ screeningScope: "all_time" }).where(eq(accountSettings.accountId, w.accountId));
    const old = await w.letter("olden@x.test", { setBy: "external", decidedAt: null }, new Date(NOW.getTime() - 800 * DAY));
    const undated = await w.letter("undated@x.test", { setBy: "external", decidedAt: null }, null);
    expect((await unscreenedSummary(w.db as never, w.accountId, NOW)).groups.map((g) => g.address)).toEqual(["olden@x.test"]);
    expect(await screenUnscreened(w.ctx)).toMatchObject({ total: 1 });
    expect(await w.desired(old)).toBe(GATE);
    expect(await w.untouched(undated)).toEqual(stay);
  });
});
