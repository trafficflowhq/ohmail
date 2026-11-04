/**
 * AN OPEN PHONE KEEPS DRAINING (`src/net/drain-cadence.ts`) — driven through the composition the app
 * runs: the real engine from `bootEngine` over the loopback mail server, the connection layer's
 * `SyncRunner`, and the cadence on a hand-turned clock and a fake lifecycle. The defect: after the
 * adoption's one drain nothing drained again until a press, so mail the server listed a minute later
 * stayed absent on an open phone. Watched RED: the base composition (first drain only) leaves the
 * arrival absent; dropping the re-arm after a settle fails the second-arrival case.
 */
import { afterEach, describe, expect, it } from "vitest";
import { classifyWindowSyncFailure, lastCheckedAt } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { SyncRunner, drainLine } from "../src/net/drain";
import {
  DRAIN_BACKOFF_CAP_MS, FOREGROUND_DRAIN_MS, IDLE_DRAIN_CAP_MS, idleSpacing, keepDraining, nextDrainDelay, nextIdleDelay,
  type AppLifecycle, type CadenceTimers,
} from "../src/net/drain-cadence";
import { appActivity, noteActivity } from "../src/net/activity";
import { readFoldersEnabled } from "../src/net/consent";
import { readMailboxes } from "../src/net/mailboxes";
import type { ConnectedSession } from "../src/net/pairing";
import { readScreenerQueue } from "../src/net/screener";
import { FACTS_REREAD_MS, drainReads } from "../src/state/drain-reads";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: () => "00000000-0000-4000-8000-000000000000",
};

/** A clock the test turns: nothing fires until {@link advance} or {@link fireNext}. */
function handClock() {
  let seq = 0;
  const due = new Map<number, { ms: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { ms, fn }); return seq; },
    clear: (handle) => { due.delete(handle as number); },
  };
  return {
    timers,
    pending: (): number[] => [...due.values()].map((d) => d.ms),
    /** Turn the clock by `ms`: fire every timer due within it, answering how many fired. */
    advance: (ms: number): number => {
      const hit = [...due.entries()].filter(([, d]) => d.ms <= ms);
      for (const [id, d] of hit) { due.delete(id); d.fn(); }
      return hit.length;
    },
    fireNext: (): number => {
      const first = [...due.entries()][0];
      if (first === undefined) throw new Error("no timer armed");
      due.delete(first[0]);
      first[1].fn();
      return first[1].ms;
    },
  };
}

/** React Native's `AppState`, as a value the test moves. */
function lifecycle(initial: string) {
  let status = initial;
  const listeners = new Set<(s: string) => void>();
  const source: AppLifecycle = {
    now: () => status,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { source, move: (next: string) => { status = next; for (const l of listeners) l(next); } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** A paired phone after its adoption: the first drain settled, the runner and its lines in hand. */
async function pairedPhone() {
  const fake = mailServer();
  fake.addMessage(dto("m-old", { date: new Date(Date.now() - 60_000).toISOString() }));
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  cleanups.push(() => { boot.store.close(); fake.server.close(); });
  await boot.verifyIdentity();
  const lines: string[] = [];
  const runner = new SyncRunner({
    syncing: () => undefined,
    error: () => undefined,
    settled: (o) => lines.push(drainLine(o, "paired", classifyWindowSyncFailure)),
  });
  await runner.run(boot.engine, true);
  const has = (id: string): boolean => boot.engine.read().get("message", id) !== undefined;
  const syncs = (): number => fake.seen.filter((r) => r.method === "GET" && r.url.startsWith("/sync")).length;
  const round = (): Promise<number> => runner.request(boot.engine).then(() => runner.failures());
  /** Let a fired round reach the wire, land, and re-arm. */
  const landed = async (): Promise<void> => { await settle(); await runner.inFlight(); await settle(); await settle(); };
  return { fake, boot, runner, lines, has, syncs, round, landed, origin };
}

/** A clock that keeps time: each timer fires at its own instant, in order. */
function simClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { at: now + ms, fn }); return seq; },
    clear: (handle) => { due.delete(handle as number); },
  };
  return {
    timers,
    now: () => now,
    /** Milliseconds until the next armed timer, or null. */
    next: (): number | null => {
      const ats = [...due.values()].map((d) => d.at);
      return ats.length === 0 ? null : Math.min(...ats) - now;
    },
    /** Fire the earliest timer due by `until`; false (and the clock at `until`) when none is. */
    step: (until: number): boolean => {
      const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (first === undefined || first[1].at > until) { now = until; return false; }
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
      return true;
    },
  };
}

/**
 * The app's composition of one round, as `connection.tsx` and `world.tsx` wire it: the drain, then
 * the drain read the world fires when the round settles (the queue every round; the mailboxes and
 * the consent answer when due), on the mirror's stamp and the clock.
 */
async function idlePhone() {
  const phone = await pairedPhone();
  const clock = simClock();
  const session = {
    profile: { origin: phone.origin },
    engine: phone.boot.engine,
    store: phone.boot.store,
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
  const reading = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): void => { reading.add(p); void p.finally(() => reading.delete(p)); };
  const reads = drainReads({
    rest: [() => track(readScreenerQueue(session))],
    facts: [() => track(readMailboxes(session))],
    consent: () => readFoldersEnabled(session),
    engine: phone.boot.engine,
    stamp: () => phone.boot.store.version(),
    now: clock.now,
  });
  /** Where each round began in the server's request log. */
  const starts: number[] = [];
  const round = (): Promise<number> => {
    starts.push(phone.fake.seen.length);
    return phone.runner.request(phone.boot.engine).then(async () => {
      track(reads());
      return phone.runner.failures();
    });
  };
  const landed = async (): Promise<void> => {
    await phone.landed();
    while (reading.size > 0) await Promise.all([...reading]);
    await settle();
  };
  // The session's own reads before the cadence: at adoption, and as the adoption's drain settles
  // (the queue page it asked the engine for moves the mirror once). Settled = a read moved nothing.
  for (let i = 0, was = -1; i < 5 && was !== phone.boot.store.version(); i++) {
    was = phone.boot.store.version();
    track(reads());
    await landed();
  }
  const route = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;
  /** Requests per route in each round so far. */
  const perRound = (): Array<Record<string, number>> => starts.map((from, i) => {
    const out: Record<string, number> = {};
    for (const r of phone.fake.seen.slice(from, starts[i + 1] ?? phone.fake.seen.length)) out[route(r)] = (out[route(r)] ?? 0) + 1;
    return out;
  });
  const asked = (key: string, from = 0): number => phone.fake.seen.slice(from).filter((r) => route(r) === key).length;
  /** Run the cadence on the clock until `until`, letting each round land. */
  const runTo = async (until: number): Promise<void> => {
    while (clock.step(until)) await landed();
  };
  return { ...phone, clock, round, landed, perRound, asked, runTo };
}

const arrival = (id: string) => dto(id, { date: new Date().toISOString() });

describe("an open, foreground, paired phone keeps draining", () => {
  it("fetches a server-side arrival within the interval, untouched — and the next one after it", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));

    phone.fake.addMessage(arrival("m-new"));
    expect(phone.has("m-new"), "the arrival was in the mirror before any round").toBe(false);
    clock.advance(FOREGROUND_DRAIN_MS);
    await phone.landed();
    expect(phone.has("m-new"), "mail the server listed was not fetched within the interval").toBe(true);

    // AND AGAIN: the cadence re-arms after every settle, not once.
    phone.fake.addMessage(arrival("m-newer"));
    clock.advance(FOREGROUND_DRAIN_MS);
    await phone.landed();
    expect(phone.has("m-newer"), "the cadence drained once and stopped").toBe(true);
    expect(clock.pending(), "the next round is not on the cadence").toEqual([FOREGROUND_DRAIN_MS]);
    expect(phone.lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: true },
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: false },
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: false },
    ]);
  });

  it("the base composition — the adoption's drain alone — never fetches it (the defect, as a control)", async () => {
    const phone = await pairedPhone();
    phone.fake.addMessage(arrival("m-new"));
    const before = phone.syncs();
    // Nothing in the harness but the cadence asks the server, so without it nothing moves.
    await new Promise((r) => setTimeout(r, 50));
    expect(phone.syncs()).toBe(before);
    expect(phone.has("m-new")).toBe(false);
  });
});

describe("no timer runs in the background; the foreground drains at once", () => {
  it("backgrounded before the cadence starts: nothing armed, nothing asked", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("background");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    expect(clock.pending(), "a backgrounded app held a drain timer").toEqual([]);
    app.move("inactive");
    expect(clock.pending()).toEqual([]);
  });

  it("leaving the foreground clears the timer; coming back drains now and re-arms", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    expect(clock.pending()).toEqual([FOREGROUND_DRAIN_MS]);

    app.move("background");
    expect(clock.pending(), "the drain timer outlived the foreground").toEqual([]);
    const asked = phone.syncs();
    phone.fake.addMessage(arrival("m-away"));
    await settle();
    expect(phone.syncs(), "a backgrounded app asked the server").toBe(asked);

    app.move("active");
    expect(phone.runner.inFlight(), "the return to the foreground did not drain at once").not.toBeNull();
    await phone.landed();
    expect(phone.has("m-away")).toBe(true);
    expect(clock.pending()).toEqual([FOREGROUND_DRAIN_MS]);
  });

  it("stop ends it: no timer, and a later return to the foreground drains nothing", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    const stop = keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers });
    stop();
    expect(clock.pending()).toEqual([]);
    app.move("background");
    app.move("active");
    expect(phone.runner.inFlight()).toBeNull();
  });
});

describe("a failing round backs off and says why, content-free", () => {
  it("the ladder: the cadence, then doubling per failure to the cap", () => {
    expect(nextDrainDelay(0)).toBe(FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(1)).toBe(FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(2)).toBe(2 * FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(3)).toBe(4 * FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(4)).toBe(DRAIN_BACKOFF_CAP_MS);
    expect(nextDrainDelay(40)).toBe(DRAIN_BACKOFF_CAP_MS);
  });

  it("a refused round writes cloud_pull_failed with the engine's closed record, then waits longer", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    for (let i = 0; i < 4; i++) phone.fake.failNextStatus("GET", "/sync", 503);
    clock.fireNext();
    await phone.landed();
    expect(phone.runner.failures()).toBeGreaterThanOrEqual(1);
    const failed = JSON.parse(phone.lines.at(-1)!) as Record<string, unknown>;
    expect(failed).toMatchObject({ service: "sync", event: "cloud_pull_failed", door: "paired", first: false });
    // The whole line is closed fields: no message text, no id, no address can ride it.
    expect(Object.keys(failed).every((k) =>
      ["service", "event", "door", "first", "attempt", "reason", "errorClass", "status", "code"].includes(k))).toBe(true);
    expect(clock.pending()).toEqual([nextDrainDelay(phone.runner.failures())]);
  });
});

describe("an idle foreground phone asks the server less, and a touch brings it back", () => {
  it("the ladder: the cadence, then doubling per idle round to the idle cap", () => {
    expect([0, 1, 2, 3, 9].map((n) => nextIdleDelay(n))).toEqual([
      FOREGROUND_DRAIN_MS, 2 * FOREGROUND_DRAIN_MS, 4 * FOREGROUND_DRAIN_MS, IDLE_DRAIN_CAP_MS, IDLE_DRAIN_CAP_MS,
    ]);
  });

  it("an idle minute: at most one request per route per round, the consent not re-asked, rounds spacing out", async () => {
    const phone = await idlePhone();
    const app = lifecycle("active");
    cleanups.push(keepDraining({
      round: phone.round, lifecycle: app.source, timers: phone.clock.timers, clock: phone.clock.now,
      changes: () => phone.boot.store.version(), activity: appActivity,
    }));
    const from = phone.fake.seen.length;
    await phone.runTo(60_000);
    const rounds = phone.perRound();
    for (const [i, r] of rounds.entries()) {
      for (const [key, n] of Object.entries(r)) expect(n, `round ${i} asked ${key} ${n} times`).toBe(1);
    }
    // 8 s, 16 s, 32 s: the fourth would be at 64 s. The 8 s cadence asked seven times.
    expect(phone.asked("GET /sync", from)).toBe(3);
    expect(phone.asked("GET /screener", from)).toBe(3);
    // Once, at 32 s: the Ohbox's "Checked" line needs the mailboxes younger than 90 s.
    expect(phone.asked("GET /mailboxes", from)).toBe(1);
    expect(phone.asked("GET /consent", from), "an idle mirror re-asked the consent answer").toBe(0);
    expect(phone.clock.next()).toBe(64_000 - 60_000);
  });

  it("a change shows within one round of a touch, where the idle spacing alone would not", async () => {
    const phone = await idlePhone();
    const app = lifecycle("active");
    cleanups.push(keepDraining({
      round: phone.round, lifecycle: app.source, timers: phone.clock.timers, clock: phone.clock.now,
      changes: () => phone.boot.store.version(), activity: appActivity,
    }));
    await phone.runTo(64_000);
    expect(phone.clock.next(), "the spacing did not reach the idle cap").toBe(IDLE_DRAIN_CAP_MS);

    phone.fake.addMessage(arrival("m-touch"));
    await phone.runTo(64_000 + FOREGROUND_DRAIN_MS);
    expect(phone.has("m-touch"), "an idle round came early").toBe(false);
    noteActivity();
    expect(phone.clock.next(), "the touch did not end the idle spacing").toBe(FOREGROUND_DRAIN_MS);
    const before = phone.fake.seen.length;
    await phone.runTo(64_000 + 2 * FOREGROUND_DRAIN_MS);
    expect(phone.has("m-touch"), "the change did not show within one round of the touch").toBe(true);
    // The change moved the mirror: the facts are asked once, and the cadence stays at its pace.
    expect(phone.asked("GET /consent", before)).toBe(1);
    expect(phone.asked("GET /mailboxes", before)).toBe(1);
    expect(phone.clock.next()).toBe(FOREGROUND_DRAIN_MS);
    // A touch at the plain cadence moves nothing.
    noteActivity();
    expect(phone.clock.next()).toBe(FOREGROUND_DRAIN_MS);
  });

  it("the Ohbox's Checked line holds through an idle five minutes; the consent answer keeps its minutes", async () => {
    const clock = simClock();
    const asks = { rounds: 0, mailboxes: 0, consent: 0 };
    let readAt: number | null = null;
    const reads = drainReads({
      rest: [],
      facts: [() => { asks.mailboxes += 1; readAt = clock.now(); }],
      consent: async () => { asks.consent += 1; return { on: false }; },
      engine: { refreshScreenerWaiting: async () => undefined, refreshUnscreened: async () => undefined },
      stamp: () => 1,
      now: clock.now,
    });
    await reads();
    const app = lifecycle("active");
    cleanups.push(keepDraining({
      round: async () => { asks.rounds += 1; await reads(); return 0; },
      lifecycle: app.source, timers: clock.timers, clock: clock.now, changes: () => 1, activity: appActivity,
    }));
    const rows = [{ status: "connected", lastSyncAt: new Date(0).toISOString() }];
    const lapsed: number[] = [];
    for (let s = 1; s <= FACTS_REREAD_MS / 1000; s++) {
      while (clock.step(s * 1000)) await settle();
      if (lastCheckedAt(rows, readAt, clock.now()) === null) lapsed.push(s);
    }
    expect(lapsed, "the Checked line lapsed at these seconds").toEqual([]);
    // Rounds at 8, 16, 32, 64, 124, 184 and 244 s; the mailboxes from 32 s on, one per round.
    expect(asks).toEqual({ rounds: 7, mailboxes: 6, consent: 1 });
  });

  it("the standalone phone keeps the plain cadence: no server to spare, and its organizer files on its own timer", async () => {
    const ticks = async (standalone: boolean): Promise<number[]> => {
      const clock = simClock();
      const at: number[] = [];
      const app = lifecycle("active");
      cleanups.push(keepDraining({
        round: async () => { at.push(clock.now() / 1000); return 0; },
        lifecycle: app.source, timers: clock.timers, clock: clock.now,
        ...idleSpacing({ standalone, store: { version: () => 1 } }, appActivity),
      }));
      while (clock.step(60_000)) await settle();
      return at;
    };
    expect(await ticks(true)).toEqual([8, 16, 24, 32, 40, 48, 56]);
    expect(await ticks(false)).toEqual([8, 16, 32]);
  });

  it("coming back to the front resets the spacing as well", async () => {
    const phone = await idlePhone();
    const app = lifecycle("active");
    cleanups.push(keepDraining({
      round: phone.round, lifecycle: app.source, timers: phone.clock.timers, clock: phone.clock.now,
      changes: () => phone.boot.store.version(),
    }));
    await phone.runTo(64_000);
    app.move("background");
    app.move("active");
    await phone.landed();
    expect(phone.clock.next()).toBe(FOREGROUND_DRAIN_MS);
  });
});
