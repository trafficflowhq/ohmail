import { describe, expect, it } from "vitest";
import { type EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveReads, liveReceipts, presentedOf, type WorldView } from "../src/state/live";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * A READ LETTER MOVED INTO NEWS OR RECEIPTS, ON THE PHONE. A device with no line
 * yet drew "Seen up to here" above the moved letter and the tab said "0 new" over unread letters
 * the server still held unseen. The move here is the phone's own: `move` through the engine, the
 * mail server answering it, the mirror reading the pile back.
 */

const view: WorldView = { now: new Date("2026-10-09T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

async function liveOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind}`);
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m) });
  return { ...boot, actions };
}

const unreadIn = (live: { engine: { read(): { list<T>(t: string): T[] } } }, folder: string) =>
  live.engine.read().list<EngineMessage>("message").filter((m) => m.folder === folder && m.unread).length;

/** An instant `min` minutes after now — mail that reaches the mailbox after this device's first sync. */
const later = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();

describe("the phone: a read letter moved in on top of a pile it never visited", () => {
  it("Receipts keeps its 5 new and draws no line above the moved letter", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("w07", { folder: "Sent", unread: false, date: later(30) }));
      const live = await liveOn(fake, origin);
      for (let i = 1; i <= 5; i++) fake.addMessage(dto(`rc${i}`, { folder: "ohmail/Receipts", date: later(i) }));
      await live.engine.syncOnce();
      expect(liveReceipts(presentedOf(live.engine.read(), view.now), view).newCount).toBe(5);

      await live.engine.mutate({ kind: "move", messageId: "w07", folder: "ohmail/Receipts" });
      const r = liveReceipts(presentedOf(live.engine.read(), view.now), view);
      expect(live.engine.read().get<EngineMessage>("message", "w07")?.folder).toBe("ohmail/Receipts");
      expect(r.newCount).toBe(5);
      expect(r.newCount).toBe(unreadIn(live, "ohmail/Receipts"));
      expect(r.waterlineAboveId).toBeNull();
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("News keeps its 2 new; a real visit then moves the line and nothing is new", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("w14", { folder: "INBOX", unread: false, date: later(30) }));
      const live = await liveOn(fake, origin);
      fake.addMessage(dto("n1", { folder: "ohmail/News", date: later(1) }));
      fake.addMessage(dto("n2", { folder: "ohmail/News", date: later(2) }));
      await live.engine.syncOnce();

      await live.engine.mutate({ kind: "move", messageId: "w14", folder: "ohmail/News" });
      const before = liveReads(presentedOf(live.engine.read(), view.now), view);
      expect(before.items[0]?.id).toBe("w14");
      expect(before.newCount).toBe(2);
      expect(before.waterlineAboveId).toBeNull();

      // Control: the person visits News, reads both and leaves.
      expect(await live.actions.sweepFeed("reads", ["n1", "n2"])).toBe(true);
      expect(await live.actions.leaveFeed("reads")).toBe(true);
      const after = liveReads(presentedOf(live.engine.read(), view.now), view);
      expect(after.newCount).toBe(0);
      // The line sits above the newest letter the visit swept; the moved letter stays above it, uncounted.
      expect(after.waterlineAboveId).toBe("n2");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the phone: an imported pile before any visit", () => {
  it("old unread mail is named on the first visit in News and Receipts, and no line is drawn", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      for (let i = 0; i < 20; i++) {
        fake.addMessage(dto(`old${i}`, { folder: "ohmail/News", date: `2026-09-${String(1 + i).padStart(2, "0")}${"T"}08:00:00Z` }));
        fake.addMessage(dto(`rcpt${i}`, { folder: "ohmail/Receipts", date: `2026-09-${String(1 + i).padStart(2, "0")}${"T"}09:00:00Z` }));
      }
      const live = await liveOn(fake, origin);
      const reads = liveReads(presentedOf(live.engine.read(), view.now), view);
      expect(reads.items).toHaveLength(20);
      expect(reads.unreadIds).toHaveLength(20);
      // Unread is new until read: the tab and the header said "0 new" over these.
      expect(reads.newCount).toBe(20);
      expect(reads.waterlineAboveId).toBeNull();
      const receipts = liveReceipts(presentedOf(live.engine.read(), view.now), view);
      expect(receipts.total).toBe(20);
      expect(receipts.newCount).toBe(20);
      expect(receipts.waterlineAboveId).toBeNull();
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});
