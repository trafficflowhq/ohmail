import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts, folderState, mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { unscreenedWalk, type UnscreenedCursor, type UnscreenedKnowledge } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * A walk through mail whose senders are all decided still pays for each page of senders it
 * reads. Three pages of decided senders come before one stranger. With room for one sender page
 * per call, each call reads one page and hands the next call the place to go on from, and the
 * stranger's letter is found exactly once.
 */

const NOW = new Date("2026-10-10T09:00:00.000Z");
const ARRIVED = new Date("2026-10-09T08:00:00.000Z");
const DECIDED = 2_500;

describe("the unscreened walk bounds the sender pages it reads", () => {
  it("reads one sender page per call and finds the stranger behind three pages of decided senders", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "sender pages" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `own-${accountId.slice(0, 8)}@example.test`, organizerRole: "organizer",
    }).returning();
    const decided = Array.from({ length: DECIDED }, (_, i) => `a${String(i).padStart(5, "0")}@decided.test`);
    const rows = [...decided, "zz-stranger@unknown.test"].map((from, i) => ({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `sp:${randomUUID()}`, subject: `Note ${i}`,
      fromAddress: from, date: ARRIVED, createdAt: ARRIVED, arrivedAt: ARRIVED, unread: true,
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(messages).values(rows.slice(i, i + 500));
    const all = await db.select({ id: messages.id, from: messages.fromAddress }).from(messages);
    const tail = all.find((m) => m.from === "zz-stranger@unknown.test")!;
    await db.insert(messageBodies).values({ messageId: tail.id, accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: tail.id, accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
      reconcileStatus: "reconciled", conflict: false, decidedAt: null,
    });

    const knowledge: UnscreenedKnowledge = {
      listRules: async () => [],
      knownSenders: async () => ({ addresses: new Set(decided), inferred: new Set(), lists: new Map() }),
      isCorrespondent: async () => false,
    };
    const found: string[] = [];
    let from: UnscreenedCursor | null = null;
    let calls = 0;
    for (;;) {
      calls++;
      const walk = await unscreenedWalk(db as unknown as Tx, knowledge, accountId, {
        lock: false, maxSenderPages: 1, scope: { kind: "offer", cutoff: undefined, from },
      });
      found.push(...walk.rows.map((r) => r.messageId));
      if (walk.complete || calls > 10) break;
      expect(walk.next).not.toBeNull();
      from = walk.next;
    }
    expect({ calls, found }).toEqual({ calls: 3, found: [tail.id] });
  }, 60_000);
});
