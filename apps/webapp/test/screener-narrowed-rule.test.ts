import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import type { RuleEntity } from "@ohmail/wire";

describe("automatic filing", () => {
  it("does not repeatedly file held letters outside a subject rule", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const now = "2026-09-12T12:00:00.000Z";
    const rule: RuleEntity = {
      id: "rule", kind: "domain", match: "paper.test", destination: "ohmail/News",
      subjectContains: "Invoice", priority: 0, provenance: "manual", enabled: true,
      createdAt: now, updatedAt: now, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    };
    await store.applyChanges([
      { type: "rule", op: "create", id: rule.id, seq: 1, updatedAt: now, entity: rule },
      { type: "message", op: "create", id: "letter", seq: 2, updatedAt: now, entity: {
        id: "letter", folder: "ohmail/Screener", subject: "Other", from: { address: "sender@paper.test" }, updatedAt: now,
      } },
    ]);
    let requests = 0;
    const engine = new OhmailEngine({ store, adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: null, hasMore: false, serverTime: now }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      heldReleases: async () => ({ groups: [{ ruleId: rule.id, kind: "domain", match: rule.match, destination: rule.destination, count: 1 }], total: 1, max: 200 }),
      releaseHeld: async () => { requests++; return { released: [], total: 1 }; },
    } as never });
    await engine.refreshHeldReleases();
    const filing = { canFile: () => true, onFailure: () => {} };
    engine.fileHeldDecisions(filing);
    await new Promise((resolve) => setTimeout(resolve, 50));
    engine.fileHeldDecisions(filing);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toBe(0);
  });
});
