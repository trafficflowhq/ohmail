/**
 * THE PHONE'S TWIN OF `apps/webapp/test/screening-count-is-what-you-gain.test.tsx`. On the web
 * the accept said "1 message moved" where the Ohbox gained two: the count was the plan's moves.
 * The phone's accept names no number — its decide says where their future mail goes, on the
 * answer — so it can never state the moves. These cases pin that over the same split sender, on
 * a real wire: one letter in the INBOX shown at the gate, one in Screened, and (waiting) one held.
 * Green before the web fix by construction; they fail the day the phone says a count of moves.
 */
import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const SPLIT = { name: "Split Sender", address: "letters@split.test" };

async function scene(held: boolean) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage({ ...dto("in-1", { subject: "In the INBOX", date: new Date(Date.now() - 3_600_000).toISOString() }), from: SPLIT });
  fake.addMessage({ ...dto("sc-1", { subject: "Screened", folder: "ohmail/Screened", unread: false }), from: SPLIT });
  if (held) fake.addMessage({ ...dto("gate-1", { subject: "At the gate", folder: "ohmail/Screener", date: new Date().toISOString() }), from: SPLIT });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid: deps.uuid, zone: "UTC",
  });
  return { fake, boot, actions, toasts };
}

/** No count of letters and no "moved": the phone's accept says where future mail goes. */
function namesNoMoves(toasts: readonly string[]): void {
  expect(toasts.length, "the press said nothing").toBeGreaterThan(0);
  for (const t of toasts) {
    expect(t, t).not.toMatch(/\bmoved\b|verschoben/i);
    expect(t, t).not.toMatch(/\b\d+\s+messages?\b/i);
  }
  expect(toasts.some((t) => /future mail from/i.test(t)), toasts.join(" | ")).toBe(true);
}

describe("the phone's accept of a split sender names no count of moves", () => {
  it("past the gate: the rule is written and the sentence names no number", async () => {
    const s = await scene(false);
    const row = { id: "in-1", address: SPLIT.address, held: [{ id: "in-1" }] } as Parameters<LiveWorldActions["decide"]>[0];
    expect(await s.actions.decide(row, "ohbox", false, "sender")).toBe(true);
    // The positive control: the press applied — their rule is in the mirror.
    expect(s.boot.engine.read().list<RuleDTO>("rule").some((r) => r.match === SPLIT.address)).toBe(true);
    namesNoMoves(s.toasts);
    s.boot.store.close();
    s.fake.server.close();
  });

  it("waiting at the gate: the decide lands and the sentence names no number", async () => {
    const s = await scene(true);
    const row = { id: "gate-1", address: SPLIT.address, held: [{ id: "gate-1" }] } as Parameters<LiveWorldActions["decide"]>[0];
    expect(await s.actions.decide(row, "ohbox", false, "sender")).toBe(true);
    expect(s.boot.engine.read().get<EngineMessage>("message", "gate-1")?.folder).toBe("INBOX");
    namesNoMoves(s.toasts);
    s.boot.store.close();
    s.fake.server.close();
  });
});
