/**
 * THE REAL MAIL SCREENS: the world layer reads the ENGINE's mirror and triages through
 * `engine.mutate`.
 *
 * Everything here drives `src/state/live.ts` — the one module the screens render from —
 * against a REAL loopback HTTP server speaking the /sync + mutation contract, through
 * the same `bootEngine` composition the app runs (node:sqlite behind the expo-sqlite seam).
 * The screens themselves stay logic-free, so what a screen shows is exactly what these
 * functions answer.
 *
 * The suite bites in the directions the contract names:
 *  · the ohbox is the SERVER's mail, split by the shared `ohboxView` over the projection;
 *  · mark-read round-trips through the engine's mutate + /sync and SURVIVES KILL+RELAUNCH
 *    with the cursor intact (the oracle, extended over a mutation);
 *  · a screener decision applies optimistically and a server rejection ROLLS BACK, visibly;
 *  · the release / not-spam family REWRITES THE HOLDING RULE beside the moves — a bare-move
 *    implementation (the leckker defect, 2026-08-19) turns two tests red here.
 * (The nameless-ICS attachment label — `invite.ics`, never empty — is pinned on the engine
 * path itself: client-engine's calendar-texts suite, whose items the message screen renders
 * verbatim.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FOLDER_OF_VIEW,
  SqlMirrorStore,
  encodeSeqCursor,
  mirrorDbName,
  waterlineIdOf,
  type EngineMessage,
  type EntityReader,
  type RuleDTO,
} from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScreener,
  phoneRulesTravel,
  presentedOf,
  stableActions,
  waitingAfterDecide,
  type LiveDeps,
  type WorldActions,
  type WorldView,
} from "../src/state/live";
import type { ServerWaitingSender } from "../src/net/screener";
import { GroupedSweepLedger } from "../src/state/sweep";
import { mailRowSpoken, threadOfRow } from "../src/ui/row-spoken";
import { railItemsOf } from "../src/ui/reader-marks";
import { dto, listen, mailServer, ruleDto, type Dto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

/** One booted live session against a fresh mail server, engine started. */
async function liveWorldOn(
  fake: ReturnType<typeof mailServer>, origin: string,
  /* The world layer's own extra deps, injected by the cell that needs one — `forgetWaiting` is
     the paired door's, and a cell that passes none is the standalone shape exactly. */
  extra: Partial<LiveDeps> = {},
) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind === "refused" ? boot.reason : ""}`);
  await boot.verifyIdentity(); // the app's own sequence: the verdict opens the drain routes
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), ...extra });
  return { ...boot, actions, toasts };
}

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

/** Wait for the synchronous half of a dispatched mutation — the optimistic overlay. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── the suites ─────────────────────────────────────────────────────────────────────────────── */

describe("the world reads the engine's mirror", () => {
  it("the ohbox is the server's mail", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      // A DECIDED sender (allow rule → INBOX), so the consent cutline leaves their mail in
      // the Ohbox — the same projection the webapp's shell feeds its pile selectors.
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage(dto("m1", { subject: "Welcome" }));
      fake.addMessage(dto("m2", { subject: "Your invoice", unread: false }));
      const live = await liveWorldOn(fake, origin);

      const pres = presentedOf(live.engine.read(), view.now);
      const box = liveOhbox(pres, view);
      expect(box.fresh.map((m) => m.subject)).toEqual(["Welcome"]);
      expect(box.seen.map((m) => m.subject)).toEqual(["Your invoice"]);
      expect(box.total).toBe(2);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * THE CONVERSATION'S LENGTH ON A LIST ROW. `toMail` sets `earlier: []` for every row of every
   * list — only the reading view fills it — so `threadOfRow` read 0 everywhere and a conversation
   * of three drew and read as a single message. MUTATION WATCHED: drop the `threadCount` spread
   * from `toMail` and both assertions below go red.
   */
  it("a list row stands for its whole conversation, drawn and read out", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      for (const [id, date] of [["c1", "08:00"], ["c2", "09:00"], ["c3", "10:00"]] as const) {
        fake.addMessage({ ...dto(id, { subject: "Webshop" }), threadId: "T-web", date: `2026-08-19T${date}:00Z` });
      }
      const live = await liveWorldOn(fake, origin);

      const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
      const row = box.fresh.find((m) => m.id === "c3");
      expect(row?.threadCount).toBe(3);
      expect(threadOfRow(row!)).toBe(3);
      // The squares say the length (one per message, all three unread), so the count steps back.
      expect(mailRowSpoken(row!)).toContain("3 messages, oldest first: 3 unread");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a letter dated after it arrived, or with no Date, is placed and timed by its arrival", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      const at = (id: string, date: string | null, sortAt: string) =>
        fake.addMessage({ ...dto(id), date: date as string, sortAt } as Dto);
      at("newer", "2026-08-19T11:00:00Z", "2026-08-19T11:00:00Z");
      at("ahead", "2026-08-21T10:00:00Z", "2026-08-19T10:00:00Z");
      at("undated", null, "2026-08-19T09:00:00Z");
      const live = await liveWorldOn(fake, origin);
      const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
      expect(box.fresh.map((m) => [m.id, m.time])).toEqual([["newer", "11:00"], ["ahead", "10:00"], ["undated", "09:00"]]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a held square of a letter dated after it arrived, or undated, dates its arrival", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      const at = (id: string, date: string | null, sortAt: string) =>
        fake.addMessage({ ...dto(id, { subject: "Plan" }), threadId: "T-arr", date: date as string, sortAt } as Dto);
      at("undated", null, "2026-08-19T09:00:00Z");
      at("ahead", "2026-08-21T10:00:00Z", "2026-08-19T10:00:00Z");
      at("newer", "2026-08-19T11:00:00Z", "2026-08-19T11:00:00Z");
      const live = await liveWorldOn(fake, origin);
      const squares = (id: string) => Object.fromEntries(railItemsOf(liveMessage(live.engine, id, view)!).map((s) => [s.id, s.at]));
      const arrivals = { undated: "2026-08-19T09:00:00Z", ahead: "2026-08-19T10:00:00Z", newer: "2026-08-19T11:00:00Z" };
      expect(squares("newer")).toEqual(arrivals);
      expect(squares("ahead")).toEqual(arrivals);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * THE WINDOW IS NOT THE CONVERSATION. This phone holds three members; the server's thread row
   * names nine. MUTATION WATCHED: drop the thread lookup in `threadSizeIndex` and the row says
   * three — the size of the window, on a conversation of nine.
   */
  it("says how long the conversation is on the SERVER, not how much of it this phone holds", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      for (const [id, date] of [["w1", "08:00"], ["w2", "09:00"], ["w3", "10:00"]] as const) {
        fake.addMessage({ ...dto(id, { subject: "Webshop" }), threadId: "T-win", date: `2026-08-19T${date}:00Z` });
      }
      fake.addThread("T-win", ["o1", "o2", "o3", "w1", "w2", "w3", "o4", "o5", "o6"]);
      const live = await liveWorldOn(fake, origin);

      const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
      const row = box.fresh.find((m) => m.id === "w3");
      expect(row?.threadCount).toBe(9);
      expect(mailRowSpoken(row!)).toContain("9 messages in this conversation");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * A HELD MEMBER IS NOT IN THE CONVERSATION THE ROW OPENS, so the phone's row does not count it —
   * through the same `threadSizeIndex` the web reads (THREAD-SIZE-COUNTS-A-HELD-MEMBER).
   */
  it("does not count a held member of the conversation", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage({ ...dto("k1", { subject: "Webshop" }), threadId: "T-held", date: "2026-08-19T08:00:00Z" });
      fake.addMessage({
        ...dto("k2", { subject: "Re: Webshop", folder: "ohmail/Screener", from: { name: "S", address: "s@elsewhere.test" } }),
        threadId: "T-held", date: "2026-08-19T09:00:00Z",
      });
      fake.addThread("T-held", ["k1", "k2"]);
      const live = await liveWorldOn(fake, origin);

      const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
      const row = box.fresh.find((m) => m.id === "k1");
      expect(row, "the control: the placed member has its row").toBeDefined();
      expect(row?.threadCount).toBeUndefined();
      expect(mailRowSpoken(row!)).not.toContain("conversation");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /** A conversation of one wears no capsule and says nothing about one — on this surface too. */
  it("says nothing about a conversation on a row that stands for one message", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage({ ...dto("s1", { subject: "Alone" }), threadId: "T-solo" });
      const live = await liveWorldOn(fake, origin);

      const box = liveOhbox(presentedOf(live.engine.read(), view.now), view);
      const row = box.fresh.find((m) => m.id === "s1");
      expect(row?.threadCount).toBeUndefined();
      expect(threadOfRow(row!)).toBe(0);
      expect(mailRowSpoken(row!)).not.toContain("conversation");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("mark-read: optimistic, round-trips through /sync, survives kill+relaunch", () => {
  it("the reader's read flips the row at once, the server round-trips it, the reopened mirror holds it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage(dto("m1", { subject: "Welcome" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(true);

      // The Ohbox open holds the row and reads nothing; the reader's rule reads it on screen.
      await live.actions.openMessage("m1");
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(true);
      const settled = live.actions.markGlanced(["m1"]);
      await tick();
      // The optimistic overlay — visible before the wire has answered.
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(false);
      await settled;
      // The wire took it: PATCH /messages carried exactly this id.
      expect(fake.seen.some((r) => r.method === "PATCH" && r.url === "/messages" && r.body.includes("m1"))).toBe(true);

      // The round trip: the server's own row comes back read on the next drain.
      await live.engine.syncOnce();
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(false);
      const cursor = live.store.getCursor();
      expect(cursor).toBe(encodeSeqCursor(fake.currentSeq()));
      live.store.close();

      // Kill + relaunch: the mirror ALONE — the read state AND the cursor are both intact.
      const relaunched = new SqlMirrorStore({ owner: mirrorOwnerKey(origin, "acct-1"), open: world.open });
      await relaunched.load();
      expect((relaunched.get("message", "m1") as EngineMessage).unread).toBe(false);
      expect(relaunched.getCursor()).toBe(cursor);
      expect(world.names()).toContain(mirrorDbName(mirrorOwnerKey(origin, "acct-1")));
      relaunched.close();
    } finally {
      fake.server.close();
    }
  });

  it("a rejected mark-read rolls back and says so in one plain sentence", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage(dto("m1", { subject: "Welcome" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      fake.failNext("PATCH", "/messages");
      await live.actions.openMessage("m1");
      const settled = live.actions.markGlanced(["m1"]);
      await tick();
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(false); // optimistic
      await settled;
      expect(reader.get<EngineMessage>("message", "m1")?.unread).toBe(true); // rolled back
      expect(live.toasts.length).toBe(1);
      expect(live.toasts[0]).toMatch(/could not be saved/i);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the reading streams: sweep marks seen, leaving commits the waterline", () => {
  it("sweeps only the stream's own unread mail and anchors the line on leave", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News", date: "2026-08-19T09:00:00Z" }));
      fake.addMessage(dto("r2", { subject: "Issue 11", folder: "ohmail/News", date: "2026-08-18T09:00:00Z" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      await live.actions.sweepFeed("reads", ["r1", "nonsense"]);
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(false);
      expect(reader.get<EngineMessage>("message", "r2")?.unread).toBe(true);

      await live.actions.leaveFeed("reads");
      const meta = reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"));
      expect(meta?.newestSeenId).toBe("r1");

      const reads = liveReads(presentedOf(reader, view.now), view);
      expect(reads.items.map((m) => m.id)).toEqual(["r1", "r2"]);
      // The line renders directly above the anchor — nothing new since the sweep.
      expect(reads.waterlineAboveId).toBe("r1");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("screener decisions: the optimistic overlay and the rollback both fire", () => {
  it("a gate-physical decide files the bag optimistically and the server confirms", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "New Sender", address: "new@stranger.test" };
      fake.addMessage(dto("s1", { subject: "Hello there", folder: "ohmail/Screener", from: stranger }));
      fake.addMessage(dto("s2", { subject: "Following up", folder: "ohmail/Screener", from: stranger, date: "2026-08-19T09:00:00Z" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      const rows = liveScreener(presentedOf(reader, view.now), view);
      expect(rows.waiting).toHaveLength(1);
      const row = rows.waiting[0]!;
      expect(row.held).toHaveLength(2); // every held message, no collapse
      expect(row.gatePhysical).toBe(true);

      const settled = live.actions.decide(row, "ohbox", false, "sender");
      await tick();
      // Optimistic: the whole bag has left the gate before the wire answers.
      expect(reader.get<EngineMessage>("message", "s1")?.folder).toBe("INBOX");
      expect(reader.get<EngineMessage>("message", "s2")?.folder).toBe("INBOX");
      expect(await settled).toBe(true);
      expect(fake.seen.some((r) => r.method === "POST" && r.url.startsWith("/screener/"))).toBe(true);

      await live.engine.syncOnce();
      const after = liveScreener(presentedOf(reader, view.now), view);
      expect(after.waiting).toHaveLength(0);
      const box = liveOhbox(presentedOf(reader, view.now), view);
      expect(box.fresh.map((m) => m.subject).sort()).toEqual(["Following up", "Hello there"].sort());
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a refused decide rolls the bag back into the gate and names the failure", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "New Sender", address: "new@stranger.test" };
      fake.addMessage(dto("s1", { subject: "Hello there", folder: "ohmail/Screener", from: stranger }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();
      const row = liveScreener(presentedOf(reader, view.now), view).waiting[0]!;

      fake.failNext("POST", "/screener/");
      const settled = live.actions.decide(row, "ohbox", false, "sender");
      await tick();
      expect(reader.get<EngineMessage>("message", "s1")?.folder).toBe("INBOX"); // optimistic
      expect(await settled).toBe(false);
      expect(reader.get<EngineMessage>("message", "s1")?.folder).toBe("ohmail/Screener"); // rolled back
      expect(live.toasts.some((t) => /could not be saved/i.test(t))).toBe(true);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a past-the-gate row (mail presented, not held) decides through a rule, never a doomed decide", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      // Active undecided sender whose mail is ONLY in the INBOX: the consent cutline presents
      // it at the gate, and POST /screener/:id would 404 — the #116 shape the webapp routes
      // past the gate as a rule_create with applyRetro.
      const stranger = { name: "Inbox Stranger", address: "only@inbox.test" };
      fake.addMessage(dto("i1", { subject: "Slipped past", from: stranger }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      const rows = liveScreener(presentedOf(reader, view.now), view);
      expect(rows.waiting).toHaveLength(1);
      const row = rows.waiting[0]!;
      expect(row.gatePhysical).toBe(false);

      expect(await live.actions.decide(row, "ohbox", false, "sender")).toBe(true);
      // The wire saw a RULE, and never a decide that would have 404d.
      expect(fake.seen.some((r) => r.method === "POST" && r.url === "/rules")).toBe(true);
      expect(fake.seen.some((r) => r.method === "POST" && r.url.startsWith("/screener/"))).toBe(false);

      await live.engine.syncOnce();
      // With the rule landed, the sender is decided and the mail presents in the Ohbox.
      const after = liveScreener(presentedOf(reader, view.now), view);
      expect(after.waiting).toHaveLength(0);
      expect(liveOhbox(presentedOf(reader, view.now), view).fresh.map((m) => m.id)).toContain("i1");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * RULED, THE CARD FILES WHAT IT SHOWS: a past-the-gate card writes the rule with no past-mail
   * answer and moves the INBOX letter it listed by id, and nothing else — the pass is not asked for
   * mail the card never showed. It replaced the rule that asked the pass for the whole backlog.
   */
  it("Screen out on a past-the-gate row writes the rule with no past-mail answer and moves the letter it showed", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "Inbox Stranger", address: "adopted@inbox.test" };
      fake.addMessage(dto("i2", { subject: "Adopted at the gate", from: stranger }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();
      const row = liveScreener(presentedOf(reader, view.now), view).waiting[0]!;
      expect(row.gatePhysical).toBe(false);

      expect(await live.actions.decide(row, "screened", false, "sender")).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      const rule = fake.seen.find((r) => r.method === "POST" && r.url === "/rules");
      expect(rule, "no rule reached the wire").toBeDefined();
      expect(JSON.parse(rule!.body) as Record<string, unknown>)
        .toMatchObject({ kind: "sender", match: stranger.address, destination: "ohmail/Screened", applyRetro: false });
      expect(fake.seen.filter((r) => r.method === "POST" && /\/move$/.test(r.url)).map((r) => r.url))
        .toEqual(["/messages/i2/move"]);
      expect(reader.get<EngineMessage>("message", "i2")?.folder).toBe("ohmail/Screened");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a press that writes no rule still moves the letter now, with Undo — the control", async () => {
    // The same letter, pressed with Move: no rule holds the sender, so the move IS the instruction.
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "Inbox Stranger", address: "adopted@inbox.test" };
      fake.addMessage(dto("i2", { subject: "Adopted at the gate", from: stranger }));
      const undos: Array<() => void> = [];
      const live = await liveWorldOn(fake, origin, {
        toast: (m, opts) => { if (opts?.undo) undos.push(opts.undo); void m; },
      });
      const reader = live.engine.read();
      const letter = liveMessage(live.engine, "i2", view)!;
      expect(letter.presentedFolder, "the letter is not shown at the gate").toBe("ohmail/Screener");

      expect(await live.actions.move(letter, "screened")).toBe(true);
      expect(fake.seen.some((r) => r.method === "POST" && r.url === "/messages/i2/move"), "the move did not go").toBe(true);
      expect(fake.seen.some((r) => r.url.startsWith("/rules") && r.method !== "GET"), "a rule was written").toBe(false);
      expect(reader.get<EngineMessage>("message", "i2")?.folder).toBe("ohmail/Screened");

      expect(undos, "the sentence carries Undo").toHaveLength(1);
      const moves = fake.seen.filter((r) => r.url === "/messages/i2/move").length;
      undos[0]!();
      await arrived("the move back reached the wire", () => fake.seen.filter((r) => r.url === "/messages/i2/move").length > moves);
      expect(reader.get<EngineMessage>("message", "i2")?.folder).toBe("INBOX");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/**
 * ═══ THE WAITING SHELF FOLLOWS A LANDED DECIDE, NOT THE NEXT MANUAL SYNC ══════════════
 *
 * Measured on a device at 0.19.6, on the normal Cloud-paired configuration. Decide a waiting
 * sender to the Ohbox: the mutation lands, the server drops the sender (`GET /screener` fell
 * 6 → 5), and the phone's shelf keeps the row — count 6 against the server's 5 — with the
 * sender's NAME collapsed to its raw address. Background/foreground and a 45 s wait healed
 * nothing; only a manual "Sync now" did. What a person reads is that their decision did nothing
 * and the sender's name is now broken.
 *
 * One cause, both symptoms. On a paired door the shelf IS the cached `GET /screener` answer
 * joined onto the mirror (`liveScreener`), and nothing moved that cache at the press; the name
 * came from the JOIN, so when the decide filed the representative out of the gate the derived
 * row went with it and the join fell back to `rowOfServer`, whose name is `s.name || s.address`
 * over a route row that carries no name.
 *
 * The first cell is the device's own sequence with the fix in place; the second drives the SAME
 * sequence with the reconciliation absent and pins the defect it reproduces, so neither cell can
 * be green by blindness.
 */
describe("the Screener's waiting shelf is reconciled from the decide", () => {
  /** Six senders at the gate, as `GET /screener` states them — the route names no display name. */
  const SENDERS = [
    { name: "Nadia Ferro", address: "nadia@vendor.test" },
    { name: "Sven Kallio", address: "sven@vendor.test" },
    { name: "Pia Lund", address: "pia@news.test" },
    { name: "Tomas Reis", address: "tomas@news.test" },
    { name: "Ines Roth", address: "ines@shop.test" },
    { name: "Karl Adam", address: "karl@shop.test" },
  ] as const;

  /**
   * The route's rows. `name: null` is what the live service answered for these senders, and it is
   * the whole reason the degradation is visible: every name on this shelf comes from the mirror's
   * side of the join, so a row that loses its derived half loses its name.
   */
  const served = (): ServerWaitingSender[] => SENDERS.map((s, i) => ({
    messageId: `g${i + 1}`,
    address: s.address,
    name: null,
    receivedAt: `2026-08-1${i + 1}${"T"}09:00:00Z`,
    subject: `Message from ${s.name}`,
    snippet: "…",
  }));

  const seed = (fake: ReturnType<typeof mailServer>) => {
    SENDERS.forEach((s, i) => {
      fake.addMessage(dto(`g${i + 1}`, {
        subject: `Message from ${s.name}`,
        folder: "ohmail/Screener",
        from: { name: s.name, address: s.address },
        date: `2026-08-1${i + 1}${"T"}09:00:00Z`,
      }));
    });
  };

  it("drops the decided sender at once, keeps every other name, and asks for no manual sync", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      seed(fake);
      /* The world layer's own cache, reconciled through the app's own wiring: `world.tsx` hands
         `liveActions` a `forgetWaiting` that runs `waitingAfterDecide` over this exact state. */
      let queue: readonly ServerWaitingSender[] | null = served();
      const live = await liveWorldOn(fake, origin, {
        forgetWaiting: (decided) => { queue = waitingAfterDecide(queue, decided); },
      });
      const reader = live.engine.read();
      const shelf = () => liveScreener(presentedOf(reader, view.now), view, {}, queue);

      const before = shelf();
      expect(before.source, "this cell is about the PAIRED door's shelf").toBe("server");
      expect(before.waiting).toHaveLength(6);
      const row = before.waiting.find((r) => r.address === "nadia@vendor.test")!;
      /* The name is the MIRROR's — the route named none. This is the value the device lost. */
      expect(row.name).toBe("Nadia Ferro");

      expect(await live.actions.decide(row, "ohbox", false, "sender")).toBe(true);
      expect(fake.seen.some((r) => r.method === "POST" && r.url.startsWith("/screener/"))).toBe(true);

      /* NO `syncOnce()` BETWEEN THESE LINES, deliberately: the manual Sync now was the only thing
         that healed this on the device, and needing it is the defect. */
      const after = shelf();
      expect(after.waiting, "the decided sender still waits").toHaveLength(5);
      expect(after.waiting.map((r) => r.address)).not.toContain("nadia@vendor.test");
      /* AND NOBODY ELSE DEGRADED. `name === address` is the collapse, asserted over the whole
         shelf rather than one row — the fallback that produces it is per-row. */
      expect(after.waiting.filter((r) => r.name === r.address)).toEqual([]);
      expect(after.waiting.map((r) => r.name)).toEqual([
        "Sven Kallio", "Pia Lund", "Tomas Reis", "Ines Roth", "Karl Adam",
      ]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * THE SAME PRESS WITH NOTHING RECONCILING THE CACHE. This used to leave the ghost row, its name
   * collapsed to the address. The shared selector's join now reads the mirror's newer fact — it
   * holds the decided representative outside the gate — and drops the sender itself, so the
   * reconciliation above is a second mechanism. The ghost's own positive control is the join
   * rule's mutation (`screener-waiting-store.test.ts`, `joinStore`'s mirror check).
   */
  it("without the reconciliation the shared join still drops the decided sender and no name collapses", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      seed(fake);
      const queue: readonly ServerWaitingSender[] = served();
      const live = await liveWorldOn(fake, origin); // no `forgetWaiting` — the released shape
      const reader = live.engine.read();
      const shelf = () => liveScreener(presentedOf(reader, view.now), view, {}, queue);

      const row = shelf().waiting.find((r) => r.address === "nadia@vendor.test")!;
      expect(row.name).toBe("Nadia Ferro");
      expect(await live.actions.decide(row, "ohbox", false, "sender")).toBe(true);

      const after = shelf();
      expect(after.waiting, "the decided sender still waits").toHaveLength(5);
      expect(after.waiting.map((r) => r.address)).not.toContain("nadia@vendor.test");
      expect(after.waiting.filter((r) => r.name === r.address), "a name collapsed to the address").toEqual([]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * THE SAME MUTATION BY THE OTHER DOOR. `screenSender` — the open message's Screening sheet —
   * dispatches `screener_decide` too when the subject's mail is still at the gate, so a decide
   * made there left the same ghost row on the same shelf. Driven rather than argued: a guard
   * nobody has watched fire is not evidence, and this arm was written from the first one.
   */
  it("reconciles a decide made from the open message, on the same shelf", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      seed(fake);
      let queue: readonly ServerWaitingSender[] | null = served();
      const live = await liveWorldOn(fake, origin, {
        forgetWaiting: (decided) => { queue = waitingAfterDecide(queue, decided); },
      });
      const reader = live.engine.read();
      const shelf = () => liveScreener(presentedOf(reader, view.now), view, {}, queue);
      expect(shelf().waiting).toHaveLength(6);

      /* `g2` is the second sender's held message, physically at the gate — the branch of the rule
         ladder that DECIDES rather than writing a rule about mail already past it. */
      expect(await live.actions.screenSender("g2", "ohbox", "sender")).toBe(true);
      expect(fake.seen.some((r) => r.method === "POST" && r.url.startsWith("/screener/"))).toBe(true);

      const after = shelf();
      expect(after.waiting).toHaveLength(5);
      expect(after.waiting.map((r) => r.address)).not.toContain("sven@vendor.test");
      expect(after.waiting.filter((r) => r.name === r.address)).toEqual([]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/**
 * The rule itself, driven directly — `waitingAfterDecide` predicts what the route's next page
 * will say, and `GET /screener` filters DECIDED senders out of every page it returns.
 */
describe("waitingAfterDecide — what the route's next answer will hold", () => {
  const rows = (...addresses: string[]): ServerWaitingSender[] => addresses.map((address, i) => ({
    messageId: `m${i}`, address, name: null, receivedAt: "", subject: "", snippet: "",
  }));

  it("retires the pressed sender, and only that sender", () => {
    const out = waitingAfterDecide(rows("a@x.test", "b@x.test", "c@y.test"),
      { address: "a@x.test", scope: "sender" });
    expect(out?.map((r) => r.address)).toEqual(["b@x.test", "c@y.test"]);
  });

  it("retires the WHOLE domain on a domain decide, because the rule does", () => {
    /* A domain-scoped decide writes a domain rule, so every sender at that domain is decided and
       the route's next page names none of them. Retiring only the pressed one would leave the
       others on screen until a drain — the same stale shelf, one press narrower. */
    const out = waitingAfterDecide(rows("a@x.test", "b@x.test", "c@y.test"),
      { address: "a@x.test", scope: "domain" });
    expect(out?.map((r) => r.address)).toEqual(["c@y.test"]);
  });

  it("matches case-insensitively, as both ends key senders", () => {
    const out = waitingAfterDecide(rows("Mixed@X.test"), { address: "mixed@x.test", scope: "sender" });
    expect(out).toEqual([]);
  });

  it("keeps `null` — nobody answered is not an empty shelf", () => {
    expect(waitingAfterDecide(null, { address: "a@x.test", scope: "sender" })).toBeNull();
  });

  it("retires NOTHING rather than everything when a domain decide has no domain", () => {
    /* The empty string is every address's suffix: a malformed row taken as a domain would empty
       the whole shelf, which is the defect this function exists against pointing the other way. */
    const all = rows("a@x.test", "b@y.test");
    expect(waitingAfterDecide(all, { address: "no-at-sign", scope: "domain" })).toEqual(all);
  });
});

describe("the release family rewrites the holding RULE — never bare moves (the leckker defect)", () => {
  it("not-spam retargets the holding rule and moves only the physically-quarantined mail", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const noisy = { name: "Noisy", address: "noisy@sender.test" };
      // The holding rule: everything from this sender is quarantined — including the row
      // physically still in the INBOX, which the projection PRESENTS in Spam.
      fake.addRule(ruleDto("r-quar", "sender", "noisy@sender.test", "ohmail/Quarantine"));
      fake.addMessage(dto("q1", { subject: "Held one", folder: "ohmail/Quarantine", from: noisy }));
      fake.addMessage(dto("q2", { subject: "Held two", folder: "ohmail/Quarantine", from: noisy, date: "2026-08-19T09:00:00Z" }));
      fake.addMessage(dto("q3", { subject: "Presented only", from: noisy, date: "2026-08-19T10:00:00Z" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      const rows = liveScreener(presentedOf(reader, view.now), view);
      expect(rows.spam).toHaveLength(1);
      const row = rows.spam[0]!;
      expect(row.held).toHaveLength(3);

      expect(await live.actions.release(row, "ohbox", "spam")).toBe(true);

      // THE HOTFIX SHAPE: the holding rule was retargeted…
      const rulePatches = fake.seen.filter((r) => r.method === "PATCH" && r.url === "/rules/r-quar");
      expect(rulePatches).toHaveLength(1);
      expect(rulePatches[0]!.body).toContain("INBOX");
      // …and the moves covered ONLY the physically-quarantined mail. A move for q3 — already
      // at the destination — is the engine's local 404 and the whole release fails: the
      // bare-move bug this suite exists to keep off mobile.
      const moves = fake.seen.filter((r) => r.method === "POST" && /\/messages\/q\d\/move/.test(r.url));
      expect(moves.map((r) => r.url).sort()).toEqual(["/messages/q1/move", "/messages/q2/move"]);

      await live.engine.syncOnce();
      const after = liveScreener(presentedOf(reader, view.now), view);
      expect(after.spam).toHaveLength(0);
      expect(fake.rule("r-quar")?.destination).toBe("INBOX");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a rule-held sender with NOTHING physically in the segment still releases — the rule alone", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const noisy = { name: "Noisy", address: "noisy@sender.test" };
      fake.addRule(ruleDto("r-quar", "sender", "noisy@sender.test", "ohmail/Quarantine"));
      fake.addMessage(dto("q3", { subject: "Presented only", from: noisy }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      const row = liveScreener(presentedOf(reader, view.now), view).spam[0]!;
      // A bare-move implementation dispatches nothing here and must answer false; the rule
      // rewrite is the only thing that can perform this release.
      expect(await live.actions.release(row, "ohbox", "spam")).toBe(true);
      expect(fake.seen.some((r) => r.method === "PATCH" && r.url === "/rules/r-quar")).toBe(true);
      expect(fake.seen.some((r) => /\/move$/.test(r.url))).toBe(false);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("triage from the message screen: park lands in a pile and leaves the ohbox", () => {
  it("setPile applies optimistically and the pile lister and ohbox agree", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
      fake.addMessage(dto("m1", { subject: "Park me" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      expect(await live.actions.setPile("m1", "setAside")).toBe(true);
      const pres = presentedOf(reader, view.now);
      const piles = livePiles(pres, view);
      expect(piles.find((p) => p.kind === "setAside")?.items.map((i) => i.messageId)).toEqual(["m1"]);
      const box = liveOhbox(pres, view);
      expect([...box.fresh, ...box.seen].map((m) => m.id)).not.toContain("m1");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the message view reads the engine: body, conversation, place", () => {
  it("liveMessage answers the mirror's row with its body text and stream place", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News" }));
      const live = await liveWorldOn(fake, origin);
      const m = liveMessage(live.engine, "r1", view);
      expect(m?.subject).toBe("Issue 12");
      expect(m?.place).toBe("reads");
      expect(m?.body).toBe("Issue 12"); // the snippet until hydration — never invented
      expect(liveMessage(live.engine, "missing", view)).toBeUndefined();
      live.store.close();
    } finally {
      fake.server.close();
    }
  });

  /**
   * THE FORWARD ROW ON THE PHONE. The account's own forward threads with the message it forwarded,
   * so the original's reader lists it under "Earlier in this conversation" — faced "Forwarded to
   * <recipient>" in place of the subject, the same predicate the web panel reads
   * (`isForwardedByUs`). The account's own REPLY in the thread keeps its subject as its lead line.
   * Mutation watched red: drop the `face` spread in `liveMessage` — the first assertion reads
   * undefined.
   */
  it("an own forward in the conversation is faced 'Forwarded to …'; an own reply keeps its subject", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage({ ...dto("o1", { subject: "Issue 12", date: "2026-08-19T08:00:00Z" }), threadId: "t1" });
      fake.addMessage({
        ...dto("f1", { subject: "Fwd: Issue 12", folder: "Sent", unread: false, date: "2026-08-19T09:00:00Z" }),
        threadId: "t1",
        to: [{ name: "Sam Example", address: "sam@colleague.example" }, { name: null, address: "kim@colleague.example" }],
      });
      fake.addMessage({
        ...dto("r1", { subject: "Re: Issue 12", folder: "Sent", unread: false, date: "2026-08-19T10:00:00Z" }),
        threadId: "t1",
        to: [{ name: "Test Sender", address: "sender@fake.test" }],
      });
      const live = await liveWorldOn(fake, origin);
      const m = liveMessage(live.engine, "o1", view);
      expect(m?.earlier.map((h) => h.id)).toEqual(["f1", "r1"]);
      expect(m?.earlier[0]?.face).toBe("Forwarded to Sam Example, kim@colleague.example");
      expect(m?.earlier[0]?.subject).toBe("Fwd: Issue 12");
      expect(m?.earlier[1]?.face).toBeUndefined();
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* ── a review's findings, pinned (each was watched red against the defect) ─────────────────── */

describe("sweep geometry: grouped rows measure in scroll-content coordinates", () => {
  it("a later day group's first row (local y=0) is NOT swept when only the top row passed", () => {
    const ledger = new GroupedSweepLedger();
    ledger.setPanel(100);
    ledger.setGroup("Today", 0);
    ledger.setItems("Today", 30);
    ledger.setRow("t1", "Today", 0, 80);
    ledger.setRow("t2", "Today", 80, 80);
    ledger.setGroup("Monday", 190);
    ledger.setItems("Monday", 30);
    // Monday's first row: LOCAL y = 0 — the raw-y bug's exact shape. Its real foot is
    // panel(100) + group(190) + items(30) + 0 + h(80) = 400.
    ledger.setRow("m1", "Monday", 0, 80);
    // The line clears Today's first row only (its foot: 100 + 0 + 30 + 0 + 80 = 210).
    expect(ledger.passed(215)).toEqual(["t1"]);
    expect(ledger.passed(399)).not.toContain("m1");
    expect(ledger.passed(401).sort()).toEqual(["m1", "t1", "t2"].sort());
  });

  it("an unmeasured chain never answers passed — no guessing in the read-marking direction", () => {
    const ledger = new GroupedSweepLedger();
    ledger.setRow("x", "G", 0, 10);
    expect(ledger.passed(10_000)).toEqual([]);
  });
});

describe("the actions facade is ONE object delegating per call", () => {
  const recording = (tag: string, calls: string[]): WorldActions => ({
    markSeenThrough: () => calls.push(`${tag}:markSeenThrough`),
    leaveFeed: () => calls.push(`${tag}:leaveFeed`),
    openMessage: () => calls.push(`${tag}:openMessage`),
    leaveMessage: () => calls.push(`${tag}:leaveMessage`),
    loadInlineImages: () => calls.push(`${tag}:loadInlineImages`),
    releaseAttachments: () => calls.push(`${tag}:releaseAttachments`),
    openAttachmentBytes: async () => {
      calls.push(`${tag}:openAttachmentBytes`);
      return { state: "unavailable" as const };
    },
    hydrateMessage: () => calls.push(`${tag}:hydrateMessage`),
    forwardFetch: () => (calls.push(`${tag}:forwardFetch`), null),
    forwardFiles: () => (calls.push(`${tag}:forwardFiles`), { state: "failed" as const, parts: [] }),
    forwardPartsSupported: () => (calls.push(`${tag}:forwardPartsSupported`), false),
    // The two abandoned-change verbs are async, so the recorder returns a resolved promise; the
    // facade test is about WHICH object a call lands on, not what it answers.
    retryAbandoned: async (id: string) => {
      calls.push(`${tag}:retryAbandoned`);
      return { id, key: id, status: "confirmed" as const, seq: 1 };
    },
    discardAbandoned: async () => { calls.push(`${tag}:discardAbandoned`); },
    retryQueued: async () => { calls.push(`${tag}:retryQueued`); return null; },
    discardQueued: async () => { calls.push(`${tag}:discardQueued`); return "gone" as const; },
    hydrateHeld: () => calls.push(`${tag}:hydrateHeld`),
    holdFiles: () => calls.push(`${tag}:holdFiles`),
    releaseFiles: () => calls.push(`${tag}:releaseFiles`),
    decide: () => calls.push(`${tag}:decide`),
    reachOf: () => (calls.push(`${tag}:reachOf`), { others: [], inboxIds: [] }),
    unsubClaimOf: () => (calls.push(`${tag}:unsubClaimOf`), "none" as const),
    screeningUnsubClaim: () => (calls.push(`${tag}:screeningUnsubClaim`), "none" as const),
    setScope: () => calls.push(`${tag}:setScope`),
    allow: () => calls.push(`${tag}:allow`),
    notSpam: () => calls.push(`${tag}:notSpam`),
    addToPile: () => calls.push(`${tag}:addToPile`),
    pileToggle: () => calls.push(`${tag}:pileToggle`),
    resurfaceToggle: () => calls.push(`${tag}:resurfaceToggle`),
    resurfaceAt: () => calls.push(`${tag}:resurfaceAt`),
    resurfaceNow: () => calls.push(`${tag}:resurfaceNow`),
    resurfaceDone: () => calls.push(`${tag}:resurfaceDone`),
    markSeen: () => calls.push(`${tag}:markSeen`),
    markRowSeen: () => calls.push(`${tag}:markRowSeen`),
    markGlanced: () => calls.push(`${tag}:markGlanced`),
    markAllSeen: () => calls.push(`${tag}:markAllSeen`),
    markOhboxVisit: () => calls.push(`${tag}:markOhboxVisit`),
    move: () => calls.push(`${tag}:move`),
    deleteMessage: () => calls.push(`${tag}:deleteMessage`),
    // Awaited by their screen, so the recorder answers the empty-world shapes.
    trashList: async () => {
      calls.push(`${tag}:trashList`);
      return { state: "unavailable" as const };
    },
    trashRestore: async () => {
      calls.push(`${tag}:trashRestore`);
      return false;
    },
    sendReply: () => (calls.push(`${tag}:sendReply`), Promise.resolve({ outcome: "sent" as const })),
    sendForward: () => (calls.push(`${tag}:sendForward`), Promise.resolve({ outcome: "sent" as const })),
    sendNew: () => (calls.push(`${tag}:sendNew`), Promise.resolve({ outcome: "sent" as const })),
    sendAndDoneOffered: () => (calls.push(`${tag}:sendAndDoneOffered`), false),
    withdrawSend: () => (calls.push(`${tag}:withdrawSend`), Promise.resolve("withdrawn" as const)),
    leaveSend: () => { calls.push(`${tag}:leaveSend`); },
    cancelWaitingSend: () => (calls.push(`${tag}:cancelWaitingSend`), Promise.resolve({ said: "withdrawn" as const, kept: null })),
    cancelSchedule: () => (calls.push(`${tag}:cancelSchedule`), Promise.resolve(true)),
    draftDiscard: () => (calls.push(`${tag}:draftDiscard`), Promise.resolve("discarded" as const)),
    draftResolve: () => (calls.push(`${tag}:draftResolve`), Promise.resolve(true)),
    draftSendAgain: () => (calls.push(`${tag}:draftSendAgain`), Promise.resolve("sent" as const)),
    draftKeep: () => (calls.push(`${tag}:draftKeep`), Promise.resolve("kept" as const)),
    keepEnvelope: () => (calls.push(`${tag}:keepEnvelope`), null),
    draftSent: () => (calls.push(`${tag}:draftSent`), false),
    draftLeft: () => (calls.push(`${tag}:draftLeft`), null),
    sendOutcome: () => (calls.push(`${tag}:sendOutcome`), "unknown" as const),
    tagToggle: () => calls.push(`${tag}:tagToggle`),
    tagCreate: () => calls.push(`${tag}:tagCreate`),
    screenSender: () => calls.push(`${tag}:screenSender`),
    screeningForecast: () => { calls.push(`${tag}:screeningForecast`); return null; },
    screeningRules: () => { calls.push(`${tag}:screeningRules`); return null; },
    screeningStayed: () => { calls.push(`${tag}:screeningStayed`); return null; },
    stayedWhy: () => (calls.push(`${tag}:stayedWhy`), Promise.resolve(new Map())),
    moveStayed: () => calls.push(`${tag}:moveStayed`),
    screenUnscreened: () => (calls.push(`${tag}:screenUnscreened`), Promise.resolve(true)),
    folderCreate: () => calls.push(`${tag}:folderCreate`),
    folderRename: () => calls.push(`${tag}:folderRename`),
    folderDelete: () => calls.push(`${tag}:folderDelete`),
    folderDismiss: () => calls.push(`${tag}:folderDismiss`),
  });

  it("keeps its identity while the backend swaps under it — effects hung off it never re-fire", () => {
    const calls: string[] = [];
    let backend = recording("a", calls);
    const actions = stableActions(() => backend);
    const before = actions;
    actions.leaveFeed("reads");
    backend = recording("b", calls);
    // The identity is the whole point: a `useFocusEffect` keyed on this object must not see
    // a new value when the world re-derives, or its cleanup commits the waterline mid-visit.
    expect(actions).toBe(before);
    actions.leaveFeed("reads");
    actions.openMessage("m1");
    expect(calls).toEqual(["a:leaveFeed", "b:leaveFeed", "b:openMessage"]);
  });
});

describe("a rejected sweep stays retriable and never anchors the line", () => {
  it("rolls the cache back with the engine; the next pass re-attempts; no anchor is committed", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      fake.failNext("PATCH", "/messages/");
      expect(await live.actions.sweepFeed("reads", ["r1"])).toBe(false);
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(true); // rolled back
      // The failed row may not anchor the line: leaving commits nothing.
      await live.actions.leaveFeed("reads");
      expect(reader.get("view_meta", waterlineIdOf("reads"))).toBeUndefined();
      // …and the id is NOT skip-listed: the next scroll pass re-attempts and lands.
      expect(await live.actions.sweepFeed("reads", ["r1"])).toBe(true);
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(false);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("each feed visit has its own swept pool", () => {
  it("a message re-unread by another client is sweepable on the next visit", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      expect(await live.actions.sweepFeed("reads", ["r1"])).toBe(true);
      await live.actions.leaveFeed("reads"); // the visit ends; the pool is consumed
      // Another client puts the issue back unread; the change rides the next drain.
      fake.update("r1", { unread: true, lastReadAt: null });
      await live.engine.syncOnce();
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(true);
      // A fresh visit sweeps it again — a session-lifetime pool would skip it for ever.
      expect(await live.actions.sweepFeed("reads", ["r1"])).toBe(true);
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(false);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("screener rows carry a stable route identity", () => {
  it("routeKey survives a re-minted representative; the scope choice stays keyed to it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "New Sender", address: "New@Stranger.test" };
      fake.addMessage(dto("s1", { subject: "Hello there", folder: "ohmail/Screener", from: stranger }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      const first = liveScreener(presentedOf(reader, view.now), view).waiting[0]!;
      expect(first.id).toBe("s1");
      expect(first.routeKey).toBe("new@stranger.test"); // the sender key, case-folded
      // The reader's scope choice, keyed by the STABLE identity:
      const scoped = liveScreener(presentedOf(reader, view.now), view, { [first.routeKey]: "domain" });
      expect(scoped.waiting[0]?.scope).toBe("domain");

      // Newer mail from the very sender re-mints the representative…
      fake.addMessage(
        dto("s2", { subject: "Following up", folder: "ohmail/Screener", from: stranger, date: "2026-08-19T10:00:00Z" }),
      );
      await live.engine.syncOnce();
      const again = liveScreener(presentedOf(reader, view.now), view, { [first.routeKey]: "domain" }).waiting[0]!;
      expect(again.id).toBe("s2"); // …so the rep id moved…
      expect(again.routeKey).toBe(first.routeKey); // …and the route identity did not…
      expect(again.scope).toBe("domain"); // …and neither did the scope choice.
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("held mail hydrates before a decision is offered", () => {
  it("carries the honest bodyState and asks the wire for the whole bag's bodies", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const stranger = { name: "New Sender", address: "new@stranger.test" };
      fake.addMessage(dto("s1", { subject: "Hello there", folder: "ohmail/Screener", from: stranger }));
      const live = await liveWorldOn(fake, origin);

      const row = liveScreener(presentedOf(live.engine.read(), view.now), view).waiting[0]!;
      // Pre-hydration a derived row's held body IS its snippet, and the row says so — a
      // consent decision over a one-line preview presented as the mail is the defect.
      expect(row.held[0]?.bodyState).toBe("snippet");

      live.actions.hydrateHeld(row.held.map((h) => h.id));
      const asked = () => fake.seen.some((r) => r.method === "GET" && r.url === "/messages/bodies");
      await arrived("the held bag's GET /messages/bodies", asked);
      expect(asked()).toBe(true);
      live.store.close();
    } finally {
      fake.server.close();
    }
  }, CASE_MS);
});

describe("a failed body is re-asked on an explicit reopen", () => {
  it("passes the engine's retry flag when the record is failed, instead of skipping for the session", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News" }));
      const live = await liveWorldOn(fake, origin);
      const bodyGets = () =>
        fake.seen.filter((r) => r.method === "GET" && r.url === "/messages/r1/body").length;

      const state = () => live.engine.read().get<{ state?: string }>("message_body", "r1")?.state ?? "no body record";
      live.actions.hydrateMessage("r1"); // the fake serves no body route → 404 → `failed`
      // The reopen reads the record: it must be `failed` before the human asks again.
      await arrived("r1's failed body record", () => state() === "failed", state);
      expect(bodyGets()).toBe(1);
      live.actions.hydrateMessage("r1"); // the reopen: a human asked again
      await arrived("the reopen's second GET /messages/r1/body", () => bodyGets() >= 2, () => `${bodyGets()} GET(s), ${state()}`);
      // Without `retry: true` the engine's gate skips a failed record and this stays 1 —
      // "Reopen to try again" could never recover in the same session.
      expect(bodyGets()).toBe(2);
      live.store.close();
    } finally {
      fake.server.close();
    }
  }, CASE_MS);
});

describe("the receipts leave-commit is rendered", () => {
  it("the world exposes the receipts anchor so the line the commit writes has a home", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("rc1", { subject: "Invoice #078", folder: "ohmail/Receipts" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      expect(await live.actions.sweepFeed("receipts", ["rc1"])).toBe(true);
      expect(await live.actions.leaveFeed("receipts")).toBe(true);
      expect(reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("receipts"))?.newestSeenId).toBe("rc1");
      expect(liveReceipts(presentedOf(reader, view.now), view).waterlineAboveId).toBe("rc1");
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* ── the verification review's findings, pinned ────────────────────────────────────────────── */

describe("the leave commit waits for in-flight sweeps", () => {
  it("a sweep still in the air when the reader leaves cannot anchor after its rollback", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 12", folder: "ohmail/News" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();

      fake.failNext("PATCH", "/messages/"); // answers LATE and refuses — the flip will roll back
      // The scroll handler's real shape: the sweep is dispatched, never awaited…
      const sweep = live.actions.sweepFeed("reads", ["r1"]);
      // …and the tab switch leaves immediately, while the flip is still optimistic.
      const left = live.actions.leaveFeed("reads");
      await Promise.all([sweep, left]);

      // The rollback restored the row unread — and the line did NOT anchor on it: an
      // unawaited consume would have committed r1 as "seen up to here" before the wire
      // answered, leaving unread mail below a line that claims it was swept.
      expect(reader.get<EngineMessage>("message", "r1")?.unread).toBe(true);
      expect(reader.get("view_meta", waterlineIdOf("reads"))).toBeUndefined();
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the sweep ledger prunes to the rendered generation", () => {
  it("a row the projection re-homed is no longer answered as passed", () => {
    const ledger = new GroupedSweepLedger();
    ledger.setPanel(0);
    ledger.setGroup("g1", 0);
    ledger.setItems("g1", 0);
    ledger.setRow("keep", "g1", 0, 10);
    ledger.setRow("gone", "g1", 10, 10);
    expect(ledger.passed(1000).sort()).toEqual(["gone", "keep"]);
    // The projected list re-rendered without "gone" (a consent/rule re-home): no onLayout
    // fires for a row that is not rendered, so the prune is the only thing standing between
    // its stale measurement and a read-mark on mail nobody saw.
    ledger.retain(["keep"], ["g1"]);
    expect(ledger.passed(1000)).toEqual(["keep"]);
  });

  it("a group that left the list takes its offsets with it", () => {
    const ledger = new GroupedSweepLedger();
    ledger.setPanel(0);
    ledger.setGroup("g1", 0);
    ledger.setItems("g1", 0);
    ledger.setRow("a", "g1", 0, 10);
    ledger.retain(["a"], []); // the row survived but its group is gone from the render
    expect(ledger.passed(1000)).toEqual([]); // an incomplete chain never answers passed
  });

  it("answers each fully measured row's frame, and forgets a row whose cell left the list", () => {
    const ledger = new GroupedSweepLedger();
    ledger.setPanel(100);
    ledger.setGroup("g1", 0);
    ledger.setItems("g1", 30);
    ledger.setRow("a", "g1", 0, 80);
    ledger.setRow("b", "g1", 80, 80);
    ledger.setRow("x", "unmeasured", 0, 10);
    expect(ledger.frames()).toEqual([
      { id: "a", top: 130, bottom: 210 },
      { id: "b", top: 210, bottom: 290 },
    ]);
    ledger.drop("a");
    expect(ledger.frames().map((f) => f.id)).toEqual(["b"]);
    expect(ledger.passed(1000)).toEqual(["b"]);
  });
});

describe("a visit that marked only deep letters leaves the arrivals above it unread", () => {
  it("the line anchors on the newest letter marked, and the newer ones stay new", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("r1", { subject: "Issue 13", folder: "ohmail/News", date: "2026-08-20T09:00:00Z" }));
      fake.addMessage(dto("r2", { subject: "Issue 12", folder: "ohmail/News", date: "2026-08-19T09:00:00Z" }));
      fake.addMessage(dto("r3", { subject: "Issue 11", folder: "ohmail/News", date: "2026-08-18T09:00:00Z" }));
      const live = await liveWorldOn(fake, origin);
      const reader = live.engine.read();
      await live.actions.sweepFeed("reads", ["r3"]);
      await live.actions.leaveFeed("reads");
      expect(reader.get<{ newestSeenId: string }>("view_meta", waterlineIdOf("reads"))?.newestSeenId).toBe("r3");
      const reads = liveReads(presentedOf(reader, view.now), view);
      expect(reads.waterlineAboveId).toBe("r3");
      expect(reads.items.filter((m) => m.unread).map((m) => m.id)).toEqual(["r1", "r2"]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* Keep the demo world's own gates in view: this file adds the LIVE world beside the fixtures
 * machine; `no-collapse.test.ts` and `privacy.test.ts` still hold the "Demo/public content" invariant over the demo
 * (they run in this same suite, unchanged). */

describe("the Piles screen is translatable — it reads the deck, not a copy of it", () => {
  /**
   * ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────────
   *
   * `livePiles` used to spread a `PILE_META` const into every pile row. That const held its own
   * copies of the three titles — the same English the copy deck already held, and already used
   * by the More screen. In English the two decks are indistinguishable, so every existing test
   * passed and the screen looked right.
   *
   * It only breaks once a deck is translated: the More screen follows the deck, the Piles screen
   * follows its private copy, and that one screen stays English in BOTH its titles and its notes.
   * A guard written in English can never catch that, which is why this one supplies a deck that
   * is not English and asserts the English does not survive.
   *
   * The deck is mutated in place rather than mocked because the fix is specifically that the
   * wording is read AT CALL TIME: a module-level capture would pass a mock and still ship the
   * bug. `finally` restores it, or every later test in this file inherits the stand-in.
   */
  const ENGLISH = [
    "Answer Later", "Parked", "Resurface",
    "Answers you owe. A Reply Run walks them one screen at a time.",
    "Kept in view without keeping the Ohbox busy.",
    "Comes back on its own, at the time you chose.",
  ];

  it("a non-English deck reaches every pile title and note", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    /*
     * THE REAL MECHANISM, not a monkey-patch. This used to assign onto `Copy` to install German.
     * `Copy` is a table of live getters over the active deck now, so assignment throws — and the
     * substitution was never what shipped anyway. Switching the active locale drives the same
     * path the app drives, and the expectations below read the German deck rather than repeating
     * it, so they cannot drift from it.
     */
    try {
      setActiveLocale("de");

      fake.addMessage(dto("m1", { subject: "Park me" }));
      const live = await liveWorldOn(fake, origin);
      const piles = livePiles(presentedOf(live.engine.read(), view.now), view);
      expect(piles).toHaveLength(3);

      for (const p of piles) {
        expect(ENGLISH, `the ${p.kind} pile's title stayed English`).not.toContain(p.title);
        expect(ENGLISH, `the ${p.kind} pile's note stayed English`).not.toContain(p.note);
      }
      // …and it is the DECK's wording, not merely something else.
      expect(piles.map((p) => p.title)).toEqual([DE.replyLater, DE.setAside, DE.resurface]);
      expect(piles.map((p) => p.note)).toEqual([DE.replyLaterNote, DE.setAsideNote, DE.resurfaceNote]);
      live.store.close();
    } finally {
      resetLocaleRegisterForTests();
      fake.server.close();
    }
  });

  it("the More screen and the Piles screen name a pile the same way", async () => {
    // The two decks agreed in English, which is exactly why nobody noticed they were two. This
    // says they are ONE: the strings the More screen renders are the strings the piles carry.
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("m1", {}));
      const live = await liveWorldOn(fake, origin);
      const piles = livePiles(presentedOf(live.engine.read(), view.now), view);
      const titleOf = (k: string) => piles.find((p) => p.kind === k)?.title;
      expect(titleOf("replyLater")).toBe(Copy.replyLater);
      expect(titleOf("setAside")).toBe(Copy.setAside);
      expect(titleOf("resurface")).toBe(Copy.resurface);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the sheet's rules on a mailbox this install only reads", () => {
  it("names the organizer's rule, never a stale rule of this install's own", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule(ruleDto("local-1", "sender", "sender@fake.test", "ohmail/News"));
      fake.addMessage(dto("m1", { subject: "Order", folder: "ohmail/Receipts" }));
      const at = "2026-08-19T09:00:00Z";
      fake.push("mailbox_profile", "create", "mb-1", {
        mailboxId: "mb-1", rules: [ruleDto("profile:mb-1:0", "sender", "sender@fake.test", "ohmail/Receipts")],
        asOf: at, from: { kind: "local", name: "Laptop", since: null }, updatedAt: at, applied: null,
      });
      const live = await liveWorldOn(fake, origin);
      const inPlay = live.actions.screeningRules("m1", "sender");
      expect(inPlay?.lines.flatMap((l) => l.rules.map((r) => `${r.id}->${r.destination}`))).toEqual(["profile:mb-1:0->ohmail/Receipts"]);
      live.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the phone sheet plans a press over the organizer's copy where the change travels there", () => {
  it("a stale row here says Ohbox, the organizer files News: the Ohbox press rewrites the rule", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addRule({ ...ruleDto("local-1", "sender", "sender@fake.test", "INBOX"), provenance: "manual" });
      fake.addMessage(dto("m1", { subject: "Letter", folder: "ohmail/News" }));
      const at = "2026-08-19T09:00:00Z";
      fake.push("mailbox_profile", "create", "mb-1", {
        mailboxId: "mb-1", rules: [ruleDto("profile:mb-1:0", "sender", "sender@fake.test", "ohmail/News")],
        asOf: at, from: { kind: "local", name: "Laptop", since: null }, updatedAt: at, applied: [],
      });
      const here = await liveWorldOn(fake, origin);
      expect(here.actions.screeningForecast("m1", "ohbox", "sender", false)?.keep.writes, "over this device's row").toEqual([]);
      here.store.close();
      const travels = await liveWorldOn(fake, origin, { rulesTravel: () => true });
      expect(travels.actions.screeningForecast("m1", "ohbox", "sender", false)?.keep.writes)
        .toEqual([{ kind: "rule_update", ruleId: "local-1", destination: "INBOX", applyRetro: false }]);
      travels.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a Screener press past the gate plans over the copy: a stale row here at News, none there", async () => {
    const from = { name: "Letters", address: "s@letters.example" };
    for (const rulesTravel of [false, true]) {
      const fake = mailServer();
      const origin = await listen(fake.server);
      try {
        fake.addRule({ ...ruleDto("r-stale", "sender", from.address, "ohmail/News"), provenance: "manual" });
        fake.addMessage(dto("i1", { subject: "Letter", folder: "INBOX", from }));
        const at = "2026-08-19T08:00:00Z";
        fake.push("mailbox_profile", "create", "mb-1", {
          mailboxId: "mb-1", rules: [], asOf: at, from: { kind: "local", name: "Laptop", since: null }, updatedAt: at, applied: [],
        });
        const live = await liveWorldOn(fake, origin, { rulesTravel: () => rulesTravel });
        const row = liveScreener(presentedOf(live.engine.read(), view.now), view).waiting.find((r) => r.address === from.address);
        expect(row, "the sender is not waiting").toBeTruthy();
        await live.actions.decide(row!, "reads", false, "sender");
        const rules = fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET").map((r) => `${r.method} ${r.url}`);
        expect(rules, `rulesTravel ${rulesTravel}`).toEqual(rulesTravel ? ["POST /rules"] : []);
        live.store.close();
      } finally {
        fake.server.close();
      }
    }
  });

  it("phoneRulesTravel: every mailbox read here with a live holder, and nothing else", () => {
    const held = { organizerRole: "reader" as const, organizedBy: { kind: "local", name: "Laptop" }, organizerState: "held" as const };
    expect(phoneRulesTravel([held, held])).toBe(true);
    expect(phoneRulesTravel([held, { ...held, organizerRole: "organizer" as const }])).toBe(false);
    expect(phoneRulesTravel([{ ...held, organizerState: "stopped" as const }])).toBe(false);
    expect(phoneRulesTravel([])).toBe(false);
  });
});
