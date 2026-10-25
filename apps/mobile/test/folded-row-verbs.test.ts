/**
 * A FOLDED ROW'S VERBS ACT ON ALL ITS MEMBERS (PHONE-FOLDED-ROW-VERBS). An Ohbox row stands for a
 * whole conversation; its swipe verbs acted on the open target alone, where the web's pick of a
 * row is every member. Each verb now takes `memberIds`, sends one mutation per member, says once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { type EngineMessage, type RuleDTO } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, flushRouting, openRoutingSession } from "../src/state/held-routing";
import { liveActions, liveMessage, liveOhbox, livePiles, planHeldRouting, routingReversal, type ToastOpts, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

const SENDER = { name: "Test Sender", address: "sender@fake.test" };
const DECIDES = "News — 1 message from Test Sender moved. Future mail from them files there too. The rest of their mail here stays where it is.";
const DECIDES_DE = "News — 1 Nachricht von Test Sender verschoben. Künftige Mails von ihm landen auch dort. Seine übrigen Mails hier bleiben, wo sie sind.";
const BACK = "The mail is back where it was, and no rule was made.";

type Said = { say: string; opts?: ToastOpts & { shown?: () => void } };

async function scene(rules: RuleDTO[], messages = [dto("m1", { subject: "Weekly", from: SENDER })]) {
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
  });
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, origin, ...boot, actions, said, close };
}

type Scene = Awaited<ReturnType<typeof scene>>;

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

const row = (s: Scene, id = "m1") => {
  const m = liveMessage(s.engine, id, view);
  if (!m) throw new Error(`no row for ${id}`);
  return m;
};
const ruleWrites = (s: Scene) => s.fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET");
const offer = (s: Scene): Said => {
  const o = [...s.said].reverse().find((x) => x.opts?.undo);
  expect(o, `no Undo was offered: [${s.said.map((x) => x.say).join(" | ")}]`).toBeTruthy();
  return o!;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`never happened: ${what}`);
    await tick(10);
  }
}

afterEach(() => { closeRoutingSession(); resetLocaleRegisterForTests(); });

const writes = (s: Scene) => s.fake.seen.filter((r) => r.method !== "GET" && r.url.startsWith("/messages"));
const pills = (s: Scene, from: number) => s.said.slice(from).map((x) => x.say);
const convo = () => [
  dto("m1", { subject: "Weekly", from: SENDER }),
  dto("m2", { subject: "Re: Weekly", from: { name: "Other", address: "other@fake.test" } }),
];

describe("a folded row's verbs", () => {
  it("Later files every member, with one sentence", async () => {
    const s = await scene([], convo());
    try {
      const before = writes(s).length; const said = s.said.length;
      expect(await s.actions.pileToggle("m1", "replyLater", ["m1", "m2"])).toBe(true);
      await until("both members on the wire", () => writes(s).length - before >= 2);
      const bodies = writes(s).slice(before).map((r) => r.url);
      expect(bodies.some((u) => u.includes("/m1/")), "the open target").toBe(true);
      expect(bodies.some((u) => u.includes("/m2/")), "the other member").toBe(true);
      expect(pills(s, said)).toHaveLength(1);
    } finally { s.close(); }
  });

  it("the read slot marks every member in one write", async () => {
    const s = await scene([], convo());
    try {
      const before = writes(s).length;
      expect(await s.actions.markSeen("m1", false, ["m1", "m2"])).toBe(true);
      await until("the read on the wire", () => writes(s).length > before);
      const w = writes(s).slice(before);
      expect(w.map((r) => r.body).join(" ")).toContain("m2");
    } finally { s.close(); }
  });

  it("Junk moves every member, the rule being the open letter's sender's", async () => {
    const s = await scene([], convo());
    try {
      const before = writes(s).length; const said = s.said.length;
      expect(await s.actions.move(row(s, "m1"), "spam", ["m1", "m2"])).toBe(true);
      await until("both moves on the wire", () => writes(s).slice(before).filter((r) => r.url.endsWith("/move")).length >= 2);
      expect(pills(s, said)).toHaveLength(1);
    } finally { s.close(); }
  });

  it("an unfolded row is the open target alone", async () => {
    const s = await scene([], convo());
    try {
      const before = writes(s).length;
      await s.actions.pileToggle("m1", "replyLater");
      await until("the write", () => writes(s).length > before);
      await tick(100);
      expect(writes(s).slice(before).every((r) => !r.url.includes("/m2/"))).toBe(true);
    } finally { s.close(); }
  });
});

/* REVIEW-026-PHONE-SAYS-EVERY-PRESS-2 HIGH-1: a conversation answered from here holds the person's
   OWN reply (the Ohbox carries own Sent mail). Junk, Done and Mark unread never touch it (an unread
   reply would make the row stand for it); the read slot's Mark read marks every member, as the web's
   pick of a row does. Later, like Park, takes the row whole, the reply too, so the row leaves. */
describe("a folded row that holds the person's own reply", () => {
  const ME = { name: "Me", address: "owner@fake.test" };
  const answered = (faceIsMine: boolean) => [
    { ...dto("m1", { subject: "Weekly", from: SENDER, unread: !faceIsMine, date: "2026-08-19T08:00:00Z" }), threadId: "t1" },
    { ...dto("m2", { subject: "Re: Weekly", folder: "Sent", unread: false, from: ME, date: "2026-08-19T09:00:00Z" }), threadId: "t1" },
  ];
  const moved = (s: Scene, before: number) => writes(s).slice(before).filter((r) => r.url.endsWith("/move")).map((r) => r.url);
  for (const faceIsMine of [false, true]) {
    it(`Junk moves their mail and never mine — ${faceIsMine ? "faced by my reply" : "faced by their letter"}`, async () => {
      const s = await scene([], answered(faceIsMine));
      try {
        const box = liveOhbox(s.engine.read(), view);
        const folded = [...box.resurfaced, ...box.fresh, ...box.seen].find((r) => (r.memberIds ?? []).length > 1);
        expect(folded, "the conversation did not fold").toBeTruthy();
        const before = writes(s).length;
        await s.actions.move(row(s, folded!.id), "spam", folded!.memberIds);
        await tick(300);
        expect(moved(s, before)).toEqual(["/messages/m1/move"]);
        expect(ruleWrites(s).every((r) => !r.body.includes(ME.address)), "a rule for my own address").toBe(true);
      } finally { s.close(); }
    });
  }
  it("Later takes my reply with the letter, so the row leaves", async () => {
    const s = await scene([], answered(false));
    try {
      const before = writes(s).length;
      await s.actions.pileToggle("m1", "replyLater", ["m1", "m2"]);
      await until("both on the wire", () => writes(s).length - before >= 2);
      expect(writes(s).slice(before).map((r) => r.url).sort()).toEqual(["/messages/m1/triage", "/messages/m2/triage"]);
      const box = liveOhbox(s.engine.read(), view);
      expect([...box.resurfaced, ...box.fresh, ...box.seen], "the row left the Ohbox").toEqual([]);
    } finally { s.close(); }
  });
  it("Done and Mark unread leave my reply alone; the read slot's Mark read marks it with the rest", async () => {
    const s = await scene([], answered(false));
    try {
      let before = writes(s).length;
      await s.actions.resurfaceDone("m1", ["m1", "m2"]);
      await until("the done on the wire", () => writes(s).length > before);
      await tick(100);
      expect(writes(s).slice(before).map((r) => r.body).join(" "), "Done touched my reply").not.toContain("m2");
      before = writes(s).length;
      await s.actions.markSeen("m1", true, ["m1", "m2"]);
      await until("the unread on the wire", () => writes(s).length > before);
      expect(writes(s).slice(before).map((r) => r.body).join(" "), "Mark unread touched my reply").not.toContain("m2");
      before = writes(s).length;
      await s.actions.markSeen("m1", false, ["m1", "m2"]);
      await until("the read on the wire", () => writes(s).length > before);
      expect(writes(s).slice(before).map((r) => r.body).join(" ")).toContain("m2");
    } finally { s.close(); }
  });
  it("a sender among the account's own addresses is own mail too, in any folder", async () => {
    const s = await scene([], [
      { ...dto("m1", { subject: "Weekly", from: SENDER }), threadId: "t1" },
      { ...dto("m2", { subject: "Re: Weekly", from: ME, unread: false }), threadId: "t1" },
    ]);
    try {
      const own = liveActions({ engine: s.engine, uuid: deps.uuid, zone: "UTC", toast: () => undefined, ownAddresses: () => [ME.address] });
      const before = writes(s).length;
      await own.move(row(s, "m1"), "spam", ["m1", "m2"]);
      await tick(300);
      expect(moved(s, before)).toEqual(["/messages/m1/move"]);
    } finally { s.close(); }
  });
});

/* Park on one member left the rest standing as the same Ohbox row. The reader's Park names no
   members; it takes the row its message stands in. */
describe("Park on a message of a folded Ohbox row", () => {
  const OTHER = { name: "Other", address: "other@fake.test" };
  const ME = { name: "Me", address: "owner@fake.test" };
  const scenePark = () => scene([], [
    { ...dto("m1", { subject: "Weekly", from: SENDER, date: "2026-08-19T08:00:00Z" }), threadId: "t1" },
    { ...dto("m2", { subject: "Re: Weekly", from: OTHER, date: "2026-08-19T09:00:00Z" }), threadId: "t1" },
    { ...dto("m9", { subject: "Garden", from: OTHER, date: "2026-08-18T08:00:00Z" }), threadId: "t9" },
  ]);
  const triaged = (s: Scene, before: number) => writes(s).slice(before)
    .filter((r) => r.url.endsWith("/triage")).map((r) => `${r.url.split("/")[2]} ${(JSON.parse(r.body) as { state: string }).state}`).sort();

  it("parks every Ohbox member with one sentence, and its Undo brings both back", async () => {
    const s = await scenePark();
    try {
      const before = writes(s).length; const said = s.said.length;
      expect(await s.actions.pileToggle("m2", "setAside")).toBe(true);
      await until("both parks on the wire", () => triaged(s, before).length >= 2);
      expect(triaged(s, before)).toEqual(["m1 set_aside", "m2 set_aside"]);
      expect(pills(s, said)).toHaveLength(1);
      const box = liveOhbox(s.engine.read(), view);
      expect([...box.fresh, ...box.seen].map((r) => r.id), "the row left the Ohbox").toEqual(["m9"]);
      offer(s).opts!.undo!();
      await until("both back on the wire", () => triaged(s, before).length >= 4);
      expect(triaged(s, before).filter((x) => x.endsWith(" none"))).toEqual(["m1 none", "m2 none"]);
    } finally { s.close(); }
  });

  it("an answered conversation: my reply parks with the letters, so the row leaves; Undo brings all three back", async () => {
    const s = await scene([], [
      { ...dto("m1", { subject: "Weekly", from: SENDER, date: "2026-08-19T08:00:00Z" }), threadId: "t1" },
      { ...dto("m3", { subject: "Re: Weekly", folder: "Sent", unread: false, from: ME, date: "2026-08-19T08:30:00Z" }), threadId: "t1" },
      { ...dto("m2", { subject: "Re: Weekly", from: OTHER, date: "2026-08-19T09:00:00Z" }), threadId: "t1" },
      { ...dto("m9", { subject: "Garden", from: OTHER, date: "2026-08-18T08:00:00Z" }), threadId: "t9" },
    ]);
    try {
      const before = writes(s).length;
      expect(await s.actions.pileToggle("m2", "setAside")).toBe(true);
      await until("three parks on the wire", () => triaged(s, before).length >= 3);
      expect(triaged(s, before)).toEqual(["m1 set_aside", "m2 set_aside", "m3 set_aside"]);
      const box = liveOhbox(s.engine.read(), view);
      expect([...box.fresh, ...box.seen].map((r) => r.id), "the row left the Ohbox").toEqual(["m9"]);
      offer(s).opts!.undo!();
      await until("all back on the wire", () => triaged(s, before).length >= 6);
      expect(triaged(s, before).filter((x) => x.endsWith(" none"))).toEqual(["m1 none", "m2 none", "m3 none"]);
    } finally { s.close(); }
  });

  it("a second Park on the parked message unparks the whole conversation", async () => {
    const s = await scenePark();
    try {
      const before = writes(s).length;
      await s.actions.pileToggle("m2", "setAside");
      await until("both parks on the wire", () => triaged(s, before).length >= 2);
      const mid = writes(s).length; const said = s.said.length;
      expect(await s.actions.pileToggle("m2", "setAside")).toBe(true);
      await until("both unparks on the wire", () => triaged(s, mid).length >= 2);
      expect(triaged(s, mid)).toEqual(["m1 none", "m2 none"]);
      expect(pills(s, said)).toEqual(["Out of Parked"]);
      const box = liveOhbox(s.engine.read(), view);
      const back = [...box.fresh, ...box.seen].find((r) => r.id !== "m9");
      expect([...(back?.memberIds ?? [])].sort(), "the row is back whole").toEqual(["m1", "m2"]);
    } finally { s.close(); }
  });

  it("in Parked the conversation is one row, and a press on any member takes it out whole with one pill; Undo parks it again", async () => {
    const s = await scenePark();
    try {
      const before = writes(s).length;
      await s.actions.pileToggle("m2", "setAside");
      await until("both parks on the wire", () => triaged(s, before).length >= 2);
      const parked = livePiles(s.engine.read(), view).find((p) => p.kind === "setAside")!.items;
      expect(parked.map((i) => [i.messageId, i.memberIds])).toEqual([["m2", ["m2", "m1"]]]);
      const mid = writes(s).length; const said = s.said.length;
      expect(await s.actions.pileToggle("m1", "setAside")).toBe(true);
      await until("both unparks on the wire", () => triaged(s, mid).length >= 2);
      expect(triaged(s, mid)).toEqual(["m1 none", "m2 none"]);
      expect(pills(s, said)).toEqual(["Out of Parked"]);
      offer(s).opts!.undo!();
      await until("both parked again", () => triaged(s, mid).length >= 4);
      expect(triaged(s, mid).filter((x) => x.endsWith(" set_aside"))).toEqual(["m1 set_aside", "m2 set_aside"]);
    } finally { s.close(); }
  });

  it("Later on a parked member moves the row whole; Resurface books it whole", async () => {
    const s = await scenePark();
    try {
      let before = writes(s).length;
      await s.actions.pileToggle("m2", "setAside");
      await until("both parks on the wire", () => triaged(s, before).length >= 2);
      before = writes(s).length;
      await s.actions.pileToggle("m1", "replyLater");
      await until("both queued", () => triaged(s, before).length >= 2);
      expect(triaged(s, before)).toEqual(["m1 reply_later", "m2 reply_later"]);
      before = writes(s).length;
      await s.actions.resurfaceAt("m2", "2026-08-21T07:00:00.000Z");
      await until("both booked", () => triaged(s, before).length >= 2);
      expect(triaged(s, before)).toEqual(["m1 bubbled_up", "m2 bubbled_up"]);
    } finally { s.close(); }
  });

  it("a fresh boot over the same server state lists the parked conversation once", async () => {
    const s = await scenePark();
    try {
      const before = writes(s).length;
      await s.actions.pileToggle("m2", "setAside");
      await until("both parks on the wire", () => triaged(s, before).length >= 2);
      const fresh = sqlWorld();
      const boot = await bootEngine({ ...deps, openExecutor: fresh.open, deleteDatabase: fresh.drop }, { origin: s.origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      try {
        await boot.verifyIdentity();
        await boot.engine.start();
        const piles = livePiles(boot.engine.read(), view);
        expect(piles.find((p) => p.kind === "setAside")!.items.map((i) => i.memberIds)).toEqual([["m2", "m1"]]);
      } finally { boot.store.close(); }
    } finally { s.close(); }
  });

  it("CONTROL: a lone message parks itself alone", async () => {
    const s = await scenePark();
    try {
      const before = writes(s).length;
      expect(await s.actions.pileToggle("m9", "setAside")).toBe(true);
      await until("the park on the wire", () => triaged(s, before).length >= 1);
      await tick(100);
      expect(triaged(s, before)).toEqual(["m9 set_aside"]);
    } finally { s.close(); }
  });
});

/* THE ROW'S HALF, read as CODE: every verb `MailRow`'s press sends carries the row's members. */
describe("MailRow's press", () => {
  const src = withoutCommentsAndLiterals(readFileSync(fileURLToPath(new URL("../src/ui/MailRow.tsx", import.meta.url)), "utf8"));
  it("hands memberIds to every verb it presses", () => {
    const calls = [...src.matchAll(/w\.actions\.(pileToggle|move|resurfaceDone|markSeen|markRowSeen)\(/g)];
    expect(calls.length, "the row's verbs moved; this census reads nothing").toBe(4);
    for (const c of calls) {
      const span = bracketSpan(src, c.index! + c[0].length - 1);
      expect(src.slice(span.start, span.end), `${c[1]} drops the row's members`).toMatch(/,\s*members\s*$/);
    }
  });
});
