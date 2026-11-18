/**
 * A MOVE ON OUR OWN LETTER WRITES NO RULE ABOUT OUR OWN ADDRESS, on the phone. A
 * note to self in the inbox, held there by a rule about our own address made before the create
 * door refused them, was retargeted by a Move and the pill said "Future mail from them files there
 * too". The letter moves with no rule and the plain sentence. A friend's letter is the control.
 */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { closeRoutingSession, openRoutingSession } from "../src/state/held-routing";
import { liveActions, liveMessage, planHeldRouting, routingReversal, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

const ME = { name: "Me", address: "me@fake.test" };
const FRIEND = { name: "Friend", address: "friend@fake.test" };

async function scene(rules: RuleDTO[], from: { name: string; address: string }) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  fake.addMessage(dto("m1", { subject: "Note", from }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC", ownAddresses: () => [ME.address],
    toast: (m) => { said.push(sayArg(m)); },
  });
  openRoutingSession({
    windowMs: 40,
    journal: boot.store,
    plan: (i) => planHeldRouting(boot.engine.read(), i),
    dispatch: async (ms) => {
      const answers = await Promise.all(ms.map((m) => boot.engine.mutate(m).catch(() => null)));
      return !answers.some((r) => r === null || r.status === "rolled_back");
    },
    reverse: (ms, i) => (i.v === 2 ? null : routingReversal(() => boot.engine.read(), ms)),
  });
  const row = liveMessage(boot.engine, "m1", view);
  if (!row) throw new Error("no row");
  const ruleWrites = () => fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET").map((r) => `${r.method} ${r.url}`);
  const close = () => { boot.store.close(); fake.server.close(); };
  return { actions, row, said, ruleWrites, close };
}

const settle = () => new Promise((r) => setTimeout(r, 250));

afterEach(() => { closeRoutingSession(); });

describe("Move on our own letter, on the phone", () => {
  it("a note to self under a rule about our own address moves with no rule and the plain sentence", async () => {
    const s = await scene([ruleDto("r-me", "sender", ME.address, "INBOX")], ME);
    try {
      expect(await s.actions.move(s.row, "reads")).toBe(true);
      await settle();
      expect.soft(s.ruleWrites(), "a rule about our own address was written").toEqual([]);
      expect(s.said).toEqual(["Moved to News."]);
    } finally { s.close(); }
  });

  it("a friend's letter still retargets their rule and says so (the positive control)", async () => {
    const s = await scene([ruleDto("r-fr", "sender", FRIEND.address, "INBOX")], FRIEND);
    try {
      expect(await s.actions.move(s.row, "reads")).toBe(true);
      await settle();
      expect.soft(s.ruleWrites()).toEqual(["PATCH /rules/r-fr"]);
      expect(s.said.join(" ")).toContain("Future mail from them files there too");
    } finally { s.close(); }
  });
});
