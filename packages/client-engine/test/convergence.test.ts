import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  flattenResponse,
  type EngineMessage,
  type SyncChange,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * Convergence — the client-side port of the semantics the backend proves in
 * packages/services/test/_apply-harness.ts: duplicate pages, out-of-order
 * pages, stale moves, and delete/resurrect all converge to identical state.
 */

function serialize(store: MemoryMirrorStore): string {
  const entries = [...store.snapshot().entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

async function bootstrapResponse() {
  const adapter = new FixturesAdapter();
  return adapter.sync({ since: "0", limit: 2000 });
}

describe("idempotent apply (contract §3.3)", () => {
  it("applying the same page twice converges to the once-applied state (same cursor)", async () => {
    const resp = await bootstrapResponse();

    const once = new MemoryMirrorStore();
    await once.load();
    await once.applyResponse(resp);

    const twice = new MemoryMirrorStore();
    await twice.load();
    await twice.applyResponse(resp);
    await twice.applyResponse(resp);

    expect(serialize(twice)).toBe(serialize(once));
    expect(twice.getCursor()).toBe(once.getCursor());
    expect(twice.maxSeq()).toBe(once.maxSeq());
    expect(once.snapshot().size).toBeGreaterThan(20);
  });

  it("pages applied out of order converge to the in-order state", async () => {
    const adapter = new FixturesAdapter();
    const p1 = await adapter.sync({ since: "0", limit: 10 });
    expect(p1.hasMore).toBe(true);
    const p2 = await adapter.sync({ since: p1.cursor, limit: 2000 });
    expect(p2.hasMore).toBe(false);

    const inOrder = new MemoryMirrorStore();
    await inOrder.applyChanges(flattenResponse(p1));
    await inOrder.applyChanges(flattenResponse(p2));

    const outOfOrder = new MemoryMirrorStore();
    await outOfOrder.applyChanges(flattenResponse(p2));
    await outOfOrder.applyChanges(flattenResponse(p1));
    // …and a duplicate replay of page 1 on top.
    await outOfOrder.applyChanges(flattenResponse(p1));

    expect(serialize(outOfOrder)).toBe(serialize(inOrder));
  });

  it("a shuffled + duplicated single stream converges", async () => {
    const changes = flattenResponse(await bootstrapResponse());

    const ordered = new MemoryMirrorStore();
    await ordered.applyChanges(changes);

    // Deterministic shuffle + every change applied twice.
    const shuffled = [...changes, ...changes];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const chaotic = new MemoryMirrorStore();
    await chaotic.applyChanges(shuffled);

    expect(serialize(chaotic)).toBe(serialize(ordered));
  });
});

describe("seq-guarded moves and deletes", () => {
  const msg = (folder: string): Partial<EngineMessage> => ({
    id: "m1",
    subject: "hello",
    folder: folder as EngineMessage["folder"],
    unread: true,
  });

  const create: SyncChange = { type: "message", op: "create", id: "m1", seq: 5, updatedAt: "2026-07-28T00:00:05Z", entity: msg("INBOX") };
  const moveToFeed: SyncChange = { type: "message", op: "move", id: "m1", seq: 7, updatedAt: "2026-07-28T00:00:07Z", move: { from: "INBOX", to: "ohmail/News" } };
  const staleMove: SyncChange = { type: "message", op: "move", id: "m1", seq: 6, updatedAt: "2026-07-28T00:00:06Z", move: { from: "INBOX", to: "ohmail/Quarantine" } };

  it("a stale move (lower seq) never overwrites a newer one — any order", async () => {
    const a = new MemoryMirrorStore();
    await a.applyChanges([create, moveToFeed]);
    await a.applyChanges([staleMove]); // replayed late
    expect(a.get<EngineMessage>("message", "m1")?.folder).toBe("ohmail/News");

    const b = new MemoryMirrorStore();
    await b.applyChanges([create, staleMove, moveToFeed]); // interleaved
    expect(b.get<EngineMessage>("message", "m1")?.folder).toBe("ohmail/News");

    const c = new MemoryMirrorStore();
    await c.applyChanges([moveToFeed, staleMove, create, moveToFeed]); // shuffled + dup
    expect(c.get<EngineMessage>("message", "m1")?.folder).toBe("ohmail/News");
    expect(serialize(c)).toBe(serialize(b));
  });

  it("a move without an entity patches folder onto the local base entity", async () => {
    const s = new MemoryMirrorStore();
    await s.applyChanges([create, moveToFeed]);
    const m = s.get<EngineMessage>("message", "m1");
    expect(m?.subject).toBe("hello"); // base fields survive
    expect(m?.folder).toBe("ohmail/News");
  });

  it("delete tombstones; a LATER create resurrects; a replayed delete stays dead", async () => {
    const del: SyncChange = { type: "message", op: "delete", id: "m1", seq: 9, updatedAt: "2026-07-28T00:00:09Z" };
    const recreate: SyncChange = { type: "message", op: "create", id: "m1", seq: 10, updatedAt: "2026-07-28T00:00:10Z", entity: msg("INBOX") };

    const s = new MemoryMirrorStore();
    await s.applyChanges([create, del]);
    expect(s.get("message", "m1")).toBeUndefined();
    expect(s.snapshot().has("message:m1")).toBe(false);

    // Replaying the original create (seq 5 < 9) must NOT resurrect.
    await s.applyChanges([create]);
    expect(s.get("message", "m1")).toBeUndefined();

    // A later create resurrects…
    await s.applyChanges([recreate]);
    expect(s.get<EngineMessage>("message", "m1")?.folder).toBe("INBOX");

    // …and a replayed stale delete cannot kill it again.
    await s.applyChanges([del]);
    expect(s.get("message", "m1")).toBeDefined();
  });
});
