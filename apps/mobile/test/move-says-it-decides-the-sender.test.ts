/**
 * A MOVE THAT DECIDES THE SENDER SAYS SO, AND ITS UNDO TAKES BACK BOTH HALVES.
 * Measured on Android 0.25.1: the pill said "Moved to News." while the sender's rule followed
 * 12-19 s later, and an Undo in the pill's last seconds brought the letter back and left the rule.
 * The window counted from the press, the pill from its own layout, so the pill still offered Undo
 * after the window had sent the rule. Driven here through the real window, engine and wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type EngineMessage, type RuleDTO } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, flushRouting, openRoutingSession } from "../src/state/held-routing";
import { liveActions, liveMessage, planHeldRouting, routingReversal, type ToastOpts, type WorldView } from "../src/state/live";
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
  return { fake, ...boot, actions, said, close };
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

describe("the pill says what the press decides", () => {
  it("a Move that retargets the sender's rule says future mail files there too", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      expect(await s.actions.move(row(s), "reads")).toBe(true);
      expect(offer(s).say).toBe(DECIDES);
    } finally { s.close(); }
  });

  it("the German deck says it in the web's words", async () => {
    setActiveLocale("de");
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      await s.actions.move(row(s), "reads");
      expect(offer(s).say).toBe(DECIDES_DE);
    } finally { s.close(); }
  });

  it("with no window to hold it the rule goes at once, and the sentence still says so", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      expect(await s.actions.move(row(s), "reads")).toBe(true);
      expect(s.said.map((x) => x.say)).toContain(DECIDES);
    } finally { s.close(); }
  });

  it("the press acts only on the letter: the rule is written with the backlog left alone", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 40);
      await s.actions.move(row(s), "reads");
      await until("the rule on the wire", () => ruleWrites(s).length > 0);
      expect(ruleWrites(s).map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own"]);
      expect(JSON.parse(ruleWrites(s)[0]!.body)).toMatchObject({ destination: "ohmail/News", applyRetro: false });
      // The press rewrites the route: its move is no override of it.
      const moved = s.fake.seen.filter((r) => r.url === "/messages/m1/move");
      expect(moved.map((r) => JSON.parse(r.body))).toEqual([{ folder: "ohmail/News", pressRule: true }]);
    } finally { s.close(); }
  });

  it("a one-off move with no rule to decide says only that it moved", async () => {
    // Filed in the INBOX under a sender rule for News, and shown where the mailbox has it (ARCH-R902):
    // a Move to News moves the letter and there is no rule holding the sender anywhere else to retarget.
    const s = await scene(
      [ruleDto("r-news", "sender", SENDER.address, "ohmail/News")],
      [dto("m1", { subject: "Weekly", from: SENDER })],
    );
    try {
      windowOver(s, 60_000);
      const m = row(s);
      expect(m.folder).toBe("INBOX");
      expect(m.presentedFolder).toBe("INBOX");
      expect(await s.actions.move(m, "reads")).toBe(true);
      expect(s.said.map((x) => x.say)).toEqual(["Moved to News."]);
      // No rule is written: an ordinary move, which may teach the route.
      await until("the move on the wire", () => s.fake.seen.some((r) => r.url === "/messages/m1/move"));
      expect(s.fake.seen.filter((r) => r.url === "/messages/m1/move").map((r) => JSON.parse(r.body))).toEqual([{ folder: "ohmail/News" }]);
      await tick(50);
      expect(ruleWrites(s), "a one-off move wrote a rule").toEqual([]);
    } finally { s.close(); }
  });
});

describe("the Undo and the commit are one decision", () => {
  it("an Undo the pill still offers, after the pill painted late, leaves no rule", async () => {
    const W = 600;
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, W);
      await s.actions.move(row(s), "reads");
      const o = offer(s);
      // The pill lays out late (the mirror's re-derivation), and its hold counts from there.
      await tick(350);
      o.opts!.shown?.();
      // Past the window as the press counted it, inside the window as the pill offers it.
      await tick(400);
      expect(ruleWrites(s), "the rule went out while the pill still offered Undo").toEqual([]);
      o.opts!.undo!();
      await until("the mail back", () => s.said.some((x) => x.say === BACK || x.say === "Undone."));
      await tick(W + 200);
      expect(ruleWrites(s), "a rule write landed after an Undo pressed inside the window").toEqual([]);
      expect(s.said.map((x) => x.say)).toContain(BACK);
      expect(s.fake.rule("r-own")?.destination).toBe("INBOX");
    } finally { s.close(); }
  });

  /* THE SENTENCE IS THE PRESS'S (FIX-026 row 92), both ways the Undo can go: a window still open
     says the rule was never made, a committed press says Undone — at the press, not after. */
  it("the Move's Undo says its sentence at the press, cancelled or committed", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      await s.actions.move(row(s), "reads");
      const held = offer(s);
      const before = s.said.length;
      held.opts!.undo!();
      expect(s.said.slice(before).map((x) => x.say), "the cancelled Undo said nothing at the press").toEqual([BACK]);
      await s.actions.move(row(s), "reads");
      const again = offer(s);
      flushRouting();
      await until("the committed rule", () => s.fake.rule("r-own")?.destination === "ohmail/News");
      const at = s.said.length;
      again.opts!.undo!();
      expect(s.said.slice(at).map((x) => x.say), "the committed Undo said nothing at the press").toEqual(["Undone."]);
    } finally { s.close(); }
  });

  it("left alone, the rule is made once the pill's window closes — once", async () => {
    const W = 200;
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, W);
      await s.actions.move(row(s), "reads");
      await tick(100);
      offer(s).opts!.shown?.();
      await tick(150);
      expect(ruleWrites(s), "the window closed before the pill's hold did").toEqual([]);
      await until("the rule on the wire", () => ruleWrites(s).length > 0);
      await tick(W + 100);
      expect(ruleWrites(s).map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own"]);
      expect(s.fake.rule("r-own")?.destination).toBe("ohmail/News");
    } finally { s.close(); }
  });

  it("a press that already committed (left the app inside the window) is undone by the inverse rule change", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      await s.actions.move(row(s), "reads");
      const o = offer(s);
      flushRouting(); // backgrounding commits the window
      await until("the committed rule", () => s.fake.rule("r-own")?.destination === "ohmail/News");
      o.opts!.undo!();
      await until("the rule put back", () => s.fake.rule("r-own")?.destination === "INBOX");
      const writes = ruleWrites(s);
      expect(writes.map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own", "PATCH /rules/r-own"]);
      expect(JSON.parse(writes[1]!.body)).toMatchObject({ destination: "INBOX", applyRetro: false });
      await until("the sentence", () => s.said.some((x) => x.say === "Undone."));
      expect(s.engine.read().get<EngineMessage>("message", "m1")?.folder).toBe("INBOX");
    } finally { s.close(); }
  });

  it("a committed press that CREATED a rule is undone by deleting that rule", async () => {
    const DOMAIN = "fake.test";
    const s = await scene([ruleDto("r-dom", "domain", DOMAIN, "INBOX")]);
    try {
      windowOver(s, 60_000);
      await s.actions.move(row(s), "reads");
      const o = offer(s);
      flushRouting();
      await until("the created rule", () => ruleWrites(s).some((r) => r.method === "POST"));
      o.opts!.undo!();
      await until("the created rule deleted", () => ruleWrites(s).some((r) => r.method === "DELETE"));
      const [made, gone] = ruleWrites(s);
      expect([made?.method, gone?.method]).toEqual(["POST", "DELETE"]);
      // The SERVER's id (`rule-N` here), never the optimistic one the mirror minted for the press.
      const id = decodeURIComponent(gone!.url.slice("/rules/".length));
      expect(id).toMatch(/^rule-\d+$/);
      expect(s.fake.rule(id), "the created rule is still on the server").toBeUndefined();
      expect(s.fake.rule("r-dom")?.destination, "the domain rule was touched").toBe("INBOX");
      await until("the sentence", () => s.said.some((x) => x.say === "Undone."));
    } finally { s.close(); }
  });
});
