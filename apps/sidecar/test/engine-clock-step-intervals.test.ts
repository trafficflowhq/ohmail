import { afterEach, describe, expect, it, vi } from "vitest";
import { screenerCorrespondentRetroPass } from "@ohmail/organizer/screener-correspondent-retro";
import { threadJoinHealPass } from "@ohmail/organizer/thread-join-heal";
import { inboundQuietPass } from "@ohmail/organizer/inbound-quiet";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { boot, ordinary, rig, server } from "./_overrun-rig.js";
import { settledWithin } from "../src/engine.js";
import { resetFirstPageGate } from "../src/first-page-gate.js";

vi.mock("@ohmail/organizer/screener-correspondent-retro", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/organizer/screener-correspondent-retro")>();
  return { ...real, screenerCorrespondentRetroPass: vi.fn(real.screenerCorrespondentRetroPass) };
});
vi.mock("@ohmail/organizer/thread-join-heal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/organizer/thread-join-heal")>();
  return { ...real, threadJoinHealPass: vi.fn(real.threadJoinHealPass) };
});
vi.mock("@ohmail/organizer/inbound-quiet", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/organizer/inbound-quiet")>();
  return { ...real, inboundQuietPass: vi.fn(real.inboundQuietPass) };
});

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/*
 * A WALL CLOCK STEPPED BACK AN HOUR IN THE MIDDLE OF AN INTERVAL. The engine's in-launch passes and
 * its stop measure how long since something on a monotonic clock, so the step neither skips a pass
 * nor stretches a stop. The wall clock is `Date.now` plus a skew; the monotonic one is injected.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const realNow = Date.now.bind(Date);

const runs = () => ({
  retro: vi.mocked(screenerCorrespondentRetroPass).mock.calls.length,
  heal: vi.mocked(threadJoinHealPass).mock.calls.length,
  quiet: vi.mocked(inboundQuietPass).mock.calls.length,
});

describe("the in-launch passes under a wall clock stepped back an hour", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
    resetFirstPageGate();
  });

  /** Boots, drains once (each pass runs on a launch's first drain), and hands back the clocks. */
  async function launched() {
    vi.mocked(screenerCorrespondentRetroPass).mockClear();
    vi.mocked(threadJoinHealPass).mockClear();
    vi.mocked(inboundQuietPass).mockClear();
    const clock = { skewMs: 0 };
    const mono = { skewMs: 0 };
    const b = await boot(rig(server([[1, ordinary("one")]])), clock, cleanups, {
      monotonic: () => performance.now() + mono.skewMs,
    });
    await b.cycle();
    const first = runs();
    expect(first, "a launch's first drain ran none of the passes, so this case proves nothing")
      .toEqual({ retro: 1, heal: 1, quiet: 1 });
    return { ...b, clock, mono };
  }

  it("six hours and a minute go by and the wall clock steps back six hours: every pass runs again", async () => {
    const b = await launched();
    b.mono.skewMs += 6 * HOUR + MIN;
    b.clock.skewMs += MIN;                       // +6 h 1 min elapsed, then the clock stepped back 6 h
    await b.cycle();
    expect(runs(), "a pass was skipped for the length of the clock's step").toEqual({ retro: 2, heal: 2, quiet: 2 });
  });

  it("an hour and a minute go by and the wall clock steps back an hour: the correspondent retro runs", async () => {
    const b = await launched();
    b.mono.skewMs += HOUR + MIN;
    b.clock.skewMs += MIN;
    await b.cycle();
    expect(runs().retro, "mail held from people this account wrote to stayed held for the step").toBe(2);
  });

  /* A SUSPEND: the monotonic clock does not count the sleep, the wall clock does. The reviewer's
     case (LOW 1), red on the monotonic clock alone. */
  it("eight hours asleep (wall +8 h, monotonic +1 min): every pass is owed on the first drain after wake", async () => {
    const b = await launched();
    b.mono.skewMs += MIN;
    b.clock.skewMs += 8 * HOUR + MIN;
    await b.cycle();
    expect(runs(), "a pass was skipped for the length of the suspend").toEqual({ retro: 2, heal: 2, quiet: 2 });
  });

  it("CONTROL: with no step every pass runs at its interval", async () => {
    const b = await launched();
    b.mono.skewMs += 6 * HOUR + MIN;
    b.clock.skewMs += 6 * HOUR + MIN;
    await b.cycle();
    expect(runs()).toEqual({ retro: 2, heal: 2, quiet: 2 });
  });

  it("CONTROL: inside its interval no pass runs again", async () => {
    const b = await launched();
    b.mono.skewMs += 30 * MIN;
    b.clock.skewMs += 30 * MIN;
    await b.cycle();
    expect(runs()).toEqual({ retro: 1, heal: 1, quiet: 1 });
  });
});

describe("a stop under a wall clock stepped back an hour", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
    resetFirstPageGate();
  });

  it("settledWithin gives up at its bound when the clock steps back inside it", async () => {
    const skew = { ms: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew.ms);
    const t = performance.now();
    const step = setTimeout(() => { skew.ms -= HOUR; }, 100);
    const waiting = settledWithin(new Promise(() => {}), 300);
    const late = new Promise<"late">((r) => { setTimeout(() => r("late"), 3_000).unref?.(); });
    const answer = await Promise.race([waiting, late]);
    clearTimeout(step);
    expect(answer, "the bounded wait waited out the clock's step").toBe(false);
    expect(performance.now() - t).toBeLessThan(1_500);
  });

  it("a mailbox stopped over a wedged drain lets go within one drain interval despite the step", async () => {
    const BOUND_MS = 1_500;
    const clock = { skewMs: 0 };
    const r = rig(server([[1, ordinary("one")]]));
    const wedge = { on: false };
    const factory: typeof r.factory = (cfg, ctx) => {
      const a = r.factory(cfg, ctx);
      const changesSince: MailboxAdapter["changesSince"] = (c) => (wedge.on ? new Promise(() => {}) : a.changesSince(c));
      return Object.assign(a, { changesSince });
    };
    const b = await boot({ ...r, factory }, clock, cleanups, { pollIntervalMs: BOUND_MS });
    await b.cycle();
    wedge.on = true;
    void b.cycle();
    await new Promise((res) => setTimeout(res, 200));   // the drain is inside the wedged read
    const t = performance.now();
    setTimeout(() => { clock.skewMs -= HOUR; }, BOUND_MS / 2);
    const forced = (): boolean => b.events.some((e) => e.event === "mailbox_detach_forced");
    const stopping = b.sidecar.stop().catch(() => undefined);
    while (!forced() && performance.now() - t < BOUND_MS + 5_000) await new Promise((res) => setTimeout(res, 25));
    expect(forced(), "the stop waited out the clock's step instead of its own bound").toBe(true);
    expect(performance.now() - t).toBeLessThan(BOUND_MS + 1_000);
    const forcedLine = b.events.find((e) => e.event === "mailbox_detach_forced")!;
    expect(forcedLine.detail.totalMs as number, "the forced line measured the step, not the stop").toBeLessThan(BOUND_MS + 1_000);
    await stopping;
  });
});
