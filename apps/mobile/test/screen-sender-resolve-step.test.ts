import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { ruleFingerprint, type ScreenIntent } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { DECKS } from "../src/copy";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { answerScreenPress, closeRoutingSession, noteScreenChanged, openRoutingSession } from "../src/state/held-routing";
import { liveActions, planHeldRouting, type ToastOpts } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE'S SHEET PRESS: THE STEP'S ANSWER RIDES THE HELD PRESS. A press on the Ohbox over the
 * sender's subject rule into News, answered "All their mail", is held for the undo window with
 * nothing on the wire; when the window closes the one commit planner removes the rule it showed,
 * by id, and the list is read back. A v2 row read as a Move wrote no rule at all.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };
const ADDR = "sender@fake.test";
const TERM = "[Weekly-Digest]";
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { closeRoutingSession(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-bare", "sender", ADDR, "INBOX"));
  fake.addRule({ ...ruleDto("r-split", "sender", ADDR, "ohmail/News"), subjectContains: TERM, createdAt: "2026-08-19T08:00:00Z" });
  fake.addMessage(dto("m1", { subject: "Order fulfilled", folder: "INBOX" }));
  // FILED by the subject rule since ARCH-R902: the resolution step exists for mail
  // that rule moved, whose folder the wire carries; an unfiled twin is in the Ohbox and asks nothing.
  fake.addMessage(dto("m2", { subject: `${TERM} week 38`, folder: "ohmail/News" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  let lastOpts: ToastOpts | undefined;
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC",
    toast: (m, o) => { said.push(sayArg(m)); lastOpts = o; },
  });
  const wire = () => fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET").map((r) => `${r.method} ${r.url}`);
  const close = () => { boot.store.close(); fake.server.close(); };
  return { ...boot, fake, actions, said, wire, lastOpts: () => lastOpts, close };
}

/** The window's session; `landed` resolves when its dispatch has been answered — the event a case reads the wire at. */
function session(s: Awaited<ReturnType<typeof scene>>): { landed: Promise<void> } {
  let settled!: () => void;
  const landed = new Promise<void>((r) => { settled = r; });
  openRoutingSession({
    windowMs: 30,
    journal: s.store,
    plan: (i) => planHeldRouting(s.engine.read(), i, (changed) => noteScreenChanged(i.id, changed)),
    dispatch: async (ms, i) => {
      const answers = await Promise.all(ms.map((m) => s.engine.mutate(m).catch(() => null)));
      answerScreenPress(i.id, ms, answers);
      settled();
    },
  });
  return { landed };
}

describe("a held sheet press commits with its resolution", () => {
  it("the forecast names the subject rule, the press is held, and the window removes the rule it showed", async () => {
    const s = await scene();
    try {
      const { landed } = session(s);
      const forecast = s.actions.screeningForecast("m1", "ohbox", "sender", true)!;
      expect(forecast.groups.map((g) => [g.cause, g.rule.id])).toEqual([["term-subject", "r-split"]]);
      const shown = forecast.groups.map((g) => g.rule);
      expect(await s.actions.screenSender("m1", "ohbox", "sender", true, { resolution: "remove", shown, forecast })).toBe(true);
      expect(s.wire(), "a rule went out inside the undo window").toEqual([]);
      expect(s.said.at(-1)).toContain(`»${TERM}« is removed`);
      expect(s.lastOpts()?.undo, "the press offered no Undo").toBeTypeOf("function");
      await landed;
      // The bare rule already at the place is re-armed for the past mail; the subject rule goes by id.
      expect(s.wire()).toEqual(["PATCH /rules/r-bare", "DELETE /rules/r-split"]);
    } finally { s.close(); }
  });

  it("Undo inside the window sends nothing", async () => {
    const s = await scene();
    try {
      session(s);
      const forecast = s.actions.screeningForecast("m1", "ohbox", "sender", true)!;
      await s.actions.screenSender("m1", "ohbox", "sender", true, { resolution: "remove", shown: forecast.groups.map((g) => g.rule), forecast });
      s.lastOpts()!.undo!();
      await tick(150);
      expect(s.wire()).toEqual([]);
    } finally { s.close(); }
  });

  it("the sheet's Undo says its sentence at the press (FIX-026 row 92)", async () => {
    const s = await scene();
    try {
      session(s);
      const forecast = s.actions.screeningForecast("m1", "ohbox", "sender", true)!;
      await s.actions.screenSender("m1", "ohbox", "sender", true, { resolution: "remove", shown: forecast.groups.map((g) => g.rule), forecast });
      const before = s.said.length;
      s.lastOpts()!.undo!();
      expect(s.said.slice(before), "nothing was said at the press").toEqual([DECKS.en.screeningRoutingUndoneRules]);
    } finally { s.close(); }
  });

  it("a v2 row is planned with its resolution, not read as a Move", async () => {
    const s = await scene();
    try {
      const split = s.engine.read().get<RuleDTO>("rule", "r-split")!;
      const intent: ScreenIntent = {
        v: 2, verb: "screen", id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox",
        messageIds: ["m1"], makeRule: true, applyRetro: false, resolution: "remove",
        shown: [{ id: "r-split", fp: ruleFingerprint(split) }], at: 0,
      };
      // The bare rule the Screener promoted at the Ohbox is claimed too, moving nothing (REVIEW-026 HIGH 1).
      expect(planHeldRouting(s.engine.read(), intent)).toEqual([
        { kind: "rule_update", ruleId: "r-bare", destination: "INBOX", applyRetro: false },
        { kind: "rule_delete", ruleId: "r-split" },
      ]);
    } finally { s.close(); }
  });
});
