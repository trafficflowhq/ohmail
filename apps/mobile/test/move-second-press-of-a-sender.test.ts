/**
 * A SECOND PRESS ABOUT A SENDER IS THE ONE THAT STANDS. The window keeps one press per sender, so
 * a second Move replaces the first; the first toast's Undo took the SUBJECT back and cancelled the
 * second press's rule. Undo is keyed by press id now: on a replaced press it says it is too late.
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

describe("two Moves about one sender inside the window", () => {
  const LATE = "A later choice for this sender replaced this one, so there is nothing to undo here.";
  const LETTER_BACK = "The mail is back where it was. A later choice for this sender decides where their mail goes.";
  const two = () => [dto("m1", { subject: "One", from: SENDER }), dto("m2", { subject: "Two", from: SENDER })];

  /* PHONE-RULE-BRANCH-UNDO-SAYS-NOTHING-TO-UNDO: the first press's letter has a way back, so its Undo
     takes it (`press-says-what-it-changed.test.ts`); the later press's rule still stands. */
  it("the first press's Undo leaves the second press's rule held, and says so", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], two());
    try {
      windowOver(s, 400);
      expect(await s.actions.move(row(s, "m1"), "reads")).toBe(true);
      const first = offer(s);
      expect(await s.actions.move(row(s, "m2"), "receipts")).toBe(true);
      first.opts!.undo!();
      expect(s.said.at(-1)!.say).toBe(LETTER_BACK);
      await until("the second press's rule on the wire", () => ruleWrites(s).length > 0);
      expect(ruleWrites(s).some((r) => r.body.includes("ohmail/Receipts")), "the second press's rule was lost").toBe(true);
    } finally { s.close(); }
  });

  it("an Undo on the press still held takes it back", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], two());
    try {
      windowOver(s, 400);
      await s.actions.move(row(s, "m1"), "reads");
      offer(s).opts!.undo!();
      expect(s.said.at(-1)!.say).not.toBe(LATE);
      await tick(600);
      expect(ruleWrites(s), "an undone press still wrote its rule").toHaveLength(0);
    } finally { s.close(); }
  });

  /* L2 of REVIEW-026-PHONE-SAYS-EVERY-PRESS-2: a Move that decides no rule, replaced by a later Move
     about the sender, still takes its LETTER back — nothing was sent, so "too late" was false. */
  it("a rule-less first press replaced by a ruling second still takes its letter back", async () => {
    const s = await scene([ruleDto("r-own", "sender", SENDER.address, "INBOX")], [
      dto("m1", { subject: "One", folder: "ohmail/Receipts", from: SENDER }), dto("m2", { subject: "Two", from: SENDER }),
    ]);
    try {
      windowOver(s, 600);
      expect(await s.actions.move(row(s, "m1"), "reads")).toBe(true);
      const first = offer(s);
      expect(await s.actions.move(row(s, "m2"), "receipts")).toBe(true);
      first.opts!.undo!();
      await tick(300);
      expect(s.said.map((x) => x.say), "a false 'already sent'").not.toContain("Too late to undo — that decision has already been sent.");
      expect(s.engine.read().get<EngineMessage>("message", "m1")?.folder, "the letter did not come back").toBe("ohmail/Receipts");
    } finally { s.close(); }
  });
});
