/**
 * THE REPORTED CASE ON THE PHONE (OHBOX-THREAD-OPEN-LEAVES-ITS-NEW-MESSAGES-UNREAD): a conversation
 * of several unread replies opened from the Ohbox left them unread and showed no state. Now the
 * open holds the row and reads nothing by itself; the reader's thread-read rule reads each message
 * once its first lines have been on screen for the 0.7 s dwell and its sender line, or the end of its
 * text, has been on screen (owner ruling 2026-10-23), one glance per look; the reader and its rail
 * run in time order, oldest first, as the row's squares; a member's ⋯ offers Mark unread on a read
 * message that is not the account's own and keeps it unread for the visit; a reply that syncs into
 * the open reader is asked its text and read like any message. Outside the Ohbox (Reads) the open
 * still reads. Through the real engine over a loopback mail server; the reader's layout reports and
 * its clock are driven by hand, as `MessageReader` makes them.
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
import { normalizeMime } from "../../../packages/core/src/mime.js";
import { htmlWords } from "../src/mail/html-words";

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
function readerOf(opts: { opened: string | null; unread: Set<string>; onRead: (ids: string[]) => void; record?: ReturnType<typeof createThreadRead>; ready?: (id: string) => boolean }) {
  const record = opts.record ?? createThreadRead();
  let clock = 1000;
  record.enter(clock);
  let frames: (() => void)[] = [];
  let timers: { at: number; run: () => void }[] = [];
  const core = createPhoneThreadRead({
    record, openedId: () => opts.opened, unread: (id) => opts.unread.has(id), ready: opts.ready ?? (() => true),
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
      // p3's top brought in and held: read, its end not needed. p2's header cut at the top, its first lines and end in view: read.
      core.onScroll(800);
      r.pass(dwell);
      expect(reads).toEqual([["p4"], ["p3"]]);
      core.onScroll(440);
      r.pass(5 * dwell);
      expect(reads, "p2's whole text was on screen").toEqual([["p4"], ["p3"], ["p2"]]);
      await settleWire(s.boot.engine);
      expect(s.fake.message("p4")?.unread).toBe(false);
      expect(s.fake.message("p3")?.unread).toBe(false);
      expect(s.fake.message("p2")?.unread).toBe(false);
      expect(s.fake.message("p1")?.unread, "p1 was never on screen").toBe(true);

      // Leaving files the conversation at the top of Earlier only once nothing is unread; p1 keeps it in New.
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

/** An html-only letter with embedded pictures: multipart/related, its html the root, no text part. */
const relatedLetter = (n: number, html: string): Buffer => Buffer.from([
  `Message-ID: <rel-${n}@fake.test>`, "From: Sender <sender@fake.test>", "To: Me <me@fake.test>", "Subject: picture rota",
  "Date: Wed, 19 Aug 2026 08:00:00 +0000", "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="REL"', "",
  "--REL", 'Content-Type: text/html; charset="us-ascii"', "", html, "",
  "--REL", "Content-Type: image/png", `Content-ID: <p${n}@fake.test>`, 'Content-Disposition: inline; filename="p.png"',
  "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--REL--", "",
].join("\r\n"));

describe("an older member whose body is html inside multipart/related, with no text part", () => {
  it("draws the html's words and reads it on the rest; one whose html holds no words draws its files and a line, and is read only by its own open", async () => {
    const worded = await normalizeMime(relatedLetter(1,
      `<html><head><style>p{color:red}</style></head><body><p>Top of member 1.</p><img src="cid:p1@fake.test" alt="picture 1"><p>End of member 1.</p></body></html>`));
    const bare = await normalizeMime(relatedLetter(2, `<html><body><img src="cid:p2@fake.test"></body></html>`));
    // A single-part html letter of pictures alone: the parse stores a placeholder as its text.
    const single = await normalizeMime(Buffer.from(["Message-ID: <s6@fake.test>", "From: sender@fake.test", "To: me@fake.test", "Subject: s",
      "MIME-Version: 1.0", 'Content-Type: text/html; charset="us-ascii"', "", `<html><body><img src="https://pictures.fake.test/b.png"></body></html>`, ""].join("\r\n")));
    expect(single.textBody.trim(), "the premise: a text that is no words of its own").not.toBe("");
    expect([worded.textBody, bare.textBody], "the premise: the parse stores the html's words, and none for an html without")
      .toEqual(["Top of member 1.\n\nEnd of member 1.", ""]);
    const s = await session();
    try {
      // p1 as stored before the parse kept an html-only letter's words (no backfill): drawn from its html.
      s.fake.setBody("p1", ""); s.fake.setHtml("p1", worded.htmlBody!);
      s.fake.setBody("p2", bare.textBody); s.fake.setHtml("p2", bare.htmlBody!);
      s.fake.setFiles("p2", [{ id: "a-p2", filename: "p.png", contentType: "image/png", sizeBytes: 8, inline: true }]);
      s.fake.setBody("p3", ""); s.fake.setHtml("p3", `<html><body><img src="https://pictures.fake.test/a.png"></body></html>`);
      // Words past the html bound the phone does not read, and an embedded picture.
      s.fake.addMessage({ ...dto("p5", { subject: "Q3 plan", date: "2026-08-19T00:30:00Z" }), threadId: "T" });
      s.fake.setBody("p5", ""); s.fake.setHtml("p5", `<html><body><img src="cid:p5@fake.test"><p>${"many words ".repeat(60_000)}</p></body></html>`);
      s.fake.setFiles("p5", [{ id: "a-p5", filename: "q.png", contentType: "image/png", sizeBytes: 8, inline: true }]);
      s.fake.addMessage({ ...dto("p6", { subject: "Q3 plan", date: "2026-08-19T00:20:00Z" }), threadId: "T" });
      s.fake.setBody("p6", single.textBody); s.fake.setHtml("p6", single.htmlBody!);
      // Pictures from the web and a file: its file pill is not its body.
      s.fake.addMessage({ ...dto("p7", { subject: "Q3 plan", date: "2026-08-19T00:10:00Z" }), threadId: "T" });
      s.fake.setBody("p7", ""); s.fake.setHtml("p7", `<html><body><img src="https://pictures.fake.test/c.png"></body></html>`);
      s.fake.setFiles("p7", [{ id: "a-p7", filename: "flyer.pdf", contentType: "application/pdf", sizeBytes: 800, inline: false }]);
      await settleWire(s.boot.engine);
      await s.actions.openMessage("p4");
      await settleWire(s.boot.engine);
      let m = liveMessage(s.boot.engine, "p4", view)!;
      const at = (id: string) => m.earlier.find((h) => h.id === id)!;
      expect(at("p1").body, "the member draws its words").toBe("Top of member 1.\n\nEnd of member 1.");
      expect([at("p1").ready, at("p1").wordless], "drawn: the rule may read it").toEqual([true, undefined]);
      expect([at("p2").body, at("p2").wordless, at("p2").attachments], "no words, and its flag asked no list").toEqual(["", true, undefined]);
      expect(at("p2").ready, "nothing drawn yet").not.toBe(true);
      expect(liveMessage(s.boot.engine, "p1", view)!.body, "opened, its text says the same").toBe(at("p1").body);

      // The reader asks a word-less member's list, as it asks the opened message's.
      for (const id of ["p2", "p3", "p5", "p6", "p7"]) s.actions.holdFiles([id]);
      await settleWire(s.boot.engine);
      m = liveMessage(s.boot.engine, "p4", view)!;
      expect(at("p2").attachments?.map((a) => [a.filename, a.inline]), "its pictures, as files").toEqual([["p.png", true]]);
      expect(at("p2").ready, "its tiles are not its body: only its open reads it").toBe(undefined);
      expect([at("p6").body, at("p6").wordless, at("p6").ready], "a placeholder text is not its words").toEqual(["", true, undefined]);
      expect([at("p7").wordless, at("p7").attachments?.map((a) => a.filename), at("p7").ready], "a file pill is not its body").toEqual([true, ["flyer.pdf"], undefined]);
      expect([at("p3").wordless, at("p3").attachments, at("p3").ready], "nothing to draw: not ready").toEqual([true, undefined, undefined]);
      expect([at("p5").wordless, at("p5").attachments?.length, at("p5").ready], "words past the bound: its tiles alone are not its body").toEqual([true, 1, undefined]);
      expect(at("o1").ready, "CONTROL: a text member").toBe(true);
      expect(s.fake.message("p2")?.unread, "the open read nothing").toBe(true);

      // p2 as the reader lays it out, its end below its files; p3 under it, its line alone; p5 its tiles.
      const reads: string[][] = [];
      const r = readerOf({ opened: null, unread: new Set(["p2", "p3", "p5", "p6", "p7"]), onRead: (ids) => reads.push(ids), ready: (id) => at(id).ready === true });
      r.core.viewport(800); r.core.offset("padded", 0); r.core.offset("above", 0);
      r.core.panel("p2", "above", 0, 140); r.core.panelHeader("p2", 18, 30); r.core.panelBody("p2", 58); r.core.panelEnd("p2", 122);
      r.core.panel("p3", "above", 152, 100); r.core.panelHeader("p3", 18, 30); r.core.panelBody("p3", 58); r.core.panelEnd("p3", 88);
      r.core.panel("p5", "above", 264, 140); r.core.panelHeader("p5", 18, 30); r.core.panelBody("p5", 58); r.core.panelEnd("p5", 122);
      r.core.panel("p6", "above", 416, 100); r.core.panelHeader("p6", 18, 30); r.core.panelBody("p6", 58); r.core.panelEnd("p6", 88);
      r.core.panel("p7", "above", 528, 140); r.core.panelHeader("p7", 18, 30); r.core.panelBody("p7", 58); r.core.panelEnd("p7", 122);
      r.flush();
      expect(reads, "the write waits for the dwell").toEqual([]);
      r.pass(dwell);
      r.pass(5 * dwell);
      expect(reads, "on screen as cards, none of them read").toEqual([]);
      await settleWire(s.boot.engine);
      expect(["p2", "p3", "p5", "p6", "p7"].map((id) => s.fake.message(id)?.unread)).toEqual([true, true, true, true, true]);

      // A press on p3's card opens it alone: its html is the opened message's, read by the open's own rule.
      expect(await s.actions.openMessage("p3")).toBe(true);
      await settleWire(s.boot.engine);
      const p3 = liveMessage(s.boot.engine, "p3", view)!;
      expect([p3.html, p3.unread], "opened: its html to frame, unread until seen").toEqual([`<html><body><img src="https://pictures.fake.test/a.png"></body></html>`, true]);
      const opened: string[][] = [];
      const o = readerOf({ opened: "p3", unread: new Set(["p3"]), onRead: (ids) => { opened.push(ids); s.actions.markGlanced(ids); }, ready: (id) => id === "p3" });
      o.core.viewport(800); o.core.chrome(0); o.core.offset("padded", 0); o.core.offset("above", 0);
      o.core.offset("opened", 34); o.core.openedFrom(0, 40); o.core.openedBody(100); o.core.openedEnd(300);
      o.core.onScroll(0);
      o.pass(dwell);
      expect(opened, "its own open read it").toEqual([["p3"]]);
      await settleWire(s.boot.engine);
      expect(s.fake.message("p3")?.unread).toBe(false);
      for (const id of ["p2", "p6", "p7"]) {
        expect(await s.actions.openMessage(id)).toBe(true);
        await settleWire(s.boot.engine);
        const got: string[][] = [];
        const x = readerOf({ opened: id, unread: new Set([id]), onRead: (ids) => { got.push(ids); s.actions.markGlanced(ids); }, ready: (y) => y === id });
        x.core.viewport(800); x.core.chrome(0); x.core.offset("padded", 0); x.core.offset("above", 0);
        x.core.offset("opened", 34); x.core.openedFrom(0, 40); x.core.openedBody(100); x.core.openedEnd(300);
        x.core.onScroll(0);
        x.pass(dwell);
        expect(got, `${id}: its own open read it`).toEqual([[id]]);
        await settleWire(s.boot.engine);
        expect(s.fake.message(id)?.unread).toBe(false);
      }
    } finally {
      s.close();
    }
  }, 30_000);
});

describe("an html part's words, as a member draws them", () => {
  it("blocks start lines, paragraphs and lists leave a blank line, a quote keeps its marks", () => {
    expect(htmlWords("<div>Hi&nbsp;Ben,</div><div>the   plan<br>is in</div><p>Two</p><p>Three</p>")).toBe("Hi Ben,\nthe plan\nis in\n\nTwo\n\nThree");
    expect(htmlWords("<p>Mine</p><blockquote><p>Yours</p><p>more</p></blockquote>")).toBe("Mine\n\n> Yours\n>\n> more");
    expect(htmlWords("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>")).toBe("a b\nc");
    expect(htmlWords("<pre>x = 1\n  y = 2</pre>")).toBe("x = 1\n  y = 2");
  });
  it("draws nothing a reader never sees, and nothing from markup alone", () => {
    expect(htmlWords("<head><title>T</title><style>p{}</style></head><body><script>x()</script><p>words</p></body>")).toBe("words");
    expect(htmlWords("<img src=\"cid:a\" alt=\"a picture\">")).toBe("");
    expect(htmlWords("")).toBe("");
  });
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
