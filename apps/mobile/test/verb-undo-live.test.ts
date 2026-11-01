/**
 * THE PHONE'S UNDO PILL ON A REAL WIRE (review the phone half) — the same `bootEngine`
 * composition the app runs, against the loopback mail server. The offer rides the verb's own
 * toast exactly when the engine can build the wire's reversal (`inverseMutations`, read off the
 * PRE-PRESS mirror), and firing it dispatches the inverse through the ordinary seam — measured
 * on the wire, never on a local state hack. The bound and the consumed-once rule are the
 * Screener's: a late or second press dispatches nothing and claims nothing. And ORDER
 * (FIX-022): the second half drives the window the phone measured — Undo pressed while the
 * verb is still behind its paint gate, and Undo pressed while it is on the wire unanswered.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { winningStates } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, UNDO_MS, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

interface SaidToast extends ToastOpts { say: string }

/**
 * THE PILL'S LAYOUT REPORT, in the test's hand. Open by default — one timer task, which is the
 * app's own `paintFirst` — and `hold()` keeps every act spoken after it behind the gate: the
 * verb has said its sentence and not yet dispatched, which is the window the defect lived in.
 */
function paintControl() {
  let waiting: (() => void)[] = [];
  let holding = false;
  return {
    /** Every act spoken from now waits at the gate. */
    hold() { holding = true; },
    /** Acts spoken from now pass again; the ones already waiting stay where they are. */
    open() { holding = false; },
    /** Let the waiting ones through, and open the gate. */
    release() { const w = waiting; waiting = []; holding = false; for (const r of w) r(); },
    painted: (): Promise<void> => new Promise<void>((resolve) => {
      if (!holding) { setTimeout(resolve, 0); return; }
      waiting.push(resolve);
    }),
  };
}

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: SaidToast[] = [];
  /** The controllable clock `undoable`'s bound reads — advanced, never slept. */
  const clock = { skew: 0 };
  const paint = paintControl();
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ?? {}) }),
    uuid,
    zone: "UTC",
    now: () => new Date(Date.now() + clock.skew),
    painted: paint.painted,
  });
  return { fake, ...boot, actions, toasts, clock, paint };
}

/** Every triage state one message's POSTs carried, in the order the server received them. */
const triageFor = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen
    .filter((r) => r.method === "POST" && r.url === `/messages/${id}/triage`)
    .map((r) => (JSON.parse(r.body) as { state: string }).state);

const triagePosts = (fake: ReturnType<typeof mailServer>) => triageFor(fake, "m1");

/** The window an ABSENCE is read over: nothing more may reach the wire in it. Arrivals are waited for. */
const settle = () => new Promise((r) => setTimeout(r, 25));

/** `id`'s `n`th triage POST reached the server; a red names the ones that did. */
const postsArrive = (fake: ReturnType<typeof mailServer>, n: number, what: string, id = "m1") =>
  arrived(what, () => triageFor(fake, id).length >= n, () => `[${triageFor(fake, id).join(", ")}]`);
/** Each mark-read PATCH naming `id`, as "read" or "unread", in the order the server received them. */
const readsFor = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen
    .filter((r) => r.method === "PATCH" && r.url === "/messages")
    .flatMap((r) => { const b = JSON.parse(r.body) as { ids: string[]; unread: boolean };
      return b.ids.includes(id) ? [b.unread ? "unread" : "read"] : []; });

/** One conversation, oldest m1 to newest m4; the reader opens it on m4. */
const ROW = ["m1", "m2", "m3", "m4"];
const convo = (fake: ReturnType<typeof mailServer>, triage?: { state: string }) => ROW.forEach((id, i) =>
  fake.addMessage({ ...dto(id, { date: new Date(Date.UTC(2026, 7, 19, 8, i)).toISOString(), ...(triage ? { triage } : {}) }), threadId: "t1" }));
const undoneSaid = (toasts: SaidToast[]) =>
  arrived("the Undone sentence", () => toasts.some((t) => t.say === Copy.toastUndone), () => `[${toasts.map((t) => t.say).join(" | ")}]`);

describe("the pill's undo drives the engine's inverse on the wire", () => {
  it("Later carries Undo; firing it puts the prior triage state back and says Undone", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    const offer = live.toasts.find((t) => t.say === sayArg({ say: "toastQueued" }));
    expect(offer, "the Later toast is missing").toBeDefined();
    expect(offer!.undo, "the Later toast carries no Undo").toBeDefined();
    expect(offer!.holdMs).toBe(UNDO_MS);
    offer!.undo!();
    await postsArrive(live.fake, 2, "the inverse's POST on the wire");
    await undoneSaid(live.toasts);
    // The inverse is the wire's own: the press filed reply_later, the undo files the PRIOR
    // state (none — the message carried no pile), and the settled sentence is "Undone."
    expect(triagePosts(live.fake)).toEqual(["reply_later", "none"]);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.toastUndone);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("Undo of Later on a row in Earlier sends the open read back, and the row holds it again", async () => {
    const read = "2026-08-19T09:00:00.000Z";
    const live = await scene((f) => f.addMessage({ ...dto("m1", { unread: false }), openReadAt: read }));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    live.toasts.find((t) => t.undo)!.undo!();
    await postsArrive(live.fake, 2, "the inverse's POST on the wire");
    const bodies = live.fake.seen.filter((r) => r.method === "POST" && r.url === "/messages/m1/triage").map((r) => JSON.parse(r.body) as object);
    expect(bodies).toEqual([{ state: "reply_later" }, { state: "none", restoreOpenReadAt: read }]);
    await arrived("the open read back in the mirror", () => live.engine.read().get<{ openReadAt?: string | null }>("message", "m1")?.openReadAt === read,
      () => String(live.engine.read().get<{ openReadAt?: string | null }>("message", "m1")?.openReadAt));
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("Undo of Mark unread on a row in Earlier sends the open read back, and the row holds it again", async () => {
    const read = "2026-08-19T09:00:00.000Z";
    const live = await scene((f) => f.addMessage({ ...dto("m1", { unread: false }), openReadAt: read }));
    expect(await live.actions.markSeen("m1", true)).toBe(true);
    live.toasts.find((t) => t.say === Copy.toastUnread)!.undo!();
    const bodies = () => live.fake.seen.filter((r) => r.method === "PATCH" && r.url === "/messages").map((r) => JSON.parse(r.body) as object);
    await arrived("the inverse's PATCH on the wire", () => bodies().length >= 2, () => JSON.stringify(bodies()));
    expect(bodies().at(-1)).toEqual({ ids: ["m1"], unread: false, restoreOpenReadAt: { m1: read } });
    await live.engine.flushPending();
    await live.engine.syncOnce();
    expect(live.fake.message("m1")?.openReadAt, "the server").toBe(read);
    expect(live.engine.read().get<{ openReadAt?: string | null }>("message", "m1")?.openReadAt, "the mirror, after the drain").toBe(read);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  /**
   * THE SENTENCE IS THE PRESS'S (FIX-026 row 92). Undo took the offer off the screen and put
   * nothing in its place until the inverse had been answered — seconds on a phone. It is said at
   * the press now, and a refused inverse overrides it with the failure sentence. Mutations: the
   * synchronous toast removed (the first case), `saidAll`'s `failed` turned to a silent null (the
   * second).
   */
  it("Undo says Undone at the press, before the inverse is answered", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    await postsArrive(live.fake, 1, "control: the verb reached the wire");
    const offer = live.toasts.find((t) => t.undo)!;
    const before = live.toasts.length;
    offer.undo!();
    expect(live.toasts.slice(before).map((t) => t.say), "nothing was said at the press").toEqual([Copy.toastUndone]);
    await postsArrive(live.fake, 2, "control: the inverse reached the wire");
    expect(triagePosts(live.fake)).toEqual(["reply_later", "none"]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("a refused inverse overrides the press's Undone with the failure sentence", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    await postsArrive(live.fake, 1, "control: the verb reached the wire");
    live.fake.failNext("POST", "/messages/m1/triage");
    live.toasts.find((t) => t.undo)!.undo!();
    expect(live.toasts.at(-1)?.say).toBe(Copy.toastUndone);
    await arrived("the failure sentence", () => live.toasts.at(-1)?.say === Copy.liveSaveFailed,
      () => `[${live.toasts.map((t) => t.say).join(" | ")}]`);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("consumed at most once, dead past UNDO_MS — a late or second press dispatches nothing", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    await live.actions.pileToggle("m1", "replyLater");
    const first = live.toasts.find((t) => t.undo)!;
    first.undo!();
    first.undo!();
    await postsArrive(live.fake, 2, "the inverse's POST on the wire");
    await undoneSaid(live.toasts);
    await settle(); // the window a SECOND inverse would reach the wire in
    expect(triagePosts(live.fake)).toEqual(["reply_later", "none"]);

    // A fresh press, then the clock walks past the window: the offer is dead.
    await live.actions.pileToggle("m1", "setAside");
    const second = live.toasts.filter((t) => t.undo).at(-1)!;
    live.clock.skew = UNDO_MS + 1;
    second.undo!();
    await settle();
    expect(triagePosts(live.fake)).toEqual(["reply_later", "none", "set_aside"]);
    expect(live.toasts.map((t) => t.say).filter((s) => s === Copy.toastUndone)).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("a press that changes nothing offers no Undo — mark-unread over an unread message", async () => {
    const live = await scene((f) => f.addMessage(dto("m1", { unread: true })));
    expect(await live.actions.markSeen("m1", true)).toBe(true);
    const said = live.toasts.find((t) => t.say === Copy.toastUnread);
    expect(said).toBeDefined();
    expect(said!.undo).toBeUndefined();

    // The flip the press DOES make carries the way back, and firing it flips it on the wire.
    await live.actions.markSeen("m1", false);
    const offer = live.toasts.find((t) => t.say === Copy.toastRead);
    expect(offer!.undo).toBeDefined();
    offer!.undo!();
    const patches = () => live.fake.seen
      .filter((r) => r.method === "PATCH" && r.url === "/messages")
      .map((r) => (JSON.parse(r.body) as { unread: boolean }).unread);
    await arrived("the inverse's PATCH on the wire", () => patches().length >= 3, () => `[${patches().join(", ")}]`);
    // Three writes: the no-flip press still dispatches (the server may know more than this
    // mirror — only the UNDO is withheld), then the read, then its inverse.
    expect(patches()).toEqual([true, false, true]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("the held window's commit is quiet — the pill already said Moved to Trash", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    expect(await live.actions.deleteMessage("m1", { quiet: true })).toBe(true);
    expect(live.toasts.map((t) => t.say)).not.toContain(Copy.toastDeleted);
    // The refusal path still speaks whatever `quiet` says — the sentence is the honest screen.
    live.fake.addMessage(dto("m2"));
    await live.engine.syncOnce();
    live.fake.failNext("DELETE", "/messages/m2");
    expect(await live.actions.deleteMessage("m2", { quiet: true })).toBe(false);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.deleteFailed);
    live.store.close();
    live.fake.server.close();
  });
});

/**
 * ORDER IS A CONTRACT PER MESSAGE. Measured twice on the iPhone 18 Pro (2026-09-21): a Park's
 * POST left 3–8 s after the tap, an Undo pressed in that window reached the server 4.2 s and
 * 3.8 s BEFORE it, the server applied inverse then verb, and the message stayed filed while the
 * person read "Undone.". These four arms drive both halves of the window against the real wire.
 */
describe("a verb and its Undo, in the order the person pressed them", () => {
  it("Undo inside the paint gate sends NOTHING — the verb never leaves the device", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    live.paint.hold();
    const press = live.actions.pileToggle("m1", "setAside");
    await settle();
    // Spoken, and not one byte on the wire: this is the window the phone measured at 3–8 s.
    const offer = live.toasts.find((t) => t.undo);
    expect(offer, "the Park toast is missing").toBeDefined();
    expect(triagePosts(live.fake)).toEqual([]);

    offer!.undo!();
    live.paint.release();
    expect(await press).toBe(true);
    await settle();
    expect(triagePosts(live.fake), "a cancelled verb still reached the server").toEqual([]);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.toastUndone);
    // Nothing was applied either — `mutate` was never called, so the row is where it was.
    expect(winningStates(live.engine.read()).get("m1")?.state ?? null).toBeNull();
    live.store.close();
    live.fake.server.close();
  });

  it("Undo after the verb left rides behind it — the inverse follows the verb's answer", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    const answerVerb = live.fake.holdNext("POST", "/messages/m1/triage");
    const press = live.actions.pileToggle("m1", "setAside");
    await postsArrive(live.fake, 1, "the verb's POST on the wire");
    expect(triagePosts(live.fake), "the verb has not left yet").toEqual(["set_aside"]);

    live.toasts.find((t) => t.undo)!.undo!();
    await settle();
    expect(triagePosts(live.fake), "the inverse passed the verb it undoes").toEqual(["set_aside"]);

    answerVerb();
    expect(await press).toBe(true);
    await postsArrive(live.fake, 2, "the inverse's POST behind the verb's answer");
    await undoneSaid(live.toasts);
    expect(triagePosts(live.fake)).toEqual(["set_aside", "none"]);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.toastUndone);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  /**
   * The key is PER MESSAGE, and this is the arm that reads it. The engine serializes every
   * dispatch it has been handed (`engine.ts#outboxGate`), so nothing downstream of `mutate`
   * can tell one chain from three; what it cannot serialize is the window BEFORE `mutate`,
   * which is where this defect lived and where the pill's gate stands for 3–8 s on a busy
   * thread. One global chain here would put every other message's press behind that window.
   */
  it("the chains are per message — one act at its pill holds nobody else's press", async () => {
    const live = await scene((f) => { f.addMessage(dto("m1")); f.addMessage(dto("m2")); f.addMessage(dto("m3")); });
    live.paint.hold();
    // Each press speaks its sentence synchronously, so the offer read here is that press's own.
    const first = live.actions.pileToggle("m1", "setAside");
    const offerOne = live.toasts.find((t) => t.undo)!;
    live.paint.open();
    const rest = Promise.all([live.actions.pileToggle("m2", "setAside"), live.actions.pileToggle("m3", "setAside")]);
    await postsArrive(live.fake, 1, "m2's POST past m1's pill", "m2");
    await postsArrive(live.fake, 1, "m3's POST past m1's pill", "m3");
    expect(triageFor(live.fake, "m1"), "m1 left while it was still behind its pill").toEqual([]);
    expect(triageFor(live.fake, "m2"), "m2 waited behind another message's pill").toEqual(["set_aside"]);
    expect(triageFor(live.fake, "m3"), "m3 waited behind another message's pill").toEqual(["set_aside"]);
    expect(await rest).toEqual([true, true]);

    // And m1's Undo, pressed at the gate, takes m1's verb back and touches neither of the others.
    offerOne.undo!();
    live.paint.release();
    expect(await first).toBe(true);
    await settle();
    expect(triageFor(live.fake, "m1")).toEqual([]);
    expect(triageFor(live.fake, "m2")).toEqual(["set_aside"]);
    expect(triageFor(live.fake, "m3")).toEqual(["set_aside"]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("a refused verb settles its slot — the next act for that message still goes", async () => {
    const live = await scene((f) => f.addMessage(dto("m1")));
    live.fake.failNextStatus("POST", "/messages/m1/triage", 500);
    await live.actions.pileToggle("m1", "setAside");
    // A chain that kept the refused slot would strand every later verb on this message.
    await live.actions.pileToggle("m1", "replyLater");
    expect(triagePosts(live.fake)).toEqual(["set_aside", "reply_later"]);
    live.store.close();
    live.fake.server.close();
  });

  /**
   * A CONVERSATION'S PRESS WRITES EVERY LETTER. Tester C, android 0.30.13: Park on an open
   * conversation, Undo at +1–3 s, and the letters the press had not written yet stayed parked —
   * their Undo reached the server before their Park.
   */
  it("Undo while a letter's write is on the wire: sent letters go back behind their answers, the rest never leave", async () => {
    const live = await scene((f) => convo(f));
    const answer = live.fake.holdNext("POST", "/messages/m3/triage");
    const press = live.actions.pileToggle("m4", "setAside");
    await postsArrive(live.fake, 1, "m3's write on the wire", "m3");
    live.toasts.find((t) => t.undo)!.undo!();
    await settle();
    expect(triageFor(live.fake, "m3"), "m3's inverse passed its own write").toEqual(["set_aside"]);
    answer();
    expect(await press).toBe(true);
    await postsArrive(live.fake, 2, "m3's inverse", "m3");
    await postsArrive(live.fake, 2, "m4's inverse", "m4");
    await settle();
    expect(ROW.map((id) => triageFor(live.fake, id))).toEqual([[], [], ["set_aside", "none"], ["set_aside", "none"]]);
    expect(ROW.map((id) => winningStates(live.engine.read()).get(id)?.state ?? "none")).toEqual(["none", "none", "none", "none"]);
    expect(live.toasts.map((t) => t.say)).toContain(Copy.toastUndone);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("a letter's own press made while its conversation's press waits lands after it", async () => {
    const live = await scene((f) => convo(f));
    live.paint.hold();
    const park = live.actions.pileToggle("m4", "setAside");
    const later = live.actions.setPile("m2", "replyLater");
    await settle();
    live.paint.release();
    await Promise.all([park, later]);
    await settle();
    expect(triageFor(live.fake, "m2")).toEqual(["set_aside", "reply_later"]);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("Mark unread pressed while the conversation's Done waits lands after Done's read", async () => {
    const live = await scene((f) => convo(f, { state: "resurfaced" }));
    live.paint.hold();
    const done = live.actions.resurfaceDone("m4");
    const unread = live.actions.markSeen("m4", true, ROW);
    await settle();
    live.paint.release();
    await Promise.all([done, unread]);
    await settle();
    expect(readsFor(live.fake, "m2").at(-1)).toBe("unread");
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);
});

/**
 * THE READER'S GLANCE NEVER HOLDS A PRESS. The read it saves over the open conversation's unread
 * letters is the app's own act: a press made while it is unanswered paints at once and lands after it.
 */
describe("a press made while the reader's glance is on the wire", () => {
  /** The glance's PATCH held unanswered; `failed`: its answer, when released, is a 500 and the server took nothing. */
  const glanceHeld = async (ids: string[], failed = false) => {
    const live = await scene((f) => convo(f));
    if (failed) live.fake.failNextStatus("PATCH", "/messages", 500);
    const sockets: Array<{ destroy: () => void }> = [];
    live.fake.server.prependListener("request", (req: IncomingMessage) => { if (req.method === "PATCH") sockets.push(req.socket); });
    const answer = live.fake.holdNext("PATCH", "/messages");
    const glance = live.actions.markGlanced(ids);
    await arrived("the glance's PATCH", () => readsFor(live.fake, ids[0]!).length > 0);
    /** The connection drops after the server took the glance: its answer never arrives. */
    const drop = () => sockets[0]!.destroy();
    return { live, answer, glance, drop };
  };
  const stateOf = (live: Awaited<ReturnType<typeof scene>>, id: string) => winningStates(live.engine.read()).get(id)?.state;
  const unreadOf = (live: Awaited<ReturnType<typeof scene>>, id: string) => live.engine.read().get<{ unread: boolean }>("message", id)?.unread;
  /** A press that waits for the glance's answer never paints here: the answer is held. */
  const paintsWithin50 = async (what: string, holds: () => boolean) => {
    const deadline = Date.now() + 50;
    while (!holds()) {
      if (Date.now() >= deadline) throw new Error(`${what} did not paint within 50 ms of the press`);
      await new Promise((r) => setTimeout(r, 1));
    }
  };

  for (const ids of [["m4", "m3", "m2"], ["m4"]]) {
    it(`Park paints at the press during a glance over ${ids.length} letter(s), and every letter is parked`, async () => {
      const { live, answer, glance } = await glanceHeld(ids);
      const park = live.actions.pileToggle("m4", "setAside");
      await paintsWithin50("Park", () => stateOf(live, "m4") === "set_aside");
      answer();
      expect(await Promise.all([glance, park])).toEqual([true, true]);
      expect(ROW.map((id) => triageFor(live.fake, id))).toEqual(ROW.map(() => ["set_aside"]));
      expect(ids.map((id) => live.fake.message(id)?.unread)).toEqual(ids.map(() => false));
      live.store.close();
      live.fake.server.close();
    }, CASE_MS);
  }

  it("Later and Mark unread paint at the press, and the glance never overwrites the Mark unread", async () => {
    const { live, answer, glance } = await glanceHeld(["m4", "m3", "m2"]);
    const later = live.actions.setPile("m2", "replyLater");
    await paintsWithin50("Later", () => stateOf(live, "m2") === "reply_later");
    const unread = live.actions.markSeen("m4", true);
    await paintsWithin50("Mark unread", () => unreadOf(live, "m4") === true);
    answer();
    expect(await Promise.all([glance, later, unread])).toEqual([true, true, true]);
    expect(triageFor(live.fake, "m2")).toEqual(["reply_later"]);
    expect(readsFor(live.fake, "m4")).toEqual(["read", "unread"]);
    expect(live.fake.message("m4")?.unread, "the glance's read stands over the later Mark unread").toBe(true);
    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  /** After the Mark unread pressed meanwhile: the screen stays unread, and once the glance has gone
   *  again the wire, the server and the mirror end unread, the glance's other letters read. */
  const unreadWins = async (live: Awaited<ReturnType<typeof scene>>, others: readonly string[]) => {
    expect(unreadOf(live, "m4"), "the glance waiting to go again paints the letter read over the Mark unread").toBe(true);
    await live.engine.flushPending();
    await settle();
    expect(readsFor(live.fake, "m4").at(-1), "the glance's read went again after the Mark unread").toBe("unread");
    expect(live.fake.message("m4")?.unread, "the glance's read stands on the server over the Mark unread").toBe(true);
    expect(unreadOf(live, "m4"), "the glance's read stands in the mirror over the Mark unread").toBe(true);
    expect(others.map((id) => live.fake.message(id)?.unread), "a letter only the glance named was left unread").toEqual(others.map(() => false));
    live.store.close();
    live.fake.server.close();
  };

  /**
   * THE GLANCE THAT HAS TO GO AGAIN — answered 500, or its connection dropped after the server took
   * it. It is sent again after the Mark unread made meanwhile, without the letter marked unread.
   */
  for (const ids of [["m4"], ["m4", "m3", "m2"]]) {
    for (const how of ["answered 500", "dropped"] as const) {
      it(`a glance over ${ids.length} letter(s) ${how} never overwrites a Mark unread made meanwhile`, async () => {
        const { live, answer, glance, drop } = await glanceHeld(ids, how === "answered 500");
        const unread = live.actions.markSeen("m4", true);
        await paintsWithin50("Mark unread", () => unreadOf(live, "m4") === true);
        if (how === "dropped") drop(); else answer();
        expect(await Promise.all([glance, unread])).toEqual([true, true]);
        await unreadWins(live, ids.slice(1));
      }, CASE_MS);
    }
  }

  it("a glance still waiting behind another write and answered 500 never overwrites a Mark unread made meanwhile", async () => {
    const live = await scene((f) => { convo(f); f.addMessage(dto("x1")); });
    const answerPark = live.fake.holdNext("POST", "/messages/x1/triage");
    const park = live.actions.pileToggle("x1", "setAside");
    await postsArrive(live.fake, 1, "x1's Park on the wire", "x1");
    live.fake.failNextStatus("PATCH", "/messages", 500);
    const glance = live.actions.markGlanced(["m4", "m3", "m2"]);
    await settle();
    expect(readsFor(live.fake, "m4"), "control: the glance waits behind the Park").toEqual([]);
    const unread = live.actions.markSeen("m4", true);
    await paintsWithin50("Mark unread", () => unreadOf(live, "m4") === true);
    answerPark();
    expect(await Promise.all([park, glance, unread])).toEqual([true, true, true]);
    await unreadWins(live, ["m3", "m2"]);
    expect(readsFor(live.fake, "m4"), "the waiting glance still sent the letter marked unread").toEqual(["unread"]);
  }, CASE_MS);
});
