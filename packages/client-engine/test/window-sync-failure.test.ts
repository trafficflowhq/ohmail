/**
 * The window's failed pull becomes a content-free record the door can log (FIX-022). The classifier
 * reads class names, statuses and closed codes and never a message; the engine hands the record
 * to an adapter that has the capability and does nothing at all for one that has not.
 */
import type { MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  CursorExpiredError, MemoryMirrorStore, MutationRejectedError, OhmailEngine, SnapshotCursorRefusedError,
  WINDOW_SYNC_FAILURE_REASONS, classifyWindowSyncFailure,
  type EngineAdapter, type SyncResponse, type WindowSyncFailure,
} from "../src/index.js";

describe("classifyWindowSyncFailure", () => {
  it("a stack ceiling keeps the class and drops the message", () => {
    const err = new RangeError("Maximum call stack size exceeded — and a subject would be here");
    const r = classifyWindowSyncFailure(err, 4);
    expect(r).toEqual({ attempt: 4, reason: "stack_ceiling", errorClass: "RangeError" });
    expect(JSON.stringify(r)).not.toContain("subject");
  });
  it("a refused status carries status and code", () => {
    const err = new MutationRejectedError("the mailbox owner@example.test is gone", { status: 410, code: "cursor_expired", retryable: false });
    const r = classifyWindowSyncFailure(err, 1);
    expect(r.reason).toBe("http_refusal");
    expect(r.status).toBe(410);
    expect(r.code).toBe("cursor_expired");
    expect(JSON.stringify(r)).not.toContain("owner@");
  });
  it("the transport's own failure is `transport`; the bridge deadline and the abort are their own", () => {
    expect(classifyWindowSyncFailure(new MutationRejectedError("network failure: 32 requests are already waiting", { code: "network", retryable: true }), 2).reason).toBe("transport");
    const deadline = new Error("gave up"); deadline.name = "BridgeDeadlineError";
    expect(classifyWindowSyncFailure(deadline, 1).reason).toBe("bridge_deadline");
    expect(classifyWindowSyncFailure(new CursorExpiredError(), 1).reason).toBe("cursor_expired");
    // A refused snapshot cursor is its own reason, though it IS a CursorExpiredError.
    expect(classifyWindowSyncFailure(new SnapshotCursorRefusedError(), 1).reason).toBe("snapshot_cursor_refused");
    const aborted = new Error("x"); aborted.name = "AbortError";
    expect(classifyWindowSyncFailure(aborted, 1).reason).toBe("aborted");
  });
  it("names the store, the deadline and the other window faults apart, where each read `unknown`", () => {
    const store = Object.assign(new Error("Call to NativeStatement rejected: no such table x"), { code: "ERR_INTERNAL_SQLITE_ERROR" });
    expect(classifyWindowSyncFailure(store, 2)).toEqual({ attempt: 2, reason: "store_write", errorClass: "Error" });
    expect(classifyWindowSyncFailure(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }), 1).reason).toBe("store_write");
    const late = new Error("signal timed out"); late.name = "TimeoutError";
    expect(classifyWindowSyncFailure(late, 1).reason).toBe("timeout");
    expect(classifyWindowSyncFailure(new TypeError("x is undefined"), 1).reason).toBe("window_fault");
    // A code that merely mentions the store in a lowercase door code is still the door's.
    expect(classifyWindowSyncFailure(Object.assign(new Error("n"), { code: "sqlite_lock" }), 1).reason).toBe("unknown");
    expect(classifyWindowSyncFailure(new Error("plain"), 1).reason).toBe("unknown");
  });
  it("a thrown string or an unknown shape still yields a bounded record", () => {
    expect(classifyWindowSyncFailure("oops", 1)).toEqual({ attempt: 1, reason: "unknown", errorClass: "string" });
    const odd = { name: "not a class name; with spaces", status: 9999, code: "Mixed Case" };
    expect(classifyWindowSyncFailure(odd, 1)).toEqual({ attempt: 1, reason: "unknown", errorClass: "object" });
  });
  it("every reason the classifier can answer is on the closed list", () => {
    const answers = new Set<string>();
    const shapes: unknown[] = [
      new RangeError("x"), new CursorExpiredError(), new SnapshotCursorRefusedError(), "s", { status: 500 },
      new MutationRejectedError("n", { code: "network", retryable: true }),
      new MutationRejectedError("p", { code: "protocol", retryable: false }),
      Object.assign(new Error("d"), { name: "BridgeDeadlineError" }),
      Object.assign(new Error("a"), { name: "SyncAbortedError" }),
      Object.assign(new Error("s"), { code: "ERR_INTERNAL_SQLITE_ERROR" }),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      new TypeError("w"),
    ];
    for (const s of shapes) answers.add(classifyWindowSyncFailure(s, 1).reason);
    for (const a of answers) expect(WINDOW_SYNC_FAILURE_REASONS).toContain(a);
    expect(answers.size).toBeGreaterThanOrEqual(11);
  });
});

function adapterWith(sink?: (r: WindowSyncFailure) => Promise<void>): EngineAdapter {
  return {
    sync: async (p: { since: string }): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: p.since, hasMore: false,
      serverTime: "2026-09-21T08:00:00.000Z",
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    ...(sink ? { reportSyncFailure: sink } : {}),
  } as unknown as EngineAdapter;
}

describe("OhmailEngine.reportSyncFailure", () => {
  it("hands the record to an adapter with the capability, and survives a sink that rejects", async () => {
    const got: WindowSyncFailure[] = [];
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: adapterWith(async (r) => { calls += 1; got.push(r); if (calls === 2) throw new Error("door closed"); }),
      store: new MemoryMirrorStore(),
    });
    engine.reportSyncFailure(new RangeError("boom"), 3);
    engine.reportSyncFailure(new RangeError("boom"), 4);
    await new Promise((r) => setTimeout(r, 0));
    expect(got.map((g) => g.attempt)).toEqual([3, 4]);
    expect(got[0]).toEqual({ attempt: 3, reason: "stack_ceiling", errorClass: "RangeError" });
  });
  it("is a no-op on an adapter without the capability — the hosted client makes no request for it", () => {
    const engine = new OhmailEngine({ adapter: adapterWith(), store: new MemoryMirrorStore() });
    expect(() => engine.reportSyncFailure(new Error("x"), 1)).not.toThrow();
  });
});
