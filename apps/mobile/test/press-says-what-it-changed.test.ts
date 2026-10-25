/**
 * A PRESS SAYS THE CHANGE IT MADE. Two rows of that change, over the real engine and wire:
 * PHONE-OWN-FACED-ROW-TOGGLE-READS-THE-OWN-REPLY — Later on a conversation faced by the person's own
 * reply took its direction from that reply while writing the others, so it said "Out of Answer Later"
 * over mail it did not change; and PHONE-RULE-BRANCH-UNDO-SAYS-NOTHING-TO-UNDO — a Move a later press
 * about the sender replaced said there was nothing to undo while its letter stayed where it moved.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type EngineMessage, type RuleDTO } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, openRoutingSession } from "../src/state/held-routing";
import { liveActions, liveMessage, planHeldRouting, routingReversal, type LiveDeps, type ToastOpts, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

const SENDER = { name: "Test Sender", address: "sender@fake.test" };
const ME = { name: "Me", address: "owner@fake.test" };
const QUEUED = "Queued in Answer Later";
const UNQUEUED = "Out of Answer Later";
const BACK_REPLACED = "The mail is back where it was. A later choice for this sender decides where their mail goes.";
const NOTHING = "A later choice for this sender replaced this one, so there is nothing to undo here.";

type Said = { say: string; opts?: ToastOpts };

async function scene(rules: RuleDTO[], messages: ReturnType<typeof dto>[], extra: Partial<LiveDeps> = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  for (const m of messages) fake.addMessage(m);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: Said[] = [];
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC",
    toast: (m, o) => { said.push({ say: sayArg(m), ...(o ? { opts: o } : {}) }); },
    ...extra,
  });
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, ...boot, actions, said, close };
}
type Scene = Awaited<ReturnType<typeof scene>>;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`never happened: ${what}`);
    await tick(10);
  }
}
const writes = (s: Scene) => s.fake.seen.filter((r) => r.method !== "GET" && r.url.startsWith("/messages"));
const triaged = (s: Scene, from: number) =>
  writes(s).slice(from).filter((r) => r.url.endsWith("/triage")).map((r) => `${r.url.split("/")[2]}:${JSON.parse(r.body).state}`);

afterEach(() => { closeRoutingSession(); resetLocaleRegisterForTests(); });

describe("Later on a conversation faced by my own reply", () => {
  /* m1 is their letter; m2 is my reply, the row's face, and it already sits in Answer Later. */
  const answered = (theirs: string | null, mine: string | null, extra: ReturnType<typeof dto>[] = []) => [
    { ...dto("m1", { subject: "Weekly", from: SENDER, triage: theirs ? { state: theirs } : null }), threadId: "t1" },
    { ...dto("m2", { subject: "Re: Weekly", folder: "Sent", unread: false, from: ME, date: "2026-08-19T09:00:00Z", triage: mine ? { state: mine } : null }), threadId: "t1" },
    ...extra,
  ];

  it("queues their letter and says Queued, whatever my reply holds", async () => {
    const s = await scene([], answered(null, "reply_later"));
    try {
      const before = writes(s).length; const said = s.said.length;
      expect(await s.actions.pileToggle("m2", "replyLater", ["m2", "m1"])).toBe(true);
      await until("the triage on the wire", () => triaged(s, before).length > 0);
      await tick(100);
      expect(s.said.slice(said).map((x) => x.say), "the toggle read my reply's state").toEqual([QUEUED]);
      expect(triaged(s, before)).toEqual(["m1:reply_later"]);
    } finally { s.close(); }
  });

  it("takes them out only when every one of theirs is queued, and says so", async () => {
    const s = await scene([], answered("reply_later", null));
    try {
      const before = writes(s).length; const said = s.said.length;
      await s.actions.pileToggle("m2", "replyLater", ["m2", "m1"]);
      await until("the triage on the wire", () => triaged(s, before).length > 0);
      await tick(100);
      expect(s.said.slice(said).map((x) => x.say)).toEqual([UNQUEUED]);
      expect(triaged(s, before)).toEqual(["m1:none"]);
    } finally { s.close(); }
  });

  it("with some of theirs queued, queues the rest of the row, my reply too, and leaves the queued ones alone", async () => {
    const third = { ...dto("m3", { subject: "Re: Weekly", from: SENDER, date: "2026-08-19T10:00:00Z" }), threadId: "t1" };
    const s = await scene([], answered("reply_later", null, [third]));
    try {
      const before = writes(s).length; const said = s.said.length;
      await s.actions.pileToggle("m2", "replyLater", ["m2", "m1", "m3"]);
      await until("both on the wire", () => triaged(s, before).length >= 2);
      await tick(100);
      expect(s.said.slice(said).map((x) => x.say)).toEqual([QUEUED]);
      expect(triaged(s, before).sort()).toEqual(["m2:reply_later", "m3:reply_later"]);
    } finally { s.close(); }
  });

  it("holds the slot of the letter it writes, so a press on that letter waits behind it", async () => {
    let paint: () => void = () => undefined;
    const gate = new Promise<void>((r) => { paint = r; });
    const s = await scene([], answered(null, null), { painted: () => gate });
    try {
      /* The order the engine is HANDED the two writes — the wire batches a read, so it cannot say. */
      const handed: string[] = [];
      const mutate = s.engine.mutate.bind(s.engine);
      s.engine.mutate = ((m: Parameters<typeof mutate>[0], o?: Parameters<typeof mutate>[1]) => {
        handed.push(m.kind);
        return mutate(m, o);
      }) as typeof s.engine.mutate;
      void s.actions.pileToggle("m2", "replyLater", ["m2", "m1"]);
      void s.actions.markSeen("m1", false);
      await tick(50);
      paint();
      await until("all handed to the engine", () => handed.length >= 3);
      // The toggle files the row whole, the letter and my reply, before the read on the letter.
      expect(handed, "a later press on the letter overtook the toggle that writes it").toEqual(["triage_set", "triage_set", "mark_seen"]);
    } finally { s.close(); }
  });

  it("an unfolded row is unchanged: its own state decides (control)", async () => {
    const s = await scene([], [dto("m1", { subject: "Weekly", from: SENDER, triage: { state: "reply_later" } })]);
    try {
      const said = s.said.length;
      await s.actions.pileToggle("m1", "replyLater");
      expect(s.said.slice(said).map((x) => x.say)).toEqual([UNQUEUED]);
    } finally { s.close(); }
  });
});

/** The window as the app opens it (`world.tsx`), at a length the test can outwait. */
function windowOver(s: Scene, windowMs: number): void {
  openRoutingSession({
    windowMs,
    journal: s.store,
    plan: (i) => planHeldRouting(s.engine.read(), i),
    dispatch: async (ms) => {
      const answers = await Promise.all(ms.map((m) => s.engine.mutate(m).catch(() => null)));
      return !answers.some((r) => r === null || r.status === "rolled_back");
    },
    reverse: (ms, i) => (i.v === 2 ? null : routingReversal(() => s.engine.read(), ms)),
  });
}
const row = (s: Scene, id: string) => {
  const m = liveMessage(s.engine, id, view);
  if (!m) throw new Error(`no row for ${id}`);
  return m;
};
const offer = (s: Scene): Said => {
  const o = [...s.said].reverse().find((x) => x.opts?.undo);
  expect(o, `no Undo was offered: [${s.said.map((x) => x.say).join(" | ")}]`).toBeTruthy();
  return o!;
};
const folderOf = (s: Scene, id: string) => s.engine.read().get<EngineMessage>("message", id)?.folder;
const ruleWrites = (s: Scene) => s.fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET");

describe("Undo on a Move a later press about the sender replaced", () => {
  const two = () => [dto("m1", { subject: "One", from: SENDER }), dto("m2", { subject: "Two", from: SENDER })];

  it("moves its letter back and says the later choice stands; the later rule is still made", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], two());
    try {
      windowOver(s, 400);
      expect(await s.actions.move(row(s, "m1"), "reads")).toBe(true);
      const first = offer(s);
      expect(await s.actions.move(row(s, "m2"), "receipts")).toBe(true);
      first.opts!.undo!();
      expect(s.said.at(-1)!.say).toBe(BACK_REPLACED);
      await until("the letter back in INBOX", () => folderOf(s, "m1") === "INBOX");
      await until("the later press's rule on the wire", () => ruleWrites(s).length > 0);
      expect(ruleWrites(s).some((r) => r.body.includes("ohmail/Receipts")), "the later press's rule was lost").toBe(true);
      expect(folderOf(s, "m2"), "the later press's letter moved back too").not.toBe("INBOX");
    } finally { s.close(); }
  });

  /* LOW-3: the letter's way back waits behind a press on it still in its slot. */
  it("the way back is handed to the engine in the letter's order", async () => {
    let paint: () => void = () => undefined;
    const gate = new Promise<void>((r) => { paint = r; });
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], two(), { painted: () => gate });
    try {
      windowOver(s, 400);
      await s.actions.move(row(s, "m1"), "reads");
      const first = offer(s);
      await s.actions.move(row(s, "m2"), "receipts");
      const handed: string[] = [];
      const mutate = s.engine.mutate.bind(s.engine);
      s.engine.mutate = ((m: Parameters<typeof mutate>[0], o?: Parameters<typeof mutate>[1]) => {
        if ("messageId" in m && m.messageId === "m1") handed.push(m.kind);
        return mutate(m, o);
      }) as typeof s.engine.mutate;
      void s.actions.pileToggle("m1", "setAside");
      first.opts!.undo!();
      await tick(50);
      paint();
      await until("both handed to the engine", () => handed.length >= 2);
      expect(handed.slice(0, 2), "the way back overtook a press on the letter still in its slot").toEqual(["triage_set", "move"]);
    } finally { s.close(); }
  });

  it("a letter moved on since is left where it is, and there is nothing to undo", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], two());
    try {
      windowOver(s, 400);
      await s.actions.move(row(s, "m1"), "reads");
      const first = offer(s);
      await s.actions.move(row(s, "m2"), "receipts");
      /* The letter moved on after the press, by another door: its way back is no longer this press's. */
      await s.engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/Receipts" });
      const moved = folderOf(s, "m1");
      expect(moved, "the premise: the letter moved on").toBe("ohmail/Receipts");
      first.opts!.undo!();
      expect(s.said.at(-1)!.say).toBe(NOTHING);
      await tick(200);
      expect(folderOf(s, "m1"), "the replaced press's Undo undid the later press's letter").toBe(moved);
    } finally { s.close(); }
  });
});
