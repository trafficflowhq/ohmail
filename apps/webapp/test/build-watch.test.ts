/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceUpdate,
  currentUpdateOffer,
  offerKey,
  readAskMemory,
  resetUpdateStoreForTests,
  UPDATE_PERIOD_MS,
} from "@ohmail/app-logic/doors/app-update";
import {
  BUILD_MIN_GAP_MS,
  BUILD_PATH,
  BUILD_POLL_MS,
  servedTokenOf,
  startBuildWatch,
} from "@ohmail/app-logic/doors/build-watch";

/**
 * ═══ A TAB THAT IS NO LONGER THE APP THIS ORIGIN SERVES ══════════════════════════════════════
 *
 * A browser client is downloaded once and then left running, and mail is the archetype of a
 * program people leave open for weeks. Nothing about a deployment tells the tabs already open
 * that they are looking at an older program: the app keeps working, against a server that has
 * moved on, until something it calls answers a shape it does not know.
 *
 * So the tab asks the origin which build it is serving and compares it with the one it is. This
 * drives that comparison with no network and no clock: `fetch`, `Date.now` and the reload are
 * all seams, and the timer is vitest's.
 */

const START = Date.parse("2026-09-03T09:00:00Z");
const OURS = "aaaa1111";
const THEIRS = "bbbb2222";

/** A fetch that answers one token, and counts how often it was asked. */
function feed(token: string | null, ok = true) {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok,
      json: async () => (token === null ? {} : { build: token }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  vi.useRealTimers();
  resetUpdateStoreForTests();
  window.localStorage.clear();
});

/** Advance the fake clock AND the seam the watch reads, then let the pending promises settle. */
async function tick(clock: { at: number }, by: number): Promise<void> {
  clock.at += by;
  await vi.advanceTimersByTimeAsync(by);
}

describe("what the origin answered", () => {
  it("is the build it names, and nothing else is a build", () => {
    expect(servedTokenOf({ build: "aaaa1111" })).toBe("aaaa1111");
    expect(servedTokenOf({ build: "" })).toBeNull();
    expect(servedTokenOf({ build: 7 })).toBeNull();
    expect(servedTokenOf({})).toBeNull();
    expect(servedTokenOf(null)).toBeNull();
    expect(servedTokenOf("aaaa1111")).toBeNull();
  });
});

describe("the build watch", () => {
  it("SAYS NOTHING WHILE THE ORIGIN IS SERVING THIS BUILD — and does ask", () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const { impl, calls } = feed(OURS);
    const stop = startBuildWatch({ token: OURS, fetchImpl: impl, now: () => clock.at });

    return (async () => {
      // Not at arm time: a document that has just loaded IS the build the origin served a
      // moment ago, so the first useful question is one interval away.
      expect(calls).toEqual([]);
      await tick(clock, BUILD_POLL_MS);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(BUILD_PATH);
      expect(currentUpdateOffer()).toBeNull();
      stop();
    })();
  });

  it("raises the strip when the origin has moved on, with the reload as its verb", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const reload = vi.fn();
    const stop = startBuildWatch({
      token: OURS,
      fetchImpl: feed(THEIRS).impl,
      now: () => clock.at,
      reload,
    });

    await tick(clock, BUILD_POLL_MS);
    const offer = currentUpdateOffer();
    expect(offer?.kind).toBe("reload");
    // The strip calls back; it never names a build, a path or a remedy of its own.
    offer?.act?.();
    expect(reload).toHaveBeenCalledTimes(1);

    /* AND THE OFFER CARRIES THE BUILD, so `offerKey` — the one keying rule the once-a-day
       restraint is written against — agrees with what this watch stored. An offer with no build
       on it keys as the bare word "reload", which is a different key from the one below and
       would silently exempt the browser strip from the restraint the moment anything else read
       the offer instead of this module's own line. Nothing renders it: a digest is not
       something to show somebody. */
    expect(offer?.version).toBe(THEIRS);
    expect(offerKey(offer!)).toBe(`reload:${THEIRS}`);
    expect(Object.keys(readAskMemory())).toEqual([`reload:${THEIRS}`]);
    stop();
  });

  it("never replaces a server's own answer: \"too old\" is the more exact sentence for the same remedy", async () => {
    vi.useFakeTimers();
    announceUpdate({ kind: "tooOld", key: "answer:tooOld", verb: "reload", act: () => {} });
    const clock = { at: START };
    const stop = startBuildWatch({ token: OURS, fetchImpl: feed(THEIRS).impl, now: () => clock.at, reload: vi.fn() });
    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()?.kind).toBe("tooOld");
    stop();
  });

  it("ONCE A DAY PER BUILD — the second sighting of the same build says nothing", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const stop = startBuildWatch({
      token: OURS,
      fetchImpl: feed(THEIRS).impl,
      now: () => clock.at,
      reload: () => {},
    });

    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()?.kind).toBe("reload");

    // Somebody put it away and carried on working. The origin is still serving the same newer
    // build, and every later poll finds it — an app that re-raised the strip on each of them
    // would be an app interrupting a person every half hour about one deployment.
    resetUpdateStoreForTests();
    await tick(clock, BUILD_POLL_MS);
    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()).toBeNull();

    // …until the day is up, at which point it is worth saying once more.
    await tick(clock, UPDATE_PERIOD_MS);
    expect(currentUpdateOffer()?.kind).toBe("reload");
    stop();
  });

  it("A BUILD NEWER STILL SPEAKS AT ONCE, because it is a different question", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    let served = THEIRS;
    const impl = (async () => ({ ok: true, json: async () => ({ build: served }) }) as unknown as Response) as unknown as typeof fetch;
    const stop = startBuildWatch({ token: OURS, fetchImpl: impl, now: () => clock.at, reload: () => {} });

    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()?.kind).toBe("reload");
    resetUpdateStoreForTests();

    served = "cccc3333";
    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()?.kind).toBe("reload");
    stop();
  });

  it("a refused or unreadable answer is not a report", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const stop = startBuildWatch({
      token: OURS,
      fetchImpl: feed(THEIRS, false).impl,
      now: () => clock.at,
      reload: () => {},
    });
    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()).toBeNull();
    stop();

    const dead = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const stop2 = startBuildWatch({ token: OURS, fetchImpl: dead, now: () => clock.at, reload: () => {} });
    await tick(clock, BUILD_POLL_MS);
    expect(currentUpdateOffer()).toBeNull();
    stop2();
  });

  it("asks when the window comes back, but not on every flick between windows", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const { impl, calls } = feed(OURS);
    const stop = startBuildWatch({ token: OURS, fetchImpl: impl, now: () => clock.at });

    // A stale tab is most likely to be stale when somebody comes back to it, which is also the
    // moment before they use it.
    await tick(clock, BUILD_POLL_MS);
    expect(calls).toHaveLength(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls, "inside the floor — a window switched away from and back does not re-ask")
      .toHaveLength(1);

    clock.at += BUILD_MIN_GAP_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    stop();
  });

  it("STOPS when it is stopped — neither the timer nor the listener outlives the teardown", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const { impl, calls } = feed(THEIRS);
    const stop = startBuildWatch({ token: OURS, fetchImpl: impl, now: () => clock.at, reload: () => {} });
    stop();

    await tick(clock, BUILD_POLL_MS * 3);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    expect(currentUpdateOffer()).toBeNull();
  });
});
