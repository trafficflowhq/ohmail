import type { MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  STALE_RESUME_MS,
  type EngineAdapter,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE FRESHNESS CONTRACT'S THREE STATES — `engine.freshness()` (INSTANT-ARCH §6.6) ════════
 *
 * A surface rendering a mirror owes the reader one of exactly three presentations: a skeleton
 * over a mirror no drain has ever settled (`unknown`), LABELED content over a mirror whose last
 * settled drain is old (`stale` — "as of 14:32 · catching up"), and plain content otherwise
 * (`current`). The engine is the ONE derivation of that verdict; this file pins the derivation
 * and the settle announcement the label's clearing depends on.
 *
 * Every guard below was watched RED against a named mutation of the implementation, then the
 * implementation was restored:
 *
 *  · stale-shown-as-current — `freshness()` returning `"current"` regardless of the stamp's
 *    age turns the "reports stale once the stamp outlives STALE_RESUME_MS" guard red.
 *  · label-stuck-after-current — removing the drain's settle publish (the one after the
 *    LAST_DRAIN_AT_META write) turns the "the LAST notification of a drain already reports
 *    current" guard red: nothing else announces the settle, so a label driven by subscription
 *    would stand until the next coincidence.
 *  · identity churn — dropping the value cache turns the stable-identity guard red, which in
 *    the shipped shell is a `useSyncExternalStore` render loop.
 */

const t0 = new Date("2026-08-29T12:00:00.000Z");

const EMPTY_PAGE = (since: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: since === "0" ? "AA" : since,
  hasMore: false,
  serverTime: t0.toISOString(),
});

/** The smallest adapter a drain can settle against: one empty page, no snapshot route. */
function quietAdapter(): EngineAdapter {
  return {
    sync: async (params: { since: string }) => EMPTY_PAGE(params.since),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

async function loadedStore(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

describe("engine.freshness()", () => {
  it("walks unknown → current → stale → current across a mirror's life", async () => {
    const store = await loadedStore();
    const clock = { now: t0 };
    const engine = new OhmailEngine({ adapter: quietAdapter(), store, now: () => clock.now });

    // Never drained: unknown, no asOf — the skeleton state, never an empty claim.
    expect(engine.freshness()).toEqual({ state: "unknown", asOf: null });

    // A settled drain stamps the engine clock: current, asOf is the stamp verbatim.
    await engine.syncOnce();
    expect(engine.freshness()).toEqual({ state: "current", asOf: t0.toISOString() });

    // The stamp outlives the threshold: stale, asOf unchanged — the label's time.
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS + 1);
    expect(engine.freshness()).toEqual({ state: "stale", asOf: t0.toISOString() });
    // At the threshold exactly it is still current — the boundary matches freshenStaleResume's.
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS);
    expect(engine.freshness().state).toBe("current");

    // The next settled drain re-stamps: current again, at the new clock.
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS + 60_000);
    await engine.syncOnce();
    expect(engine.freshness()).toEqual({ state: "current", asOf: clock.now.toISOString() });
  });

  it("keeps one identity while the value stands — the useSyncExternalStore contract", async () => {
    const store = await loadedStore();
    const clock = { now: t0 };
    const engine = new OhmailEngine({ adapter: quietAdapter(), store, now: () => clock.now });
    expect(engine.freshness()).toBe(engine.freshness());
    await engine.syncOnce();
    const settled = engine.freshness();
    expect(engine.freshness()).toBe(settled);
    // And the identity CHANGES when the value does — a cache that never invalidates is the
    // label frozen at its first answer.
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS + 1);
    expect(engine.freshness()).not.toBe(settled);
    expect(engine.freshness().state).toBe("stale");
  });

  it("reads an unparseable stamp as unknown, never as a label with no time in it", async () => {
    const store = await loadedStore();
    await store.setMeta(LAST_DRAIN_AT_META, "not an instant");
    const engine = new OhmailEngine({ adapter: quietAdapter(), store, now: () => t0 });
    expect(engine.freshness()).toEqual({ state: "unknown", asOf: null });
  });

  /**
   * THE LABEL CLEARS AT THE SETTLE — not at the next coincidence.
   *
   * WATCHED RED by removing the drain's settle publish: nothing then announces the drain, and the
   * freshness a subscriber last observed is still "stale" — which on screen is "as of · catching
   * up" standing over a mirror that is current.
   */
  it("notifies AFTER stamping, so a subscriber's last observation of a drain is current", async () => {
    const store = await loadedStore();
    // A warm, settled mirror whose stamp has aged past the threshold — the returning tab.
    const clock = { now: t0 };
    const engine = new OhmailEngine({ adapter: quietAdapter(), store, now: () => clock.now });
    await engine.syncOnce();
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS + 1);
    expect(engine.freshness().state).toBe("stale");

    const seen: string[] = [];
    engine.subscribe(() => seen.push(engine.freshness().state));
    await engine.syncOnce();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe("current");
  });
});
