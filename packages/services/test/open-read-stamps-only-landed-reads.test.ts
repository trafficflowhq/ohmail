import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { flagState, messages, threads } from "@trafficflow/db";
import { MessageService, TriageService, type ServiceContext } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

// The open read stamps `open_read_at` only on a member whose read LANDED in this batch and that
// is neither parked nor pinned: an id a newer read decision kept stays unread and unstamped (the
// per-id floor), and a parked or pinned member is read but never stamped (it is not in Earlier).

type Row = typeof messages.$inferSelect & { openReadAt?: Date | null };
type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function oneConversation(db: Db, accountId: string, mailboxId: string, n: number): Promise<string[]> {
  const [t] = await db.insert(threads).values({ accountId, subject: "open read" }).returning();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await seedMessage(db, accountId, mailboxId, { folder: "INBOX", unread: true, date: new Date(Date.UTC(2026, 6, 20 + i)) }));
  }
  await db.update(messages).set({ threadId: t!.id }).where(inArray(messages.id, ids));
  return ids;
}

async function rowsOf(db: Db, ids: string[]): Promise<Map<string, Row>> {
  const rows = (await db.select().from(messages).where(inArray(messages.id, ids))) as Row[];
  return new Map(rows.map((r) => [r.id, r]));
}

describe("the open read stamps only the members whose read landed", () => {
  it("an aged press: the id a newer decision kept stays unread and unstamped; the live id is read and stamped", async () => {
    const now = new Date("2026-07-28T12:00:00Z");
    const { db, accountId, mailboxId, ctx } = await makeCtx(now);
    const [a1, a2] = await oneConversation(db, accountId, mailboxId, 2);
    await db.insert(flagState).values({
      messageId: a2!, accountId, desiredSeen: false, observedSeen: false, lastSetBy: "us", reconcileStatus: "reconciled",
      decidedAt: new Date(now.getTime() - 3_600_000),
    } as typeof flagState.$inferInsert);
    const aged = { ...ctx, pressFloor: new Date(now.getTime() - 2 * 86_400_000), pressAged: true } as ServiceContext;
    await new MessageService().markSeen(aged, { ids: [a1!, a2!], unread: false, openRead: true });
    const rows = await rowsOf(db, [a1!, a2!]);
    expect(rows.get(a1!)!.unread, "the live id's read landed").toBe(false);
    expect(rows.get(a1!)!.openReadAt, "the live id is stamped").toBeInstanceOf(Date);
    expect(rows.get(a2!)!.unread, "the newer decision stands").toBe(true);
    expect(rows.get(a2!)!.openReadAt ?? null, "a kept id was stamped").toBeNull();
  });

  it("a parked and a pinned unread member in the same batch read are read and not stamped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const [parked, pinned, plain] = await oneConversation(db, accountId, mailboxId, 3);
    const triage = new TriageService();
    await triage.setState(ctx, parked!, { state: "reply_later" });
    await triage.setState(ctx, pinned!, { state: "resurfaced" });
    await new MessageService().markSeen(ctx, { ids: [parked!, pinned!, plain!], unread: false, openRead: true });
    const rows = await rowsOf(db, [parked!, pinned!, plain!]);
    for (const id of [parked!, pinned!, plain!]) expect(rows.get(id)!.unread, "every read lands").toBe(false);
    expect(rows.get(parked!)!.openReadAt ?? null, "a parked member was stamped").toBeNull();
    expect(rows.get(pinned!)!.openReadAt ?? null, "a pinned member was stamped").toBeNull();
    expect(rows.get(plain!)!.openReadAt, "the plain unread member is stamped").toBeInstanceOf(Date);
  });
});
