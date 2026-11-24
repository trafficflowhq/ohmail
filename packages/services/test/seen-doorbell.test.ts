import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@trafficflow/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/db")>();
  return { ...real, ringFilingDoorbell: vi.fn(real.ringFilingDoorbell) };
});

import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, ringFilingDoorbell } from "@trafficflow/db";
import { MessageService, dbFor, type ServiceContext } from "../src/index.js";

/**
 * A READ RINGS THE WORKER'S DOORBELL, ONCE PER MAILBOX.
 *
 * A read writes a `\Seen` intent and the worker pushes it on the mailbox's next turn. Without a
 * ring that turn was the rotation's: a web read reached the server three minutes later in
 * production (2026-10-09). `markSeen` and `patch`'s unread half now ring the filing doorbell after
 * the commit — once per MAILBOX a request touched, so Mark-all-read over a mailbox is one ring
 * and never one per message. The doorbell's own 5 s floor is `filing-doorbell.test.ts`'s.
 */

const svc = new MessageService();
const ring = vi.mocked(ringFilingDoorbell);
afterEach(() => { ring.mockClear(); });

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const t0 = new Date("2026-10-09T13:00:00.000Z");
const ctxAt = (db: Db, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => t0, requestId: "r" });

async function world(perMailbox: number[]): Promise<{ db: Db; accountId: string; boxes: Array<{ id: string; msgs: string[] }> }> {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "seen-doorbell" }).returning();
  const boxes: Array<{ id: string; msgs: string[] }> = [];
  let n = 0;
  for (const count of perMailbox) {
    const [mb] = await db.insert(mailboxes).values({
      accountId: a!.id, provider: "imap", address: `person${boxes.length}@example.test`, organizeConsentedAt: t0,
    }).returning();
    const msgs: string[] = [];
    for (let i = 0; i < count; i++, n++) {
      const [m] = await db.insert(messages).values({
        accountId: a!.id, mailboxId: mb!.id, dedupKey: `mid:<seen-${n}@example.test>`,
        messageIdHeader: `<seen-${n}@example.test>`, fromAddress: "x@example.test", subject: "s", date: t0,
        bodyHash: `seen-${n}`, unread: true, nativeLocator: { folder: "INBOX", ref: `1:${n + 1}` },
      }).returning();
      msgs.push(m!.id);
    }
    boxes.push({ id: mb!.id, msgs });
  }
  return { db, accountId: a!.id, boxes };
}

const stampOf = async (db: Db, mailboxId: string): Promise<Date | null> => {
  const [row] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row?.at ?? null;
};
const rungIds = (): string[] => ring.mock.calls.map((c) => c[1] as string);

describe("a read rings the worker's doorbell", () => {
  it("Mark read over three messages of one mailbox is ONE ring, and the stamp lands", async () => {
    const w = await world([3]);
    await svc.markSeen(ctxAt(w.db, w.accountId), { ids: w.boxes[0]!.msgs, unread: false });
    expect(rungIds(), "one ring per mailbox, never one per message").toEqual([w.boxes[0]!.id]);
    expect(await stampOf(w.db, w.boxes[0]!.id), "the read waited for the worker's rotation").toEqual(t0);
  });

  it("a selection across two mailboxes rings each of them once", async () => {
    const w = await world([2, 2]);
    const ids = [...w.boxes[0]!.msgs, ...w.boxes[1]!.msgs];
    await svc.markSeen(ctxAt(w.db, w.accountId), { ids, unread: true });
    expect(rungIds().sort()).toEqual([w.boxes[0]!.id, w.boxes[1]!.id].sort());
  });

  it("a single message's unread PATCH rings its mailbox", async () => {
    const w = await world([1]);
    await svc.patch(ctxAt(w.db, w.accountId), w.boxes[0]!.msgs[0]!, { unread: false });
    expect(rungIds()).toEqual([w.boxes[0]!.id]);
    expect(await stampOf(w.db, w.boxes[0]!.id)).toEqual(t0);
  });

  it("a PATCH that files AND reads rings once, not twice", async () => {
    const w = await world([1]);
    await svc.patch(ctxAt(w.db, w.accountId), w.boxes[0]!.msgs[0]!, { unread: false, folder: "ohmail/News" });
    expect(rungIds()).toEqual([w.boxes[0]!.id]);
  });
});
