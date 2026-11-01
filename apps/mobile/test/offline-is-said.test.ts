/**
 * AN OFFLINE PHONE SAYS SO, AND CATCHES UP AT ONCE WHEN IT IS BACK.
 *
 * Measured on Android 0.25.1, paired: in airplane mode the Ohbox kept its unread count with no
 * word about the network, a pull changed nothing, search said "Your server did not answer", and
 * back online "As of Sat 08:49" stood for 30-50 s — the cadence was sitting out a failure backoff
 * of up to a minute. Every reading here goes through the network door (`src/net/network-door.ts`)
 * with a fake reader; the catch-up is driven through the composition the app runs — `bootEngine`
 * over the loopback mail server, the `SyncRunner`, the cadence on a hand-turned clock.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { Copy } from "../src/copy";
import { SyncRunner } from "../src/net/drain";
import { DRAIN_BACKOFF_CAP_MS, keepDraining, type AppLifecycle, type CadenceTimers } from "../src/net/drain-cadence";
import {
  installNetworkReader, networkDoor, networkNow, type NetworkReader, type NetworkState, type NetworkWatch,
} from "../src/net/network-door";
import { pullRound } from "../src/state/pull-round";
import { topLineSaid, unansweredSaid } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" };
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); installNetworkReader(null); });

/** A platform reader the test moves. */
function platform(initial: unknown) {
  let now = initial;
  const ls = new Set<(r: unknown) => void>();
  const reader: NetworkReader = { read: () => now, subscribe: (l) => { ls.add(l); return () => { ls.delete(l); }; } };
  return { reader, move: (next: unknown) => { now = next; for (const l of ls) l(next); } };
}

describe("the door reads the platform, and nothing else", () => {
  it("follows the reader, and anything but its two words is unknown", () => {
    const p = platform("online");
    installNetworkReader(p.reader);
    expect(networkNow()).toBe("online");
    p.move("offline");
    expect(networkNow()).toBe("offline");
    p.move("wifi");
    expect(networkNow()).toBe("unknown");
  });

  it("no reader, or one that throws, is unknown — never a guess", () => {
    installNetworkReader(null);
    expect(networkNow()).toBe("unknown");
    installNetworkReader({ read: () => { throw new Error("no module"); }, subscribe: () => () => undefined });
    expect(networkNow()).toBe("unknown");
  });
});

describe("offline is said where the person looks", () => {
  const base = { connection: null, stale: null, draining: false, continuing: null } as const;

  it("the top line names the network, over the age and over the connection", () => {
    expect(topLineSaid({ ...base, network: "offline" })?.text).toBe(Copy.networkOffline);
    expect(topLineSaid({ ...base, network: "offline", stale: "Sat 08:49" })?.text).toBe(Copy.networkOffline);
    expect(topLineSaid({ ...base, network: "offline", connection: { kind: "lost" } })?.text).toBe(Copy.networkOffline);
    expect(Copy.networkOffline).toMatch(/no network/);
  });

  it("online or unknown, the line is what it was — the positive control", () => {
    for (const network of ["online", "unknown"] as const) {
      expect(topLineSaid({ ...base, network })).toBeNull();
      expect(topLineSaid({ ...base, network, stale: "Sat 08:49" })?.text).toBe(Copy.staleAsOfIdle("Sat 08:49"));
      expect(topLineSaid({ ...base, network, connection: { kind: "lost" } })?.text).toBe(Copy.connectionLost);
    }
  });

  it("the top bar renders that ranking, off the door", () => {
    const chrome = read("../src/ui/chrome.tsx");
    expect(chrome).toContain("topLineSaid({");
    expect(chrome).toContain("network: useNetworkNow()");
  });

  it("a pull while offline says it and asks nothing; online it rings the round", async () => {
    const said: string[] = [];
    let rung = 0;
    const ring = async (): Promise<void> => { rung += 1; };
    await pullRound("offline", ring, (r) => said.push(r.say));
    expect(rung).toBe(0);
    expect(said).toEqual(["networkOffline"]);
    await pullRound("online", ring, (r) => said.push(r.say));
    await pullRound("unknown", ring, (r) => said.push(r.say));
    expect(rung).toBe(2);
    expect(said).toEqual(["networkOffline"]);
    expect(read("../src/state/pull.ts")).toContain("pullRound(networkNow(),");
  });

  it("search and History name the phone's network when that is the cause, the server otherwise", () => {
    expect(unansweredSaid("offline", "search")).toBe(Copy.networkOfflineHeld);
    expect(unansweredSaid("offline", "history")).toBe(Copy.networkOfflineHeld);
    expect(unansweredSaid("online", "search")).toBe(Copy.searchUnanswered);
    expect(unansweredSaid("unknown", "history")).toBe(Copy.historyStoreUnavailable);
    expect(Copy.networkOfflineHeld).not.toMatch(/server/i);
    // A search the server answered with a fault could not run there; an outage and a timeout did not answer.
    expect(unansweredSaid("online", "search", "MutationRejectedError 500 internal")).toBe(Copy.searchFailed);
    expect(unansweredSaid("offline", "search", "MutationRejectedError 500 internal")).toBe(Copy.networkOfflineHeld);
    for (const cause of ["MutationRejectedError 504 server_error", "MutationRejectedError 503", "timeout", "TypeError", null]) {
      expect(unansweredSaid("online", "search", cause)).toBe(Copy.searchUnanswered);
    }
    expect(unansweredSaid("online", "history", "MutationRejectedError 500 internal")).toBe(Copy.historyStoreUnavailable);
    expect(read("../app/search.tsx")).toContain('unansweredSaid(network, "search", store.cause)');
    expect(read("../app/history.tsx")).toContain('unansweredSaid(network, "history")');
  });
});

/* ── back online: the catch-up bound ────────────────────────────────────────────────────── */

function handClock() {
  let seq = 0;
  const due = new Map<number, { ms: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { ms, fn }); return seq; },
    clear: (h) => { due.delete(h as number); },
  };
  return {
    timers,
    pending: (): number[] => [...due.values()].map((d) => d.ms),
    advance: (ms: number): void => {
      for (const [id, d] of [...due.entries()]) if (d.ms <= ms) { due.delete(id); d.fn(); }
    },
  };
}
const active: AppLifecycle = { now: () => "active", subscribe: () => () => undefined };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The door as the cadence holds it, over a platform the test moves. */
function watched(initial: NetworkState): { watch: NetworkWatch; move: (s: NetworkState) => void } {
  const p = platform(initial);
  installNetworkReader(p.reader);
  return { watch: networkDoor, move: p.move };
}

async function pairedPhone() {
  const fake = mailServer();
  fake.addMessage(dto("m-old", { date: new Date(Date.now() - 60_000).toISOString() }));
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  cleanups.push(() => { boot.store.close(); fake.server.close(); });
  await boot.verifyIdentity();
  const runner = new SyncRunner({ syncing: () => undefined, error: () => undefined });
  await runner.run(boot.engine, true);
  const syncs = (): number => fake.seen.filter((r) => r.method === "GET" && r.url.startsWith("/sync")).length;
  const round = (): Promise<number> => runner.request(boot.engine).then(() => runner.failures());
  const landed = async (): Promise<void> => { await tick(); await runner.inFlight(); await tick(); await tick(); };
  const has = (id: string): boolean => boot.engine.read().get("message", id) !== undefined;
  return { fake, runner, syncs, round, landed, has };
}

describe("back online, the phone catches up at once", () => {
  it("offline asks nothing as the clock turns; the return drains with no clock turned", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const net = watched("offline");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: active, timers: clock.timers, network: net.watch }));
    const asked = phone.syncs();
    clock.advance(60_000);
    await phone.landed();
    expect(phone.syncs(), "an offline phone dialled its server").toBe(asked);

    phone.fake.addMessage(dto("m-back", { date: new Date().toISOString() }));
    net.move("online");
    expect(phone.runner.inFlight(), "the return did not drain at once").not.toBeNull();
    await phone.landed();
    expect(phone.has("m-back"), "the mail that arrived meanwhile was not fetched on the return").toBe(true);
  });

  it("a return inside a minute's backoff does not wait it out", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const net = watched("unknown");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: active, timers: clock.timers, network: net.watch }));
    for (let i = 0; i < 6; i += 1) {
      phone.fake.failNextStatus("GET", "/sync", 503);
      clock.advance(DRAIN_BACKOFF_CAP_MS);
      await phone.landed();
    }
    expect(clock.pending(), "the backoff did not reach its cap").toEqual([DRAIN_BACKOFF_CAP_MS]);
    net.move("offline");
    phone.fake.addMessage(dto("m-late", { date: new Date().toISOString() }));
    net.move("online");
    expect(phone.runner.inFlight(), "the return waited out the backoff").not.toBeNull();
    await phone.landed();
    expect(phone.has("m-late")).toBe(true);
  });
});
