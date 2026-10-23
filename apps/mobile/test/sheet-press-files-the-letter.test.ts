import { afterEach, describe, expect, it } from "vitest";
import type { EngineMessage, EntityReader } from "@ohmail/client-engine";
import { refuse, sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  closeRoutingSession, noteScreenChanged, answerScreenPress, openRoutingSession, routingPlaces, routingReader,
} from "../src/state/held-routing";
import {
  dispatchHeldRouting, liveActions, planHeldRouting, presentedOf, standsInOhbox, type LiveWorldActions,
} from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE'S SHEET PRESS FILES THE LETTER IT WAS MADE ON (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX),
 * on the real wire and through the session `world.tsx` opens: one `move` at the press, the rule in
 * the window, the rest of the landing held at the place until the walk reads done, and a read-back
 * that reads the lists without the held overlay, so it never says "all" over a row only shown there.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open, deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};
const ADDR = "sender@fake.test";

/** `gate`: no rule; the answer the gate admitted (m1) stands in the Ohbox, decided, and m2 waits. */
async function scene(rule = ruleDto("r-own", "sender", ADDR, "INBOX"), gate = false) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  if (!gate) fake.addRule(rule);
  fake.addMessage({ ...dto("m1", { subject: "Order fulfilled", folder: "INBOX" }), ...(gate ? { placeDecided: true } : {}) } as never);
  fake.addMessage(gate
    ? dto("m2", { subject: "Our newsletter", folder: "ohmail/Screener", date: "2026-08-20T08:00:00Z" })
    : dto("m2", { subject: "Order placed", folder: "INBOX", date: "2026-08-01T08:00:00Z" }));
  fake.stampRetro(true);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const engine = boot.engine;
  const said: string[] = [];
  const toast = (m: Parameters<typeof sayArg>[0]) => void said.push(sayArg(m));
  openRoutingSession({
    windowMs: 60,
    journal: boot.store,
    plan: (intent) => planHeldRouting(engine.read(), intent, (changed) => noteScreenChanged(intent.id, changed)),
    dispatch: (mutations, intent) => dispatchHeldRouting(engine, mutations, intent, {
      answered: (answers) => answerScreenPress(intent.id, mutations, answers),
      refused: () => toast(refuse("liveSaveFailed")),
    }),
  });
  const unrouted = (): EntityReader => presentedOf(engine.read(), new Date(), false);
  const lists = (): EntityReader => routingReader(unrouted(), routingPlaces());
  const actions: LiveWorldActions = liveActions({
    engine, toast, uuid: deps.uuid, zone: "UTC", presented: lists, unrouted,
  });
  const moves = () => fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url)).map((r) => r.url);
  const moveBodies = () => fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url)).map((r) => JSON.parse(r.body) as unknown);
  const ruleWrites = () => fake.seen.filter((r) => r.url.startsWith("/rules") && r.method !== "GET").map((r) => `${r.method} ${r.url}`);
  const writes = () => fake.seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`);
  const close = () => { closeRoutingSession(); boot.store.close(); fake.server.close(); };
  return { fake, engine, actions, said, lists, moves, moveBodies, ruleWrites, writes, close };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

afterEach(() => { closeRoutingSession(); });

describe("the phone's sheet press", () => {
  it("moves the letter at the press, holds the rest at the place, and reads back without the hold", async () => {
    const s = await scene();
    try {
      expect(await s.actions.screenSender("m1", "reads", "sender", true)).toBe(true);
      await until(() => s.moves().length > 0);
      expect(s.moves(), "only the letter pressed on moves").toEqual(["/messages/m1/move"]);
      expect(s.moveBodies(), "the press rewrites the route: its move is no override of it")
        .toEqual([{ folder: "ohmail/News", pressRule: true }]);
      expect(s.ruleWrites(), "the rule waits for the window").toEqual([]);
      expect(standsInOhbox(s.lists(), "m1")).toBe(false);
      expect(standsInOhbox(s.lists(), "m2"), "the window shows the rest at the place").toBe(false);

      const pressSaid = s.said.length;
      await until(() => s.said.length > pressSaid);
      expect(s.ruleWrites()).toEqual(["PATCH /rules/r-own"]);
      // Past the window, the walk has not run: the rest is still held at the place…
      expect(standsInOhbox(s.lists(), "m2"), "the window's close dropped the rest back in the Ohbox").toBe(false);
      // …and the read-back reads where it is, so it never says every message is there.
      expect(s.said.at(-1), s.said.join(" | ")).toMatch(/^1 is in News\. ohmail is applying/);

      // The walk ends without filing m2 (a reason the wire does not carry): it is shown where it is.
      s.fake.finishRetro("r-own");
      await s.engine.syncOnce();
      expect(standsInOhbox(s.lists(), "m2"), "the hold outlived the walk").toBe(true);
      expect(standsInOhbox(s.lists(), "m1"), "the letter pressed on came back").toBe(false);
      expect(s.moves()).toHaveLength(1);
    } finally { s.close(); }
  });

  it("a refused rule drops the hold and says the letter moved", async () => {
    const s = await scene();
    try {
      s.fake.failNext("PATCH", "/rules/");
      expect(await s.actions.screenSender("m1", "reads", "sender", true)).toBe(true);
      const pressSaid = s.said.length;
      await until(() => s.said.length > pressSaid);
      expect(s.said.at(-1), s.said.join(" | ")).toContain("this message moved, but the rule couldn't be made");
      expect(standsInOhbox(s.lists(), "m2"), "a refused rule promises nothing").toBe(true);
      expect(s.engine.read().get<EngineMessage>("message", "m1")?.folder).toBe("ohmail/News");
    } finally { s.close(); }
  });

  for (const retro of [true, false]) {
    it(`the gate path, switch ${retro ? "on" : "off"}: the letter pressed on is filed once the decision stands`, async () => {
      const s = await scene(undefined, true);
      try {
        expect(standsInOhbox(s.lists(), "m1"), "premise: the answer the gate admitted stands in the Ohbox").toBe(true);
        expect(await s.actions.screenSender("m1", "receipts", "sender", retro)).toBe(true);
        expect(s.writes(), "the decision first, then the letter pressed on").toEqual(["POST /screener/m2", "POST /messages/m1/move"]);
        expect(s.moveBodies()).toEqual([{ folder: "ohmail/Receipts", from: "INBOX", pressRule: true }]);
        await s.engine.syncOnce();
        expect(standsInOhbox(s.lists(), "m1")).toBe(false);
        // Both letters are there: not "1 is in Receipts · 1 is still in Ohbox".
        expect(s.said.at(-1), s.said.join(" | ")).toMatch(/future mail from .* files there automatically/);
      } finally { s.close(); }
    });
  }

  it("the gate path: a refused decision files nothing", async () => {
    const s = await scene(undefined, true);
    try {
      s.fake.failNext("POST", "/screener/");
      expect(await s.actions.screenSender("m1", "receipts", "sender", true)).toBe(false);
      expect(s.moves()).toEqual([]);
      expect(standsInOhbox(s.lists(), "m1")).toBe(true);
    } finally { s.close(); }
  });

  it("a domain press sends the rule, then exactly the letter pressed on", async () => {
    const s = await scene(ruleDto("r-dom", "domain", "fake.test", "INBOX"));
    try {
      expect(await s.actions.screenSender("m1", "receipts", "domain", true)).toBe(true);
      await until(() => s.moves().length > 0);
      expect(s.ruleWrites()).toEqual(["PATCH /rules/r-dom"]);
      expect(s.moves()).toEqual(["/messages/m1/move"]);
      expect(s.moveBodies()).toEqual([{ folder: "ohmail/Receipts", pressRule: true }]);
    } finally { s.close(); }
  });
});
