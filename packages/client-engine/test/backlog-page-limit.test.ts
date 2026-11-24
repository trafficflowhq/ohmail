import type { MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BACKLOG_PAGE_LIMIT,
  encodeSeqCursor,
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  STALE_RESUME_MS,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE BACKLOG DIET'S CLIENT HALF (INSTANT-ARCH §6.3 / §8 stage 3) — dense stale pages ═════
 *
 * A stale resume's convergence cost is PAGE COUNT: each `/sync` page is a serverless invocation
 * with ~10 fixed sequential round trips (measured per page on the hosted service),
 * so a drain that knows it is a backlog catch-up asks for {@link BACKLOG_PAGE_LIMIT} rows per
 * page and carries a measured backlog in ONE invocation instead of four. The verdict
 * comes from the SAME staleness predicate that fires the freshen — the two must never diverge —
 * and the steady-state poll keeps the deployed shape (no limit on the wire, the server's
 * default page).
 *
 * Every guard here was WATCHED RED against a named mutation (2026-08-29):
 *  · dropping the dense ask from `drain()` → the stale test sees `limit: undefined`;
 *  · asking dense unconditionally → the fresh test sees `limit: 2000`;
 *  · letting the dense ask override `syncLimit` → the explicit-limit test sees 2000, not 7.
 */

const t0 = new Date("2026-08-29T12:00:00.000Z");

function change(id: string, seq: number): SyncChange {
  return { type: "rule", op: "create", id, seq, updatedAt: t0.toISOString(), entity: { id } };
}

function respOf(changes: SyncChange[], cursorSeq: number, hasMore: boolean): SyncResponse {
  return {
    changes: { creates: changes, updates: [], moves: [], deletes: [] },
    cursor: encodeSeqCursor(cursorSeq),
    hasMore,
    serverTime: t0.toISOString(),
  };
}

/** An adapter that records the LIMIT of every non-rules-first /sync ask. */
function limitRecorder(backlog: SyncResponse[]): { adapter: EngineAdapter; limits: (number | undefined)[] } {
  const limits: (number | undefined)[] = [];
  let page = 0;
  const adapter = {
    sync: async (params: { since: string; limit?: number; types?: string[] }): Promise<SyncResponse> => {
      if (params.types?.length === 1 && params.types[0] === "rule") {
        // The resumed-incomplete rules-first pass (owned by bootstrap-rules-first.test.ts).
        return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: params.since, hasMore: false, serverTime: t0.toISOString() };
      }
      limits.push(params.limit);
      const p = backlog[page];
      if (!p) return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: params.since, hasMore: false, serverTime: t0.toISOString() };
      page += 1;
      return p;
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return { adapter, limits };
}

async function warmStore(cursorSeq: number, stampAt: Date | null): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyResponse(respOf([change("seed", cursorSeq)], cursorSeq, false));
  if (stampAt) await store.setMeta(LAST_DRAIN_AT_META, stampAt.toISOString());
  return store;
}

describe("the stale drain asks for dense pages", () => {
  it("a STALE resume asks for BACKLOG_PAGE_LIMIT on every replay page", async () => {
    const store = await warmStore(100, t0);
    const clock = { now: new Date(t0.getTime() + STALE_RESUME_MS + 1) };
    const h = limitRecorder([
      respOf([change("b1", 300)], 300, true),
      respOf([change("b2", 900)], 900, false),
    ]);
    await new OhmailEngine({ adapter: h.adapter, store, now: () => clock.now }).syncOnce();
    expect(h.limits).toEqual([BACKLOG_PAGE_LIMIT, BACKLOG_PAGE_LIMIT]);
  });

  it("a FRESH resume keeps the deployed shape — no limit on the wire", async () => {
    const store = await warmStore(100, t0);
    const clock = { now: new Date(t0.getTime() + 1_000) }; // well inside STALE_RESUME_MS
    const h = limitRecorder([respOf([change("b1", 300)], 300, false)]);
    await new OhmailEngine({ adapter: h.adapter, store, now: () => clock.now }).syncOnce();
    expect(h.limits).toEqual([undefined]);
  });

  it("a warm mirror with NO stamp (pre-upgrade / interrupted bootstrap) drains dense", async () => {
    const store = await warmStore(100, null);
    const clock = { now: t0 };
    const h = limitRecorder([respOf([change("b1", 300)], 300, false)]);
    await new OhmailEngine({ adapter: h.adapter, store, now: () => clock.now }).syncOnce();
    expect(h.limits).toEqual([BACKLOG_PAGE_LIMIT]);
  });

  it("an explicit syncLimit always wins, stale or not", async () => {
    const store = await warmStore(100, t0);
    const clock = { now: new Date(t0.getTime() + STALE_RESUME_MS + 1) };
    const h = limitRecorder([respOf([change("b1", 300)], 300, false)]);
    await new OhmailEngine({ adapter: h.adapter, store, now: () => clock.now, syncLimit: 7 }).syncOnce();
    expect(h.limits).toEqual([7]);
  });
});
