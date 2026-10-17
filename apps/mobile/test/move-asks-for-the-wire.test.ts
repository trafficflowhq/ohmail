/**
 * A MOVE ASKS FOR THE WIRE. On a standalone phone the letter's move waited for the next sync cycle
 * and paid the first-page grace again: 6.1-7.4 s from the tap to `UID MOVE` on the device. The
 * press now rings `POST /sync/pull` once, after its move, which the local door turns into a drain.
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

describe("a Move asks for the wire", () => {
  const pulls = (s: Scene) => s.fake.seen.filter((r) => r.method === "POST" && r.url === "/sync/pull");
  const moves = (s: Scene) => s.fake.seen.filter((r) => r.method === "POST" && /\/messages\/[^/]+\/move$/.test(r.url));

  it("a made Move rings the pull once, after its move left", async () => {
    const s = await scene(
      [ruleDto("r-news", "sender", SENDER.address, "ohmail/News")],
      [dto("m1", { subject: "Weekly", from: SENDER })],
    );
    try {
      windowOver(s, 60_000);
      const before = pulls(s).length;
      expect(await s.actions.move(row(s), "reads")).toBe(true);
      await until("the pull on the wire", () => pulls(s).length > before);
      await tick(50);
      expect(pulls(s).length - before, "one press, one pull").toBe(1);
      expect(pulls(s).at(-1)!.body, "the pull does not name the pressed mailbox").toBe('{"mailboxIds":["mb-1"]}');
      expect(moves(s).length).toBe(1);
      const at = (r: { url: string }) => s.fake.seen.indexOf(r as never);
      expect(at(pulls(s).at(-1)!), "the pull went before the move it asks for").toBeGreaterThan(at(moves(s)[0]!));
    } finally { s.close(); }
  });

  it("a Move that sends nothing asks for nothing", async () => {
    const s = await scene([], [dto("m1", { subject: "Weekly", from: SENDER, folder: "ohmail/News" } as never)]);
    try {
      windowOver(s, 60_000);
      const before = pulls(s).length;
      await s.actions.move(row(s), "reads");
      await tick(100);
      expect(pulls(s).length - before).toBe(0);
    } finally { s.close(); }
  });
});
