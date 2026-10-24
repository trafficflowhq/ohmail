/**
 * THE REPORTED CASE ON THE PHONE (OHBOX-THREAD-OPEN-LEAVES-ITS-NEW-MESSAGES-UNREAD): a conversation
 * of several unread replies opened from the Ohbox left them unread and showed no state. Now the
 * open holds the row and reads nothing by itself; the reader's thread-read rule reads each message
 * once its top — its sender line and first lines — has been on screen for the 0.7 s dwell (owner
 * ruling 2026-10-23), one glance per look; the reader and its rail run in time order, oldest
 * first, as the row's squares; a member's ⋯ offers Mark unread on a read message that is not the
 * account's own and keeps it unread for the visit; a reply that syncs into the open reader is asked
 * its text and read like any message. Outside the Ohbox (Reads) the open still reads. Through the
 * real engine over a loopback mail server; the reader's layout reports and its clock are driven by
 * hand, as `MessageReader` makes them.
 */
import { describe, expect, it } from "vitest";
import { THREAD_READ_HOLD_MS, createThreadRead } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage, liveOhbox, presentedOf, standsInOhbox, type WorldView } from "../src/state/live";
import { createPhoneThreadRead } from "../src/ui/reader-seen";
import { arrivalsToAsk, markLine, markUnreadOffered, markWhen, marksShown, railItemsMemo, railItemsOf, readerGroups } from "../src/ui/reader-marks";
import { Copy } from "../src/copy";
import { standsInOhboxMail } from "../src/ui/pane-routes";
import { threadBadgeOf } from "../src/ui/row-spoken";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

/** p1..p4 in thread T, all unread; o1 the account's own reply, read; a Reads issue r1. */
async function session() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addRule(ruleDto("r-news", "sender", "news@fake.test", "ohmail/News"));
  const at = (n: number) => `2026-08-19T0${n}:00:00Z`;
  for (const [id, n] of [["p1", 1], ["p2", 2], ["p3", 3], ["p4", 5]] as const) {
    fake.addMessage({ ...dto(id, { subject: "Q3 plan", date: at(n) }), threadId: "T" });
    fake.setBody(id, `the words of ${id}`);
  }
  fake.addMessage({
    ...dto("o1", { subject: "Re: Q3 plan", date: at(4), unread: false, folder: "Sent", from: { name: "Me", address: "me@fake.test" } }),
    threadId: "T",
  });
  fake.setBody("o1", "my words");
  fake.addMessage(dto("r1", { subject: "Issue 42", from: { name: "News", address: "news@fake.test" }, folder: "ohmail/News" }));
  fake.setBody("r1", "the issue");
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m) });
  const box = () => liveOhbox(presentedOf(boot.engine.read(), view.now), view, boot.engine.openRowHeld());
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, boot, actions, box, close };
}

const settleWire = async (engine: { syncOnce(): Promise<unknown> }): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
  await engine.syncOnce();
};

/** A reader over the adapter with its frames and its clock run by hand. */
function readerOf(opts: { opened: string | null; unread: Set<string>; onRead: (ids: string[]) => void; record?: ReturnType<typeof createThreadRead> }) {
  const record = opts.record ?? createThreadRead();
  let clock = 1000;
  record.enter(clock);
  let frames: (() => void)[] = [];
  let timers: { at: number; run: () => void }[] = [];
  const core = createPhoneThreadRead({
    record, openedId: () => opts.opened, unread: (id) => opts.unread.has(id), ready: () => true,
    onRead: (ids) => { for (const id of ids) opts.unread.delete(id); opts.onRead(ids); },
    now: () => clock,
    frame: (run) => { frames.push(run); return () => undefined; },
    after: (ms, run) => { const t = { at: clock + ms, run }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
  });
  const flush = (): void => { for (let i = 0; i < 10 && frames.length > 0; i++) { const run = frames; frames = []; for (const f of run) f(); } };
  const pass = (ms: number): void => {
    flush();
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock);
      if (due.length === 0) break;
      timers = timers.filter((t) => t.at > clock);
      for (const t of due) t.run();
      flush();
    }
  };
  return { core, flush, pass, record };
}
const dwell = THREAD_READ_HOLD_MS + 1;

describe("the reported case: an unread conversation opened from the Ohbox", () => {
  it("the open holds the row and reads nothing; the rule reads the opened message once its top was on screen, then each member brought in", async () => {
    const s = await session();
    try {
      const unreadBefore = s.box().unreadIds.length;
      expect(standsInOhbox(s.boot.engine.read(), "p4"), "the premise: p4 stands in the Ohbox").toBe(true);
      expect(await s.actions.openMessage("p4")).toBe(true);
      expect(s.boot.engine.openRowHeld(), "the row is held while it is read").toBe("p4");
      await settleWire(s.boot.engine);
      expect(s.box().unreadIds.length, "base: the open read p4 by itself").toBe(unreadBefore);
      expect(s.fake.message("p4")?.unread).toBe(true);

      await s.actions.hydrateMessage("p4");
      for (const id of ["p1", "p2", "p3", "o1"]) await s.actions.hydrateMessage(id);
      await settleWire(s.boot.engine);
      const m = liveMessage(s.boot.engine, "p4", view)!;
      expect(standsInOhboxMail(m)).toBe(true);
      expect(m.earlier.map((h) => [h.id, h.seen, h.mine === true]), "members in time order, ready").toEqual([
        ["p1", false, false], ["p2", false, false], ["p3", false, false], ["o1", true, true],
      ]);
      expect(m.earlier.every((h) => h.ready === true), "every member's body is final").toBe(true);

      // The reader in time order: the older members above the opened message, which the open anchors at the top.
      const { above, below } = readerGroups(m, true);
      expect([above.map((h) => h.id), below.map((h) => h.id)]).toEqual([["p1", "p2", "p3", "o1"], []]);
      const reads: string[][] = [];
      const r = readerOf({ opened: "p4", unread: new Set(["p4", "p1", "p2", "p3"]), onRead: (ids) => { reads.push(ids); s.actions.markGlanced(ids); } });
      const { core } = r;
      core.viewport(800); core.chrome(0); core.offset("padded", 0); core.offset("above", 0);
      above.forEach((h, i) => {
        core.panel(h.id, "above", i * 412, 400); core.panelHeader(h.id, 18, 30); core.panelBody(h.id, 60); core.panelEnd(h.id, 360);
      });
      core.offset("opened", 4 * 412 + 34);
      core.openedFrom(0, 40); core.openedBody(100); core.openedEnd(300);
      core.onScroll(core.topOf("p4")! - 8);
      r.flush();
      expect(reads, "the write waits for the dwell").toEqual([]);
      r.pass(dwell);
      expect(reads, "the opened message, its top on screen").toEqual([["p4"]]);
      // p3's top brought in and held: read, its end not needed. p2's sender line cut at the top: not.
      core.onScroll(800);
      r.pass(dwell);
      expect(reads).toEqual([["p4"], ["p3"]]);
      core.onScroll(440);
      r.pass(5 * dwell);
      expect(reads, "p2's top was never wholly on screen").toEqual([["p4"], ["p3"]]);
      await settleWire(s.boot.engine);
      expect(s.fake.message("p4")?.unread).toBe(false);
      expect(s.fake.message("p3")?.unread).toBe(false);
      expect(s.fake.message("p2")?.unread, "p2's top was never read").toBe(true);

      // Leaving files the conversation at the top of Earlier only once nothing is unread; p1, p2 keep it in New.
      s.actions.leaveMessage("p4");
      expect(s.box().fresh.map((r) => r.rowKey)).toContain("T");
    } finally {
      s.close();
    }
  }, 30_000);

  it("the reader, its rail and the row's squares share one time order, and the spoken places name the right message", async () => {
    const s = await session();
    try {
      await s.actions.openMessage("p2"); // opened in the middle: older above it, newer below
      const m = liveMessage(s.boot.engine, "p2", view)!;
      const items = railItemsOf(m);
      expect(items.map((it) => [it.id, it.kind]), "oldest first, the opened one in its place").toEqual([
        ["p1", "unread"], ["p2", "unread"], ["p3", "unread"], ["o1", "mine"], ["p4", "unread"],
      ]);
      const { above, below } = readerGroups(m, true);
      expect([...above.map((h) => h.id), m.id, ...below.map((h) => h.id)], "the reader draws the same order").toEqual(items.map((it) => it.id));
      const row = s.box().fresh.find((r) => r.rowKey === "T")!;
      expect(items.map((it) => it.kind), "the rail's squares are the row's").toEqual(row.marks);
      const at = items.findIndex((it) => it.id === "p4");
      expect(Copy.readerMarkFrom(at + 1, items.length, items[at]!.sender, true), "the newest is spoken last").toContain("5");
      expect(readerGroups(m, false), "outside the Ohbox the opened message still leads").toEqual({ above: [], below: m.earlier });
      // What a held square's sheet says: the date, the first line, no clip without a file.
      expect(items.map((it) => [it.id, it.at && new Date(it.at).toISOString()]), "each square's date").toEqual([
        ["p1", "2026-08-19T01:00:00.000Z"], ["p2", "2026-08-19T02:00:00.000Z"], ["p3", "2026-08-19T03:00:00.000Z"],
        ["o1", "2026-08-19T04:00:00.000Z"], ["p4", "2026-08-19T05:00:00.000Z"],
      ]);
      expect(items.map((it) => it.line), "each first line: before the bodies land, the server's preview").toEqual(["Q3 plan", "Q3 plan", "Q3 plan", "Re: Q3 plan", "Q3 plan"]);
      expect(items.every((it) => it.file !== true), "no file, no clip").toBe(true);
      const single = liveMessage(s.boot.engine, "r1", view)!;
      expect(railItemsOf(single), "no rail for a single message").toEqual([]);
    } finally {
      s.close();
    }
  }, 30_000);

  it("a reply that syncs into the open reader is asked its text, and reads once its top was on screen", async () => {
    const s = await session();
    try {
      await s.actions.openMessage("p4");
      await settleWire(s.boot.engine);
      const asked = new Set(liveMessage(s.boot.engine, "p4", view)!.earlier.map((h) => h.id)); // the open asked these
      s.fake.addMessage({ ...dto("p5", { subject: "Re: Q3 plan", date: "2026-08-19T06:00:00Z" }), threadId: "T" });
      s.fake.setBody("p5", "the words of p5");
      await settleWire(s.boot.engine);
      const arrived = liveMessage(s.boot.engine, "p4", view)!.earlier.find((h) => h.id === "p5");
      expect(arrived, "the reply synced into the conversation").toBeDefined();
      expect(arrived!.ready, "a snippet until it is asked: the rule could never read it").not.toBe(true);
      const ask = arrivalsToAsk(liveMessage(s.boot.engine, "p4", view)!.earlier, asked);
      expect(ask, "the reader asks the arrival, once").toEqual(["p5"]);
      expect(arrivalsToAsk(liveMessage(s.boot.engine, "p4", view)!.earlier, asked)).toEqual([]);
      s.actions.hydrateHeld(ask);
      await settleWire(s.boot.engine);
      expect(liveMessage(s.boot.engine, "p4", view)!.earlier.find((h) => h.id === "p5")!.ready).toBe(true);
    } finally {
      s.close();
    }
  }, 30_000);

  it("a member's ⋯ Mark unread: offered on a read message not your own; it writes unread and the rule leaves it unread", async () => {
    const s = await session();
    try {
      await s.actions.openMessage("p4");
      await s.actions.markSeen("p1", false);
      await settleWire(s.boot.engine);
      const m = liveMessage(s.boot.engine, "p4", view)!;
      const p1 = m.earlier.find((h) => h.id === "p1")!;
      const o1 = m.earlier.find((h) => h.id === "o1")!;
      const p2 = m.earlier.find((h) => h.id === "p2")!;
      expect(markUnreadOffered({ read: p1.seen, own: p1.mine === true }), "read, from someone else").toBe(true);
      expect(markUnreadOffered({ read: o1.seen, own: o1.mine === true }), "your own").toBe(false);
      expect(markUnreadOffered({ read: p2.seen, own: p2.mine === true }), "unread already").toBe(false);

      // The sheet's press, as the reader makes it: keep it for the visit, then the unread write.
      const record = createThreadRead();
      record.keepUnread("p1");
      await s.actions.markSeen("p1", true);
      await settleWire(s.boot.engine);
      expect(s.fake.message("p1")?.unread).toBe(true);
      const reads: string[][] = [];
      const r = readerOf({ opened: null, unread: new Set(["p1"]), onRead: (ids) => reads.push(ids), record });
      r.core.viewport(800); r.core.offset("below", 0);
      r.core.panel("p1", "below", 0, 300); r.core.panelHeader("p1", 18, 30); r.core.panelBody("p1", 60); r.core.panelEnd("p1", 260);
      r.pass(5 * dwell);
      expect(reads, "kept unread for the visit").toEqual([]);
    } finally {
      s.close();
    }
  }, 30_000);
});

describe("CONTROL: outside the Ohbox the open is still the read", () => {
  it("a Reads issue opened is read by the open itself", async () => {
    const s = await session();
    try {
      expect(standsInOhbox(s.boot.engine.read(), "r1")).toBe(false);
      await s.actions.openMessage("r1");
      await settleWire(s.boot.engine);
      expect(s.fake.message("r1")?.unread).toBe(false);
    } finally {
      s.close();
    }
  }, 30_000);
});

describe("the list's squares", () => {
  it("the conversation's row carries one square per message, oldest first; the count steps back; a narrow row keeps the newest", async () => {
    const s = await session();
    try {
      const row = s.box().fresh.find((r) => r.rowKey === "T")!;
      expect(row.marks).toEqual(["unread", "unread", "unread", "mine", "unread"]);
      expect(threadBadgeOf(row), "the squares say the length").toBe(0);
      expect(marksShown(row.marks!, 30), "a 30dp line: the three newest").toEqual(["unread", "mine", "unread"]);
      expect(marksShown(row.marks!, null)).toHaveLength(5);
    } finally {
      s.close();
    }
  }, 30_000);
});

describe("a held square's sheet: its words", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const words = { today: "today", yesterday: "yesterday" };
  it("today and yesterday by name with the clock, a date past that, the year outside this one", () => {
    expect(markWhen("2026-10-24T09:12:00Z", now, "UTC", "en", words)).toBe("today 09:12");
    expect(markWhen("2026-10-23T23:40:00Z", now, "UTC", "en", words)).toBe("yesterday 23:40");
    expect(markWhen("2026-10-23T23:40:00Z", now, "Europe/Zurich", "en", words), "the reader's midnight").toBe("today 01:40");
    expect(markWhen("2026-10-21T14:05:00Z", now, "UTC", "en", words)).toBe("Wed 21 Oct, 14:05");
    expect(markWhen("2025-12-30T08:00:00Z", now, "UTC", "en", words)).toMatch(/^Tue 30 Dec 2025, 08:00$/);
    expect(markWhen(null, now, "UTC", "en", words), "no date, no words").toBe("");
  });
  it("the first line: its first words, cut at a word near 64 characters", () => {
    expect(markLine("\n\n  Hi Ben,\nthe plan is in")).toBe("Hi Ben,");
    const long = "Thanks for the draft, I went through all of it on the train and have three small notes";
    expect(markLine(long)).toBe("Thanks for the draft, I went through all of it on the train and\u2026");
    expect(markLine("")).toBe("");
    expect(markLine(" \n\t\n")).toBe("");
  });
  it("one reader's squares are asked again only when a fact they show moved", () => {
    const railOf = railItemsMemo();
    const m = { id: "b", unread: false, from: { name: "Ben", address: "ben@example.com" }, body: "hi", earlier: [{ id: "a", subject: "", time: "", body: "", seen: true, sender: "Ada" }] };
    const first = railOf(m);
    expect(railOf({ ...m, earlier: [...m.earlier] }), "a new object, the same facts").toBe(first);
    expect(railOf({ ...m, earlier: [{ ...m.earlier[0]!, body: "the plan" }] })[0]!.line, "a body that arrived").toBe("the plan");
  });
});
