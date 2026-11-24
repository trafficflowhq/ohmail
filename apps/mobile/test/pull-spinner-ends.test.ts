import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PULL_SPIN_CAP_MS, spinUntil } from "../src/state/pull-round";

/*
 * PULL TO REFRESH ON EVERY MAIL LIST, AND A SPINNER THAT ENDS: each list hands the platform's RefreshControl the one
 * pull hook, whose `onRefresh` rings the app's own sync and clears `refreshing` when that round settles, or at the
 * cap when the round hangs. A pull while one runs asks nothing more. The spinner is the theme's accent.
 */

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

afterEach(() => {
  vi.useRealTimers();
});

describe("the pull's spinner", () => {
  it("ends when the round ends", async () => {
    let done = false;
    let finish!: () => void;
    const round = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const spin = spinUntil(round).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await spin;
    expect(done).toBe(true);
  });

  it("ends at the cap when the round hangs, and on a refused round", async () => {
    vi.useFakeTimers();
    let done = false;
    const spin = spinUntil(new Promise<void>(() => {})).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(PULL_SPIN_CAP_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await spin;
    expect(done).toBe(true);
    expect(PULL_SPIN_CAP_MS).toBe(15_000);
    vi.useRealTimers();
    await expect(spinUntil(Promise.reject(new Error("refused")))).resolves.toBeUndefined();
  });

  it("the hook rings the sync once per pull and clears `refreshing` when the capped round settles", () => {
    const hook = read("../src/state/pull.ts");
    expect(hook).toContain("spinUntil(pullRound(networkNow(), (heard) => conn.syncNow(heard)");
    expect(hook).toMatch(/if \(inFlight\.current\) return;/);
    expect(hook).toMatch(/\.finally\(\(\) => \{\s*inFlight\.current = false;\s*if \(alive\.current\) setRefreshing\(false\);/);
  });

  it("the RefreshControl is the theme's accent on both platforms", () => {
    const base = read("../src/ui/base.tsx");
    expect(base).toMatch(/<RefreshControl[\s\S]*?refreshing=\{refresh\.refreshing\}[\s\S]*?onRefresh=\{refresh\.onRefresh\}/);
    expect(base).toContain("tintColor={t.c.accentInk}");
    expect(base).toContain("colors={[t.c.accentInk]}");
  });

  it("every mail list hands its scroller the pull", () => {
    const lists = [
      "../app/(tabs)/index.tsx",
      "../app/(tabs)/reads.tsx",
      "../app/(tabs)/receipts.tsx",
      "../app/(tabs)/screener.tsx",
      "../app/triage.tsx",
      "../app/drafts/index.tsx",
      "../app/folder/[id].tsx",
      "../app/tag/[id].tsx",
      "../app/history.tsx",
      "../app/scheduled.tsx",
    ];
    for (const list of lists) {
      const src = read(list);
      expect(src, list).toMatch(/= usePullToSync\(\)/);
      expect(src, list).toMatch(/refresh=\{\w+\}/);
    }
  });
});
