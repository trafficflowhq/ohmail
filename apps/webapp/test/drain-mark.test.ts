/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { startSyncScheduler } from "@ohmail/app-logic/session/sync-scheduler";
import {
  DRAIN_MARK_HOLD_MS, drainInFlight, markDrain, subscribeDrain,
} from "@ohmail/app-logic/session/drain-mark";
import * as scan from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ THE MARK MEANS A DRAIN, AND IT STILL MEANS ONE ═══════════════════════════════════════
 *
 * The strip's spinner and travelling sliver now mount on this mark alone, so two things have to
 * hold and the second is the one that fails quietly: the mark goes DOWN when nothing is running
 * (or the idle window animates for ever, which is the defect), and it goes UP when a drain
 * starts (or no import ever shows a spinner again, which is a product regression nothing else
 * in the suite would notice — every surface would simply look settled).
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · `options.onDraining?.(true)` removed from the tick — 2 of 6 red, both scheduler cases,
 *     which is the half-applied shape that would ship a strip that never moves.
 *   · `options.onDraining?.(false)` removed from the `finally` — 2 of 6 red, the same two.
 *   · the hold dropped (`publish(false)` straight away) — 2 of 6 red, the two hold cases.
 */

class OnePage implements EngineAdapter {
  calls = 0;
  fail = false;
  constructor(readonly onSync?: () => void) {}
  async sync(_params: SyncParams): Promise<SyncResponse> {
    this.calls += 1;
    this.onSync?.();
    if (this.fail) throw new Error("the mailbox refused");
    return {
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: `c${this.calls}`, hasMore: false, serverTime: "2026-09-17T00:00:00.000Z",
    };
  }
  async mutate(): Promise<MutationOutcome> { throw new Error("this test never mutates"); }
  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(id: string): Promise<MessageBodyWire> {
    return {
      text: `body of ${id}`, html: null, loadedRemoteContent: false,
      unsubscribe: "no_header", unsubscribeUrl: null,
    };
  }
}

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

beforeEach(() => {
  vi.useFakeTimers();
  markDrain(false);
  vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
});
afterEach(() => {
  markDrain(false);
  vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
  vi.useRealTimers();
});

describe("the scheduler marks the drain it runs", () => {
  it("a drain raises the mark and a settled drain lowers it", async () => {
    const seen: boolean[] = [];
    const duringSync: boolean[] = [];
    const adapter = new OnePage(() => duringSync.push(seen[seen.length - 1] ?? false));
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const stop = startSyncScheduler(engine, { onDraining: (f) => seen.push(f), wake: null });
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(adapter.calls).toBeGreaterThanOrEqual(1);
    // The mark was UP while the adapter was being asked, and the pair closed after it.
    expect(duringSync[0]).toBe(true);
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    // One pair per tick, never nested.
    expect(seen.filter((f) => f).length).toBe(seen.filter((f) => !f).length);
  });

  it("a failed drain lowers it too — a loop that let go may not keep the strip moving", async () => {
    const seen: boolean[] = [];
    const adapter = new OnePage();
    adapter.fail = true;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const stop = startSyncScheduler(engine, {
      onDraining: (f) => seen.push(f), wake: null, report: () => {},
    });
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe("the mark the strip reads", () => {
  it("goes up at once and outlives a settled drain by one quiet window", () => {
    const heard: boolean[] = [];
    const off = subscribeDrain(() => heard.push(drainInFlight()));
    markDrain(true);
    expect(drainInFlight()).toBe(true);
    markDrain(false);
    expect(drainInFlight()).toBe(true);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS - 1);
    expect(drainInFlight()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(drainInFlight()).toBe(false);
    expect(heard).toEqual([true, false]);
    off();
  });

  it("a drain landing inside the quiet window keeps the mark up without a second publish", () => {
    const heard: boolean[] = [];
    const off = subscribeDrain(() => heard.push(drainInFlight()));
    markDrain(true);
    markDrain(false);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS - 10);
    markDrain(true);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS * 2);
    expect(drainInFlight()).toBe(true);
    expect(heard).toEqual([true]);
    off();
  });

  it("a listener that leaves stops hearing", () => {
    let heard = 0;
    const off = subscribeDrain(() => { heard += 1; });
    markDrain(true);
    off();
    markDrain(false);
    vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
    expect(heard).toBe(1);
  });
});

describe("the wiring", () => {
  it("the shell hands the scheduler the mark — the half whose absence looks like a settled app", () => {
    const src = scan.withoutCommentsAndLiterals(read("../app/shell/engine.tsx"));
    expect(src).toContain("onDraining: markDrain");
    /* The import is read off the RAW source: the scanner blanks string bodies, so a module
       specifier is invisible to it — which is the right behaviour and the wrong reader. */
    expect(read("../app/shell/engine.tsx")).toContain('from "@ohmail/app-logic/session/drain-mark"');
  });
});
