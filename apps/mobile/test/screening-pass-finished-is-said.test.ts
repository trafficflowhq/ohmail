import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * A SCREENING PRESS THAT SAID "ohmail is applying the rule" IS TOLD WHEN IT HAS (the web's
 * `press-watch.ts`, gap row PHONE-SHEET-PASS-FINISHED-UNSAID): once, while the app is open, when the
 * rule's backlog pass reads done. Harness: screen-sender-reads-back.test.ts's, on the real wire.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open, deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};
const ADDR = "sender@fake.test";

async function scene(older = false) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-own", "sender", ADDR, "INBOX"));
  fake.addMessage(dto("m1", { subject: "Order fulfilled", folder: "INBOX" }));
  // The press files the letter it was made on itself; an older one is the pass's.
  if (older) fake.addMessage(dto("m2", { subject: "Order placed", folder: "INBOX", date: "2026-08-01T08:00:00Z" }));
  fake.stampRetro(true);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => void said.push(sayArg(m)), uuid: deps.uuid, zone: "UTC",
  });
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, engine: boot.engine, actions, said, close };
}

describe("the pass a press waited on is said once it finished", () => {
  it("says every message is there once the rule's pass reads done, and only once", async () => {
    const s = await scene();
    try {
      expect(await s.actions.screenSender("m1", "reads", "sender")).toBe(true);
      expect(s.said.at(-1), s.said.join(" | ")).toMatch(/applying the rule/);
      const before = s.said.length;
      s.fake.finishRetro("r-own", ["m1"]);
      await s.engine.syncOnce();
      expect(s.said.slice(before), "the finished pass was not said").toHaveLength(1);
      expect(s.said.at(-1)).toBe(`The 1 message from ${ADDR} is in News.`);
      await s.engine.syncOnce();
      expect(s.said.length, "said again on a later page").toBe(before + 1);
    } finally { s.close(); }
  });

  it("a pass that ended with mail still elsewhere says what stays", async () => {
    const s = await scene(true);
    try {
      await s.actions.screenSender("m1", "reads", "sender");
      s.fake.finishRetro("r-own");
      await s.engine.syncOnce();
      expect(s.said.at(-1)).toBe("1 is in News · 1 is still in Ohbox.");
    } finally { s.close(); }
  });

  it("CONTROL: while the pass still runs, a page says nothing more", async () => {
    const s = await scene();
    try {
      await s.actions.screenSender("m1", "reads", "sender");
      const before = s.said.length;
      await s.engine.syncOnce();
      expect(s.said.length).toBe(before);
    } finally { s.close(); }
  });
});
