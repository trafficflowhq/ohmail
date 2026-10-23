/** @vitest-environment jsdom */
/**
 * A /SYNC THAT HANGS IS A FAILED DRAIN, AND THE LOOP GOES ON.
 *
 * Measured on Cloud web, 2026-10-23: after a silent two-minute cut no sync ran for three minutes,
 * and the strip never said so — the loop was awaiting one `/sync` the dead connection would never
 * answer, and every wake only set "drain again" behind it. Now the browser's `/sync` has a deadline
 * (`engine-config.ts` passes `SYNC_ANSWER_TIMEOUT_MS`/`SYNC_BODY_TIMEOUT_MS`), the engine has a belt
 * for any door without one, and the scheduler counts the timeout like any failed drain.
 *
 * `SyncStatus.failures` keeps its meaning — consecutive failed drains — and a hang is now one of
 * them; the next good drain clears it, as it always did.
 * Mutations: `syncDeadlines` dropped from `engine-config.ts` → case 1 red; the engine's belt
 * removed → case 2 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_REQUEST_CEILING_MS, MemoryMirrorStore, MutationRejectedError, OhmailEngine, SYNC_ANSWER_TIMEOUT_MS,
  type EngineAdapter, type SyncResponse,
} from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";
import { POLL_MS, startSyncScheduler, type SyncStatus } from "../app/shell/sync-scheduler.js";

const NOW = "2026-10-23T09:00:00.000Z";
const quiet = (cursor: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: NOW,
});

const visible = {
  visibilityState: "visible" as DocumentVisibilityState,
  addEventListener(): void {},
  removeEventListener(): void {},
};
const online = { addEventListener(): void {}, removeEventListener(): void {} };

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("a /sync that never answers", () => {
  it("1 — on the browser's own engine: a retryable timeout at the answer deadline, the request aborted", async () => {
    const asked: string[] = [];
    let aborted = 0;
    // Stubbed before `createEngine`: the adapter binds the global at construction.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      asked.push(url);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted += 1; reject(new DOMException("Aborted", "AbortError")); });
      });
    }) as unknown as typeof fetch;
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    let ended: unknown = "pending";
    engine.syncOnce().then(() => { ended = "resolved"; }, (err) => { ended = err; });
    await vi.advanceTimersByTimeAsync(SYNC_ANSWER_TIMEOUT_MS - 1_000);
    expect(asked.length, "the drain asked nothing").toBeGreaterThan(0);
    expect(ended).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended, "the browser's drain had no deadline").toBeInstanceOf(MutationRejectedError);
    expect((ended as MutationRejectedError).code).toBe("timeout");
    expect(aborted, "the timed-out request was left running").toBe(1);
  });

  it("2 — the real loop counts the hang as a failed drain, asks again, and the next good drain clears it", async () => {
    let calls = 0;
    let hang = false;
    const adapter = {
      sync: async () => {
        calls += 1;
        if (hang) { hang = false; return new Promise<SyncResponse>(() => { /* the dead socket */ }); }
        return quiet(`c${calls}`);
      },
      mutate: async () => { throw new Error("no writes here"); },
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engine, {
      report: () => {}, visibility: visible, online, random: () => 0, onStatus: (s) => status.push(s),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      hang = true;
      await vi.advanceTimersByTimeAsync(POLL_MS + 10);
      expect(calls, "the poll did not ask").toBe(2);

      await vi.advanceTimersByTimeAsync(DRAIN_REQUEST_CEILING_MS - 1_000);
      expect(calls, "the loop asked again while a drain was in flight").toBe(2);
      expect(status.at(-1)?.failures ?? 0, "counted before the drain ended").toBe(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(status.some((s) => s.failures === 1), "the hung drain was never counted").toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls, "the loop never asked again after the hang").toBeGreaterThanOrEqual(3);
      expect(status.at(-1)?.failures, "the next good drain did not clear the streak").toBe(0);
    } finally {
      stop();
    }
  });
});
