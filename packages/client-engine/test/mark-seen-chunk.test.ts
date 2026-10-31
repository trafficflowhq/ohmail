import { describe, expect, it } from "vitest";
import {
  FixturesAdapter, MARK_SEEN_CHUNK, MutationRejectedError, OhmailEngine, chunkMarkSeen, inverseMutations, type EngineMutation,
} from "../src/index.js";
import { MemoryMirrorStore } from "../src/store.js";

/**
 * A READ OVER A SET AND ITS UNDO SPLIT ALIKE at the route's 200-id cap (`PATCH /messages` answers
 * 413 above it). Mutation: return the list unsplit — the 201-id case reads one mutation and goes red.
 */
const ids = (n: number, p = "m") => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("chunkMarkSeen", () => {
  it("is the route's number", () => {
    expect(MARK_SEEN_CHUNK).toBe(200);
  });

  it("splits a 201-id mark_seen into 200 + 1, in order, keeping every field", () => {
    const out = chunkMarkSeen([{ kind: "mark_seen", messageIds: ids(201), unread: true }]);
    expect(out.map((m) => (m.kind === "mark_seen" ? m.messageIds.length : -1))).toEqual([200, 1]);
    expect(out.every((m) => m.kind === "mark_seen" && m.unread === true)).toBe(true);
    expect(out.flatMap((m) => (m.kind === "mark_seen" ? m.messageIds : []))).toEqual(ids(201));
  });

  it("keeps a glance label on every chunk", () => {
    const out = chunkMarkSeen([{ kind: "mark_seen", messageIds: ids(401), unread: false, via: "glance" }]);
    expect(out.length).toBe(3);
    expect(out.every((m) => m.kind === "mark_seen" && m.via === "glance")).toBe(true);
  });

  it("passes 200 ids and every other kind through unchanged, in order", () => {
    const tri: EngineMutation = { kind: "triage_set", messageId: "t1", state: "none" };
    const exact: EngineMutation = { kind: "mark_seen", messageIds: ids(200), unread: false };
    const out = chunkMarkSeen([tri, exact]);
    expect(out).toEqual([tri, exact]);
  });
});

describe("an Undo's restore splits and narrows with its ids", () => {
  it("a 450-id inverse of a Mark unread splits into chunks whose maps name only their own ids", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const all = ids(450);
    const at = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString();
    for (const [i, id] of all.entries()) {
      await store.putLocal("message", id, { id, unread: false, folder: "INBOX", labels: [], triage: null, ...(i % 2 === 0 ? { openReadAt: at(i) } : {}) });
    }
    const out = chunkMarkSeen(inverseMutations(store, { kind: "mark_seen", messageIds: all, unread: true }));
    expect(out.map((m) => (m.kind === "mark_seen" ? m.messageIds.length : -1))).toEqual([200, 200, 50]);
    for (const m of out) {
      if (m.kind !== "mark_seen") throw new Error(m.kind);
      expect(m.restoreOpenReadAt).toEqual(Object.fromEntries(m.messageIds.filter((id) => all.indexOf(id) % 2 === 0).map((id) => [id, at(all.indexOf(id))])));
    }
  });

  it("a queued Undo narrowed by a newer read keeps only its remaining entries, {} included", async () => {
    const fx = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => fx.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => fx.sync(...a),
        mutate: async () => { throw new MutationRejectedError("net", { code: "network", retryable: true }); },
      } as never,
    });
    await engine.start();
    const read = "2026-07-28T09:00:00.000Z";
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia", "petra"], unread: false, restoreOpenReadAt: { giulia: read, petra: read } });
    const queued = () => engine.pendingMutations().map((p) => p.mutation);
    expect(queued(), "the premise: the Undo is queued").toHaveLength(1);
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(queued()[0]).toMatchObject({ messageIds: ["petra"], restoreOpenReadAt: { petra: read } });
    expect(Object.keys((queued()[0] as { restoreOpenReadAt: object }).restoreOpenReadAt)).toEqual(["petra"]);
  });
});
