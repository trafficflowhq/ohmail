import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, mutationEffects, pressOverTwins, type SyncChange } from "@ohmail/client-engine";

/**
 * THE OVERLAY SAYS WHAT THE SERVER WILL ANSWER ABOUT WHOSE RULE IT IS: a press naming the place makes
 * it the person's, an undo keeps it, and an undo's restore lands only over a `manual` row. Before, the
 * overlay kept the old provenance and the echo flipped the Rules page's origin under the person.
 */
const ctx = { now: () => new Date("2026-10-01T21:00:00.000Z"), uuid: () => "c-1" };
const ruleOf = (provenance: RuleDTO["provenance"], destination = "INBOX"): RuleDTO => ({
  id: "r-1", kind: "sender", match: "a@x.example", destination, priority: 0, provenance, enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", retro: { requestedAt: null, doneAt: null },
} as RuleDTO);

async function reader(r: RuleDTO) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "rule", op: "create", id: r.id, seq: 1, updatedAt: r.updatedAt, entity: r }] as SyncChange[]);
  return store;
}
const provOf = (effects: ReturnType<typeof mutationEffects>) => (effects[0]!.entity as RuleDTO).provenance;

describe("the rule overlay's provenance", () => {
  it("a press naming the place makes it the person's", async () => {
    const r = await reader(ruleOf("promoted", "ohmail/News"));
    expect(provOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "INBOX" }, ctx))).toBe("manual");
  });
  it("an undo keeps it, and restores only over a manual row", async () => {
    expect(provOf(mutationEffects(await reader(ruleOf("promoted")),
      { kind: "rule_update", ruleId: "r-1", destination: "INBOX", keepProvenance: true }, ctx))).toBe("promoted");
    expect(provOf(mutationEffects(await reader(ruleOf("manual")),
      { kind: "rule_update", ruleId: "r-1", destination: "INBOX", keepProvenance: true, restoreProvenance: "promoted" }, ctx)))
      .toBe("promoted");
    expect(provOf(mutationEffects(await reader(ruleOf("seeded-from-sent")),
      { kind: "rule_update", ruleId: "r-1", destination: "INBOX", keepProvenance: true, restoreProvenance: "promoted" }, ctx)))
      .toBe("seeded-from-sent");
  });
});

describe("a press over a twin already at the place, the backlog declined", () => {
  it("claims an inferred twin with a PATCH that moves nothing", () => {
    const p = pressOverTwins([ruleOf("seeded-from-sent")], "sender", "a@x.example", "INBOX", false);
    expect(p).toEqual({ state: "already", claimed: true,
      writes: [{ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: false }] });
  });
  it("writes nothing over the person's own twin", () => {
    expect(pressOverTwins([ruleOf("manual")], "sender", "a@x.example", "INBOX", false))
      .toEqual({ state: "already", claimed: false, writes: [] });
  });
  it("re-arms every twin there when the backlog is asked, as before", () => {
    const p = pressOverTwins([ruleOf("manual")], "sender", "a@x.example", "INBOX", true);
    expect(p.writes).toEqual([{ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: true }]);
  });
});
