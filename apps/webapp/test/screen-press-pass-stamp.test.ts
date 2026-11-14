import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { retroOf, writtenRuleIds } from "@ohmail/app-logic/press/press-verdict";

/**
 * "ALL" IS SAID ONLY OVER A PASS KNOWN TO BE FINISHED. The rules a commit wrote are named by the
 * server's ids; a rule still applying to past mail holds the sentence back, and a rule with no
 * stamp (an older server) or a create whose id is unknown is never read as finished.
 */
let seq = 0;
function rule(id: string, retro?: RuleDTO["retro"]): RuleDTO {
  return {
    id, kind: "sender", match: "a@x.example", destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z", ...(retro ? { retro } : {}),
  } as RuleDTO;
}
async function mirror(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })) as SyncChange[]);
  return store;
}

describe("the pass a press waits on", () => {
  it("applying while asked and not finished; done once stamped; unknown without a stamp", async () => {
    const store = await mirror([
      rule("asked", { requestedAt: "2026-09-25T12:00:00.000Z", doneAt: null }),
      rule("done", { requestedAt: "2026-09-25T12:00:00.000Z", doneAt: "2026-09-25T12:05:00.000Z" }),
      rule("never", { requestedAt: null, doneAt: null }),
      rule("old"),
    ]);
    expect(retroOf(store, ["asked"])).toBe("applying");
    expect(retroOf(store, ["done", "never"])).toBe("done");
    expect(retroOf(store, ["done", "old"])).toBe("unknown");
    expect(retroOf(store, ["gone"])).toBe("unknown");
  });

  it("names a create by the server's id, an update by its own, and gives up on an unknown id", () => {
    const create = { kind: "rule_create" as const, ruleKind: "sender" as const, match: "a@x.example", destination: "INBOX" as const };
    const update = { kind: "rule_update" as const, ruleId: "r-1", destination: "INBOX" as const };
    expect(writtenRuleIds([create, update], [{ entityId: "srv-9" }, {}])).toEqual(["srv-9", "r-1"]);
    expect(writtenRuleIds([create], [{}])).toBeNull();
    expect(writtenRuleIds([{ kind: "rule_delete", ruleId: "r-2" }], [{}])).toEqual([]);
  });
});
