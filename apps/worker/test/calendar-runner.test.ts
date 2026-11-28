/**
 * THE CALENDAR'S RUNNER: the bell, the queue and the lane, with the roster and the turn stood in
 * for. A connection is queued once; a turn with more to read goes behind the others; a parked
 * account is never turned; a turn that threw, or found its connection gone, is not asked again
 * every tick.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@trafficflow/core";
import { startCalendarRunner, type CalendarRunner, type CalendarRunnerDeps } from "../src/start/calendar.js";
import type { CalendarSyncOutcome, DueConnection } from "@ohmail/organizer/calendar-sync";

const due = (id: string, accountId = `acct-${id}`): DueConnection => ({ id, accountId, provider: "caldav", status: "active" });
const synced = (more: boolean): CalendarSyncOutcome => ({ kind: "synced", calendars: 1, pages: 1, changed: 0, dropped: 0, more });

let runner: CalendarRunner | null = null;
afterEach(() => { runner?.stop(); runner = null; });

function start(o: Partial<CalendarRunnerDeps> & Pick<CalendarRunnerDeps, "roster" | "turn">): CalendarRunner {
  runner = startCalendarRunner({ lanes: 1, floorMs: 60_000, gapMs: 0, isStopped: () => false, now: () => Date.now(), log: silentLogger, ...o });
  return runner;
}

async function settle(r: CalendarRunner): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((res) => setTimeout(res, 5));
    if (r.load().running === 0 && r.load().queued === 0) return;
  }
}

describe("the calendar's runner", () => {
  it("reports a hung roster scan and clears it when the scan returns", async () => {
    let now = 1000;
    let finish!: (rows: DueConnection[]) => void;
    const r = start({
      now: () => now,
      roster: () => new Promise((resolve) => { finish = resolve; }),
      turn: async () => synced(false),
    });
    r.ring();
    now += 121_000;
    expect(r.progress()).toMatchObject({ stalled: true, lastSettledAt: null });
    finish([]);
    await settle(r);
    expect(r.progress()).toMatchObject({ stalled: false, lastSettledAt: now });
  });

  it("reports repeated roster failures until a database scan succeeds", async () => {
    let now = 1000;
    let rejectRoster = true;
    const r = start({
      now: () => now, roster: async () => { if (rejectRoster) throw new Error("roster failed"); return []; },
      turn: async () => synced(false),
    });
    r.ring();
    await settle(r);
    now += 121_000;
    r.ring();
    await settle(r);
    expect(r.progress()).toMatchObject({ databaseFault: true, lastSettledAt: null });
    rejectRoster = false;
    r.ring();
    await settle(r);
    expect(r.progress()).toMatchObject({ databaseFault: false, lastSettledAt: now });
  });

  it("keeps reporting a healthy roster during a long calendar turn", async () => {
    let now = 1000;
    const turn = Promise.withResolvers<CalendarSyncOutcome>();
    const started = Promise.withResolvers<void>();
    const r = start({
      now: () => now,
      roster: async () => [due("importing")],
      turn: () => { started.resolve(); return turn.promise; },
    });
    r.ring();
    await started.promise;
    try {
      for (let scan = 0; scan < 4; scan++) {
        now += 31_000;
        r.ring();
        await vi.waitFor(() => expect(r.progress().lastSettledAt).toBe(now));
      }
      expect(r.load().running).toBe(1);
      expect(r.progress()).toMatchObject({ stalled: false, lastSettledAt: now });
    } finally {
      turn.resolve(synced(false));
      await r.settled();
    }
  });

  it("queues a connection once, and a turn with more to read goes behind the others", async () => {
    const turns: string[] = [];
    let aMore = true;
    const r = start({
      roster: async () => [due("a"), due("b"), due("a")],
      turn: async (c) => {
        turns.push(c.id);
        if (c.id === "a" && aMore) { aMore = false; return synced(true); }
        return synced(false);
      },
    });
    r.ring();
    await settle(r);
    expect(turns).toEqual(["a", "b", "a"]);
  });

  it("never turns a parked account's connection, and parks it for later", async () => {
    const turns: string[] = [];
    const parked: string[] = [];
    const r = start({
      roster: async () => [due("a", "acct-parked"), due("b")],
      turn: async (c) => { turns.push(c.id); return synced(false); },
      parked: async (ids) => new Set(ids.filter((id) => id === "acct-parked")),
      park: async (c) => { parked.push(c.id); },
    });
    r.ring();
    await settle(r);
    expect({ turns, parked }).toEqual({ turns: ["b"], parked: ["a"] });
  });

  it("does not ask again at the next tick a connection whose turn threw or found it gone", async () => {
    const turns: string[] = [];
    const r = start({
      roster: async () => [due("broken"), due("gone")],
      turn: async (c) => {
        turns.push(c.id);
        if (c.id === "broken") throw new Error("the store is away");
        return { kind: "gone" };
      },
    });
    r.ring();
    await settle(r);
    r.ring();
    await settle(r);
    expect(turns).toEqual(["broken", "gone"]);
  });

  it("tells the roster which connections cannot run now, and has a thrown turn's word written", async () => {
    const passedOver: string[][] = [];
    const failed: string[] = [];
    const r = start({
      roster: async (_now, except) => {
        passedOver.push([...(except ?? [])].sort());
        return [due("broken"), due("gone")];
      },
      turn: async (c) => {
        if (c.id === "broken") throw new Error("the store is away");
        return { kind: "gone" };
      },
      failed: async (c) => { failed.push(c.id); return null; },
    });
    r.ring();
    await settle(r);
    r.ring();
    await settle(r);
    expect({ passedOver, failed }).toEqual({ passedOver: [[], ["broken", "gone"]], failed: ["broken"] });
  });

  it("ends a turn whose call never returns at the turn's own bound, and the next connection is read", async () => {
    const turns: string[] = [];
    const reasons: string[] = [];
    const r = start({
      roster: async () => [due("hangs"), due("next")],
      turnHardMs: 30,
      turn: (c, signal) => {
        turns.push(c.id);
        if (c.id !== "hangs") return Promise.resolve(synced(false));
        return new Promise((res) => {
          signal.addEventListener("abort", () => {
            reasons.push((signal.reason as { name?: string } | undefined)?.name ?? "");
            res({ kind: "backed_off", word: "timeout", untilMs: Date.now() + 60_000 });
          }, { once: true });
        });
      },
    });
    r.ring();
    await settle(r);
    expect({ turns, reasons }).toEqual({ turns: ["hangs", "next"], reasons: ["CalendarTurnOverdue"] });
  });

  it("a turn with more to read that ran long waits as long before it queues again", async () => {
    let now = 1_000_000;
    let turns = 0;
    const r = start({
      now: () => now,
      turnMs: 10_000,
      roster: async () => [due("slow")],
      turn: async () => {
        turns += 1;
        if (turns > 1) return synced(false);
        // One slow host: this turn held the lane for half a minute and has more to read.
        now += 30_000;
        return synced(true);
      },
    });
    r.ring();
    await settle(r);
    expect(turns).toBe(1);
    r.ring();
    await settle(r);
    expect(turns).toBe(1);
    now += 30_001;
    r.ring();
    await settle(r);
    expect(turns).toBe(2);
  });

  it("stopped, it starts nothing and its turns end", async () => {
    let signalled = false;
    const r = start({
      roster: async () => [due("slow")],
      turn: (_c, signal) => new Promise((res) => { signal.addEventListener("abort", () => { signalled = true; res({ kind: "halted" }); }); }),
    });
    r.ring();
    for (let i = 0; i < 50 && r.load().running === 0; i++) await new Promise((res) => setTimeout(res, 5));
    r.stop();
    await r.settled();
    expect({ signalled, load: r.load() }).toEqual({ signalled: true, load: { running: 0, queued: 0 } });
  });
});
