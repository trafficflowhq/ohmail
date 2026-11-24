import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, mutationEffects, type SyncChange } from "@ohmail/client-engine";

/**
 * A ONE-PER-KEY DELETE'S OVERLAY TAKES THE KEY (OVERLAY-LAGS-ONE-DRAIN-AFTER-A-ONE-PER-KEY-DELETE).
 * `RulesService.remove` deletes the pressed row and every row under its four-field key, paused ones
 * included, so the overlay tombstones the same rows: a twin left standing became the sender's rule
 * on screen until the next drain. A narrowed rule and another sender's rule are other keys and stay.
 */
const ctx = { now: () => new Date("2026-10-06T21:00:00.000Z"), uuid: () => "c-1" };
const ruleOf = (id: string, match: string, destination: string, extra: Partial<RuleDTO> = {}): RuleDTO => ({
  id, kind: "sender", match, destination, priority: 0, provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", retro: { requestedAt: null, doneAt: null },
  ...extra,
} as RuleDTO);

async function mirror(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rules.map((r, i) => ({
    type: "rule", op: "create", id: r.id, seq: i + 1, updatedAt: r.updatedAt, entity: r,
  })) as SyncChange[]);
  return store;
}

describe("the rule_delete overlay", () => {
  it("tombstones the pressed row and every twin under its key, and nothing else", async () => {
    const r = await mirror([
      ruleOf("winner", "a@x.example", "INBOX", { priority: 3 }),
      ruleOf("twin", " A@X.example ", "ohmail/Screened"),
      ruleOf("paused-twin", "a@x.example", "ohmail/News", { enabled: false }),
      ruleOf("narrowed", "a@x.example", "ohmail/Receipts", { subjectContains: "invoice" }),
      ruleOf("other", "b@x.example", "INBOX"),
    ]);
    const effects = mutationEffects(r, { kind: "rule_delete", ruleId: "winner" }, ctx);
    expect(effects.every((e) => e.type === "rule" && e.entity === null)).toBe(true);
    expect(effects[0]!.id).toBe("winner");
    expect(effects.map((e) => e.id).slice(1).sort()).toEqual(["paused-twin", "twin"]);
  });

  it("a rule with no twin is one tombstone (the positive control)", async () => {
    const r = await mirror([ruleOf("alone", "a@x.example", "INBOX"), ruleOf("other", "b@x.example", "INBOX")]);
    expect(mutationEffects(r, { kind: "rule_delete", ruleId: "alone" }, ctx).map((e) => e.id)).toEqual(["alone"]);
  });
});
