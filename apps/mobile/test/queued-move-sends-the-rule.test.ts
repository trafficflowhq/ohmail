/* A QUEUED LETTER'S MOVE STILL ASKS FOR THE SENDER'S RULE (gap row PHONE-QUEUED-MOVE-SENDS-NO-RULE).
   Harness copied from move-says-it-decides-the-sender.test.ts. */
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

const QUEUED = "Queued for Studio laptop: the letter and the sender's rule go to News on its next pass.";

describe("a Move whose letter waits on the organizer", () => {
  it("still asks for the sender's rule, once the window closes, and says both halves", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 40);
      s.fake.queueNextForOrganizer("POST", "/messages/m1/move");
      expect(await s.actions.move(row(s), "reads")).toBe(true);
      expect(offer(s).say).toBe(QUEUED);
      await until("the rule on the wire", () => ruleWrites(s).length > 0);
      expect(ruleWrites(s).map((r) => `${r.method} ${r.url}`)).toEqual(["PATCH /rules/r-own"]);
    } finally { s.close(); }
  });

  it("Undo inside the window takes the rule back and says the letter still waits", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      s.fake.queueNextForOrganizer("POST", "/messages/m1/move");
      await s.actions.move(row(s), "reads");
      offer(s).opts!.undo!();
      await tick(50);
      expect(ruleWrites(s)).toEqual([]);
      expect(s.said.map((x) => x.say)).toContain("No rule was made. The letter still waits on Studio laptop.");
    } finally { s.close(); }
  });

  it("CONTROL: a queued letter with no rule to decide says the letter alone", async () => {
    const s = await scene([ruleDto("r-news", "sender", SENDER.address, "ohmail/News")]);
    try {
      windowOver(s, 40);
      s.fake.queueNextForOrganizer("POST", "/messages/m1/move");
      await s.actions.move(row(s), "reads");
      await tick(200);
      expect(s.said.map((x) => x.say)).toEqual(["Queued for Studio laptop — it goes to News on the next pass."]);
      expect(ruleWrites(s)).toEqual([]);
    } finally { s.close(); }
  });

  it("German says it in its own words", async () => {
    setActiveLocale("de");
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")]);
    try {
      windowOver(s, 60_000);
      s.fake.queueNextForOrganizer("POST", "/messages/m1/move");
      await s.actions.move(row(s), "reads");
      expect(offer(s).say).toBe("Für Studio laptop vorgemerkt: Die Nachricht und die Regel für den Absender gehen beim nächsten Durchgang nach News.");
    } finally { s.close(); }
  });
});
