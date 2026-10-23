/**
 * NO DRAIN PAGE IS AWAITED FOR EVER, WHATEVER THE DOOR.
 *
 * The drive holds the engine's single-flight while it waits on a page, and a later `syncOnce()`
 * joins it rather than asking again — so one `/sync` a dead connection never answered stopped
 * every later drain and every outbox replay until a reload. Each door bounds its own reads (the
 * browser's `/sync` deadlines, the desktop bridge's request deadline); `DRAIN_REQUEST_CEILING_MS`
 * is the engine's belt for a door that does not, and it sits above them so it fires only there.
 *
 * Mutations: the belt's race removed from the delta drain → case 1 red; from the snapshot walk →
 * case 2 red; the timeout latching the snapshot route like any page-1 failure → case 2 red;
 * every page-1 failure rethrown → case 3 red; the freshen walk unbelted → case 4 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_REQUEST_CEILING_MS, LAST_DRAIN_AT_META, MemoryMirrorStore, MutationRejectedError, OhmailEngine,
  STORE_POLICY_GENERATION, STORE_POLICY_GENERATION_META, SYNC_ANSWER_TIMEOUT_MS, SYNC_BODY_TIMEOUT_MS,
  encodeSeqCursor, type SyncResponse, type SyncSnapshotPage,
} from "@ohmail/client-engine";

const NOW = "2026-10-23T09:00:00.000Z";
const never = <T>(): Promise<T> => new Promise<T>(() => { /* the dead socket */ });
const quiet = (cursor: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: NOW,
});
const snapshotPage = (asOfSeq: number): SyncSnapshotPage => ({
  asOfSeq, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 },
});

/** The rejection a call ended with, or `"pending"` while it has not. */
function watch(p: Promise<unknown>): { readonly value: unknown } {
  const box = { value: "pending" as unknown };
  p.then(() => { box.value = "resolved"; }, (err) => { box.value = err; });
  return box;
}

const engineOn = (adapter: object, store = new MemoryMirrorStore()) =>
  new OhmailEngine({ adapter: adapter as never, store });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe("the drain's belt", () => {
  it("sits above every door's own bound, so it fires only where a door has none", () => {
    expect(DRAIN_REQUEST_CEILING_MS).toBeGreaterThan(SYNC_ANSWER_TIMEOUT_MS + SYNC_BODY_TIMEOUT_MS);
  });

  it("1 — a /sync that never answers ends the drive as a retryable timeout, and the next drain asks again", async () => {
    let calls = 0;
    const engine = engineOn({
      sync: () => { calls += 1; return calls === 1 ? never<SyncResponse>() : Promise.resolve(quiet("c2")); },
      fetchBody: async () => null,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    });
    const first = watch(engine.syncOnce());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    // A second call while it hangs joins the same drive: this is the stall.
    const joined = watch(engine.syncOnce());
    await vi.advanceTimersByTimeAsync(DRAIN_REQUEST_CEILING_MS - 1_000);
    expect(first.value, "the drive ended before its ceiling").toBe("pending");
    expect(calls, "a joined call asked again on its own").toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.value, "the hung drive never ended").toBeInstanceOf(MutationRejectedError);
    expect((first.value as MutationRejectedError).code).toBe("timeout");
    expect((first.value as MutationRejectedError).retryable).toBe(true);
    expect(joined.value).toBe(first.value);

    await engine.syncOnce();
    expect(calls, "the drain after the ceiling did not ask again").toBe(2);
  });

  it("2 — a snapshot page 1 that never answers is a timeout, not a missing route: the next drain asks it again", async () => {
    let snapshots = 0;
    let syncs = 0;
    const engine = engineOn({
      snapshot: () => { snapshots += 1; return snapshots === 1 ? never<SyncSnapshotPage>() : Promise.resolve(snapshotPage(7)); },
      sync: async () => { syncs += 1; return quiet(encodeSeqCursor(7)); },
      fetchBody: async () => null,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    });
    const first = watch(engine.syncOnce());
    await vi.advanceTimersByTimeAsync(DRAIN_REQUEST_CEILING_MS + 1_000);
    expect((first.value as MutationRejectedError | string), "the hung snapshot never ended the drive")
      .toBeInstanceOf(MutationRejectedError);
    expect((first.value as MutationRejectedError).code).toBe("timeout");
    // No `since=0` replay behind a timed-out snapshot: that is the latch's road.
    expect(syncs, "a timeout sent the cold mirror down the since=0 road").toBe(0);

    await engine.syncOnce();
    expect(snapshots, "the timeout latched the snapshot route off").toBe(2);
  });

  it("3 — CONTROL: any other page-1 failure still latches the route and takes since=0", async () => {
    let snapshots = 0;
    let syncs = 0;
    const engine = engineOn({
      snapshot: async () => {
        snapshots += 1;
        throw new MutationRejectedError("not found", { status: 404, code: "not_found" });
      },
      // The log replay fails too, so the cursor stays cold and the second drain could ask again.
      sync: async () => { syncs += 1; throw new MutationRejectedError("network failure", { code: "network", retryable: true }); },
      fetchBody: async () => null,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    });
    await expect(engine.syncOnce()).rejects.toBeInstanceOf(MutationRejectedError);
    expect(syncs, "the refused route did not fall back to since=0").toBeGreaterThan(0);
    await expect(engine.syncOnce()).rejects.toBeInstanceOf(MutationRejectedError);
    expect(snapshots, "a refused route was asked again").toBe(1);
  });

  it("4 — a stale resume's snapshot freshen that never answers gives way to the delta drain", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse({ ...quiet(encodeSeqCursor(40)) });
    await store.setMeta(LAST_DRAIN_AT_META, "2026-10-01T09:00:00.000Z");
    // The policy walk is owed nothing, so the freshen is the one snapshot read this drive makes.
    await store.setMeta(STORE_POLICY_GENERATION_META, STORE_POLICY_GENERATION);
    let syncs = 0;
    const engine = engineOn({
      snapshot: () => never<SyncSnapshotPage>(),
      sync: async () => { syncs += 1; return quiet(encodeSeqCursor(41)); },
      fetchBody: async () => null,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    }, store);
    const drive = watch(engine.syncOnce());
    await vi.advanceTimersByTimeAsync(DRAIN_REQUEST_CEILING_MS + 1_000);
    expect(syncs, "the drain waited on the freshen for ever").toBe(1);
    expect(drive.value, "the swallowed freshen failed the drain").toBe("resolved");
  });
});
