/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceUpdate,
  askDue,
  ASK_MEMORY_KEY,
  buildToken,
  currentUpdateOffer,
  flushBeforeRestart,
  holdFilesForRestart,
  holdForRestart,
  offerKey,
  periodElapsed,
  readAskMemory,
  rememberAsk,
  resetUpdateStoreForTests,
  RESTART_FLUSH_MS,
  restartHold,
  setSendWaits,
  subscribeRestartHold,
  subscribeUpdateOffer,
  UPDATE_PERIOD_MS,
  writeAskMemory,
  type AskMemory,
  type RestartHold,
} from "../app/shell/app-update";

/**
 * ═══ HOW OFTEN THE APP MAY SAY "THERE IS A NEWER OHMAIL" ════════════════════════════════════
 *
 * The two doors — a tab comparing builds, a desktop app asking a signed release feed — share no
 * mechanism and all of their restraint. This is the restraint, driven directly: a day is a day
 * measured on a wall clock, an offer is put in front of somebody at most once a day, and a
 * different release is a different question rather than the same one repeated.
 *
 * Every interval is asserted at BOTH ends. "Fires after a day" is half a guard: a rule that
 * fired at twenty-three hours would pass it, and the failure it describes — an app that speaks
 * again before the day is up — is precisely the nagging the period exists to prevent.
 */

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-09-03T09:00:00Z");

afterEach(() => {
  resetUpdateStoreForTests();
  window.localStorage.clear();
});

describe("the day, measured on a wall clock", () => {
  it("is a full day — 23 hours is not elapsed, 24 is", () => {
    expect(periodElapsed(START, START + 23 * HOUR)).toBe(false);
    expect(periodElapsed(START, START + 24 * HOUR)).toBe(true);
    expect(periodElapsed(START, START + 24 * HOUR - 1)).toBe(false);
  });

  it("SURVIVES A SUSPENDED MACHINE, because it never counts firings", () => {
    // A laptop shut on Thursday evening and opened on Saturday morning fires no timer in
    // between. Nothing here cares: the first question asked after it wakes compares two
    // instants and sees the true gap. A cadence built on a tick count would answer "not yet"
    // here and wait another whole day, which is the case a daily check exists for.
    expect(periodElapsed(START, START + 36 * HOUR)).toBe(true);
  });

  it("never happened is elapsed — overdue, not early", () => {
    expect(periodElapsed(null, START)).toBe(true);
    expect(periodElapsed(undefined, START)).toBe(true);
  });

  it("A STAMP IN THE FUTURE IS ELAPSED, which is the clock-moved-backwards guard", () => {
    // Wall clocks move backwards: a machine correcting its clock, a person setting it by hand,
    // a virtual machine restored from a snapshot. A plain `now - since >= period` would then
    // answer "not yet" for as long as the jump was large — a year of a mail client never once
    // looking for its own update, with nothing anywhere saying so.
    expect(periodElapsed(START + 365 * 24 * HOUR, START)).toBe(true);
  });

  it("a stamp that is not a number is nothing remembered", () => {
    expect(periodElapsed(Number.NaN, START)).toBe(true);
  });
});

describe("once a day, per thing being offered", () => {
  it("speaks, then stays quiet for the rest of the day, then speaks again", () => {
    let memory: AskMemory = {};
    expect(askDue(memory, "restart:0.15.0", START)).toBe(true);
    memory = rememberAsk(memory, "restart:0.15.0", START);

    expect(askDue(memory, "restart:0.15.0", START + HOUR)).toBe(false);
    expect(askDue(memory, "restart:0.15.0", START + 23 * HOUR)).toBe(false);
    expect(askDue(memory, "restart:0.15.0", START + UPDATE_PERIOD_MS)).toBe(true);
  });

  it("A NEWER RELEASE IS A DIFFERENT QUESTION, and is not silenced by the older one", () => {
    // The promise is "once a day per version", not "once a day". Someone told about 0.15.0 this
    // morning and offered 0.15.1 this afternoon should hear about it — a fix that shipped
    // because the first one was broken is exactly the case that must not be swallowed.
    const memory = rememberAsk({}, "ready:0.15.0", START);
    expect(askDue(memory, "ready:0.15.0", START + HOUR)).toBe(false);
    expect(askDue(memory, "ready:0.15.1", START + HOUR)).toBe(true);
  });

  it("the key is the release, and a kind with no version is its own key", () => {
    expect(offerKey({ kind: "ready", version: "0.15.0" })).toBe("ready:0.15.0");
    expect(offerKey({ kind: "reload", version: "8f2ac091" })).toBe("reload:8f2ac091");
    expect(offerKey({ kind: "failed" })).toBe("failed");
  });

  it("forgets entries that can no longer change a decision", () => {
    // Every release this device is ever offered would otherwise add a permanent key to a store
    // a browser may refuse to write when it is full. An entry older than two periods can only
    // ever answer "due", so dropping it changes nothing and keeps the store small.
    const old = { "ready:0.1.0": START - 3 * UPDATE_PERIOD_MS, "ready:0.14.0": START - HOUR };
    const kept = rememberAsk(old, "ready:0.15.0", START);
    expect(Object.keys(kept).sort()).toEqual(["ready:0.14.0", "ready:0.15.0"]);
  });
});

describe("the device's memory of what it has already said", () => {
  it("round-trips, and an unreadable jar reads as nothing remembered", () => {
    writeAskMemory({ "restart:0.15.0": START });
    expect(readAskMemory()).toEqual({ "restart:0.15.0": START });

    window.localStorage.setItem(ASK_MEMORY_KEY, "not json at all");
    expect(readAskMemory()).toEqual({});

    // …and so does a shape that is JSON but is not a memory. Nothing remembered only ever
    // makes the app SPEAK, which is the safe direction for a rule about restraint to fail in.
    window.localStorage.setItem(ASK_MEMORY_KEY, JSON.stringify(["restart:0.15.0"]));
    expect(readAskMemory()).toEqual({});
    window.localStorage.setItem(ASK_MEMORY_KEY, JSON.stringify({ "restart:0.15.0": "yesterday" }));
    expect(readAskMemory()).toEqual({});
  });
});

describe("the build token", () => {
  it("is the same for one build and different for the next", () => {
    expect(buildToken("0.15.0", "abc1234")).toBe(buildToken("0.15.0", "abc1234"));
    expect(buildToken("0.15.0", "abc1234")).not.toBe(buildToken("0.15.0", "def5678"));
  });

  it("MOVES ON A RELEASE ALONE, which is the deployment that has no commit to name", () => {
    // An image built from a tarball reports its sha as "dev" for ever. Without the release
    // number folded in, every such deployment would carry one token for its whole life and no
    // tab on a self-hosted server would ever be told that the server had been upgraded.
    expect(buildToken("0.15.0", "dev")).not.toBe(buildToken("0.15.1", "dev"));
  });

  it("is not the commit — the reader compares names, it does not learn one", () => {
    const token = buildToken("0.15.0", "9f3c1d2e4b5a6789");
    expect(token).toMatch(/^[0-9a-f]{8}$/);
    expect(token).not.toContain("9f3c1d2e");
  });

  it("answers something for a build that states nothing", () => {
    expect(buildToken(undefined, undefined)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("the one offer, and everyone who reads it", () => {
  it("tells every subscriber, and lets each one leave", () => {
    const seen: Array<string | null> = [];
    const off = subscribeUpdateOffer((next) => seen.push(next?.kind ?? null));
    announceUpdate({ kind: "reload" });
    expect(currentUpdateOffer()?.kind).toBe("reload");
    off();
    announceUpdate(null);
    expect(seen).toEqual(["reload"]);
    expect(currentUpdateOffer()).toBeNull();
  });

  it("withdrawing nothing tells nobody", () => {
    let told = 0;
    subscribeUpdateOffer(() => { told += 1; });
    announceUpdate(null);
    expect(told).toBe(0);
  });
});

describe("what a restart waits for", () => {
  it("every open editor's save, and only while it is open", async () => {
    const saved: string[] = [];
    const off = holdForRestart(async () => void saved.push("compose"));
    holdForRestart(async () => void saved.push("reply"));
    await flushBeforeRestart();
    expect(saved.sort()).toEqual(["compose", "reply"]);
    off();
    await flushBeforeRestart();
    expect(saved.filter((s) => s === "compose"), "a closed editor was saved again").toHaveLength(1);
  });

  it("never past its bound: a save that hangs costs the account copy, not the restart", async () => {
    vi.useFakeTimers();
    holdForRestart(() => new Promise(() => {}));
    let done = false;
    void flushBeforeRestart().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(RESTART_FLUSH_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("a save that throws does not stop the restart", async () => {
    holdForRestart(async () => { throw new Error("refused"); });
    await expect(flushBeforeRestart()).resolves.toBeUndefined();
  });

  it("an editor's files hold it until every holder lets go, and a waiting send is named first", () => {
    const told: RestartHold[] = [];
    subscribeRestartHold((hold) => told.push(hold));
    expect(restartHold()).toBeNull();
    const compose = holdFilesForRestart();
    const reply = holdFilesForRestart();
    expect(restartHold()).toBe("files");
    compose();
    compose();
    expect(restartHold(), "one editor letting go twice freed the other's files").toBe("files");
    setSendWaits(true);
    expect(restartHold()).toBe("send");
    reply();
    setSendWaits(false);
    expect(restartHold()).toBeNull();
    expect(told, "each change told once").toEqual(["files", "send", null]);
  });
});
