import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { routingReversal } from "../src/state/live";

/**
 * THE WAY BACK FROM A COMMITTED MOVE IS AN UNDO, NOT A PRESS (REVIEW-026 HIGH 2). The Move's own PATCH
 * names a place and makes the rule the person's on the server; the way back names the old place, so
 * without saying it is an undo it made a Screener rule the person's as well and the sender's
 * newsletters landed in the Ohbox. It carries the provenance it read before the Move.
 */
const ruleOf = (provenance: RuleDTO["provenance"]): RuleDTO => ({
  id: "r-1", kind: "sender", match: "a@x.example", destination: "INBOX", priority: 2, provenance, enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", retro: { requestedAt: null, doneAt: null },
} as RuleDTO);

async function reverse(provenance: RuleDTO["provenance"]) {
  const store = new MemoryMirrorStore();
  await store.load();
  const r = ruleOf(provenance);
  await store.applyChanges([{ type: "rule", op: "create", id: r.id, seq: 1, updatedAt: r.updatedAt, entity: r }] as SyncChange[]);
  return routingReversal(() => store, [{ kind: "rule_update", ruleId: "r-1", destination: "ohmail/News", applyRetro: false }])();
}

describe("the phone's way back from a committed Move", () => {
  it("restores an inferred rule's provenance", async () => {
    expect(await reverse("promoted")).toEqual([{
      kind: "rule_update", ruleId: "r-1", destination: "INBOX", priority: 2, applyRetro: false,
      keepProvenance: true, restoreProvenance: "promoted",
    }]);
  });
  it("keeps a rule that was already the person's, restoring nothing", async () => {
    expect(await reverse("manual")).toEqual([{
      kind: "rule_update", ruleId: "r-1", destination: "INBOX", priority: 2, applyRetro: false, keepProvenance: true,
    }]);
  });
});
