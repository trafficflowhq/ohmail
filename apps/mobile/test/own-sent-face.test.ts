/**
 * AN OWN-SENT ROW SAYS WHO IT WENT TO (PHONE-OWN-SENT-FACE). The phone faced it with the account's
 * own name, where the web and the desktop say "Me → recipient" — and a conversation answered last
 * is faced by the reply, so every answered conversation showed it. The web's words, both decks.
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

const ME = { name: "Rig Owner", address: "me@fake.test" };
const NORA = { name: "Nora Lindt", address: "nora@fake.test" };
const own: WorldView = { ...view, ownAddresses: ["Me@Fake.test"] };

describe("the face of an own-sent row", () => {
  it("names the first To recipient, with the rest counted", async () => {
    const s = await scene([], [
      { ...dto("s1", { subject: "Plans", from: ME }), to: [NORA] },
      { ...dto("s2", { subject: "Plans", from: ME }), to: [NORA, { name: "", address: "kai@fake.test" }] },
    ]);
    try {
      expect(liveMessage(s.engine, "s1", own)?.sentTo).toBe("Me → Nora Lindt");
      expect(liveMessage(s.engine, "s2", own)?.sentTo).toBe("Me → Nora Lindt +1");
      setActiveLocale("de");
      expect(liveMessage(s.engine, "s1", own)?.sentTo).toBe("Ich → Nora Lindt");
    } finally { s.close(); }
  });

  it("keeps the sender face with no recipient to name, and on everybody else's mail", async () => {
    const s = await scene([], [dto("s3", { subject: "Draft", from: ME }), { ...dto("r1", { from: NORA }), to: [ME] }]);
    try {
      expect(liveMessage(s.engine, "s3", own)?.sentTo).toBeUndefined();
      expect(liveMessage(s.engine, "r1", own)?.sentTo).toBeUndefined();
      expect(liveMessage(s.engine, "r1", view)?.sentTo, "no own addresses known").toBeUndefined();
    } finally { s.close(); }
  });
});
