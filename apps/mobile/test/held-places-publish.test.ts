/**
 * THE HELD PLACES THE PROJECTION IS DRAWN FROM MOVE ONLY WHEN WHAT THEY SHOW MOVES. Each new
 * snapshot is a whole-world re-derivation on the phone, so a press whose record is still landing
 * and a Move that decides no rule hand the projection nothing; a press that holds a rule shows
 * its place once its record is on disk, and takes it back when its window closes.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingSubject, type RoutingIntent } from "@ohmail/client-engine";
import type { RoutingJournal } from "../src/state/held-routing";

const RULE: EngineMutation = { kind: "rule_update", ruleId: "r1", destination: "ohmail/News" };
const WINDOW_MS = 8000;

function intent(over: Partial<RoutingIntent> & { holdsRule?: false } = {}): RoutingIntent {
  return {
    v: 1, id: "p1", seedId: "m1", address: "a@b.test", scope: "sender",
    dest: "reads", messageIds: ["m1"], from: "INBOX", at: Date.now(), ...over,
  };
}

/** A journal whose writes land when the test says so. */
function gatedJournal(): RoutingJournal & { land: () => void } {
  const rows = new Map<string, unknown>();
  const waiting: Array<() => void> = [];
  return {
    get: <T>(type: string, id: string) => rows.get(`${type}:${id}`) as T | undefined,
    commitLocal: (puts, deletes) => new Promise<void>((resolve) => {
      waiting.push(() => {
        for (const p of puts) rows.set(`${p.type}:${p.id}`, p.entity);
        for (const d of deletes) rows.delete(`${d.type}:${d.id}`);
        resolve();
      });
    }),
    land: () => { for (const w of waiting.splice(0)) w(); },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function session() {
  vi.resetModules();
  const binding = await import("../src/state/held-routing");
  const journal = gatedJournal();
  const sent: EngineMutation[][] = [];
  binding.openRoutingSession({
    windowMs: WINDOW_MS, journal, plan: () => [RULE],
    dispatch: async (m) => { sent.push([...m]); return true; },
  });
  let notified = 0;
  binding.subscribeRoutingPlaces(() => { notified += 1; });
  return { binding, journal, sent, notified: () => notified };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("the held places", () => {
  it("move nothing while a press's record is landing, and show its place once it has", async () => {
    const s = await session();
    const held = s.binding.holdRouting(intent());
    await settle();
    expect(s.notified(), "a press still landing re-derived the world").toBe(0);
    expect(s.binding.routingPlaces().size).toBe(0);
    s.journal.land();
    expect((await held).held).toBe(true);
    expect(s.notified(), "the landed press did not show its place once").toBe(1);
    expect(s.binding.routingPlaces().get("m1")).toBe("ohmail/News");
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    s.journal.land();
    await settle();
    expect(s.sent).toEqual([[RULE]]);
    expect(s.notified(), "the window's close did not take the place back").toBe(2);
    expect(s.binding.routingPlaces().size).toBe(0);
  });

  it("never show a Move that decides no rule, through its hold, its Undo and a close", async () => {
    const s = await session();
    const held = s.binding.holdRouting(intent({ holdsRule: false }));
    await settle();
    s.journal.land();
    expect((await held).held, "the press was not held for its window").toBe(true);
    expect(s.binding.routingPlaces().size, "a Move that decides no rule showed a held place").toBe(0);
    expect(s.binding.undoRouting(routingSubject(intent())), "the window was not open").toBe(true);
    const again = s.binding.holdRouting(intent({ id: "p2", holdsRule: false }));
    await settle();
    s.journal.land();
    await again;
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    s.journal.land();
    await settle();
    expect(s.sent, "the second press was not committed at its close").toHaveLength(1);
    expect(s.notified(), "a Move that decides no rule re-derived the world").toBe(0);
  });
});
