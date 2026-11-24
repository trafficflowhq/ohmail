import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { applyToRecords, pressOverTwins, recordKey, type MirrorRecord } from "@ohmail/client-engine";

/**
 * A PRESS OVER A SENDER'S TWINS IS ONE WRITE. The server converges a key onto the row a PATCH
 * names and deletes the others, so a second PATCH in the same press names a row that is gone
 * (404) and the press reads refused on the web sheet and the phone alike.
 */
const ADDR = "lena@atelier.example";

function rule(id: string, destination: string, over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z", ...over,
  } as RuleDTO;
}

const TWINS = () => [rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")];

describe("pressOverTwins over {allow Ohbox, deny Screened}", () => {
  it("a press elsewhere is one PATCH over the winner", () => {
    const p = pressOverTwins(TWINS(), "sender", ADDR, "ohmail/News", true);
    expect(p.writes).toEqual([{ kind: "rule_update", ruleId: "r-deny", destination: "ohmail/News", applyRetro: true }]);
    expect(p.state).toBe("retargeted");
  });

  it("a re-arm at the winner's place is one PATCH over the winner", () => {
    const p = pressOverTwins(TWINS(), "sender", ADDR, "ohmail/Screened", true);
    expect(p.writes).toEqual([{ kind: "rule_update", ruleId: "r-deny", destination: "ohmail/Screened", applyRetro: true }]);
    expect(p.state).toBe("already");
  });

  it("the backlog declined over twins still writes the one PATCH that collapses them", () => {
    const p = pressOverTwins(TWINS(), "sender", ADDR, "ohmail/Screened", false);
    expect(p.writes).toEqual([{ kind: "rule_update", ruleId: "r-deny", destination: "ohmail/Screened", applyRetro: false }]);
  });

  it("a lone manual rule at the place with the backlog declined writes nothing (the positive arm)", () => {
    expect(pressOverTwins([rule("r-allow", "INBOX")], "sender", ADDR, "INBOX", false).writes).toEqual([]);
  });
});

describe("a decide's echo names the existing rule it converged onto", () => {
  it("a `create` echo at a newer seq over a held rule replaces it (upsert)", () => {
    const records = new Map<string, MirrorRecord>();
    records.set(recordKey("rule", "r-allow"), { type: "rule", id: "r-allow", seq: 3, entity: rule("r-allow", "INBOX") });
    const next = rule("r-allow", "ohmail/Screened", { provenance: "promoted" });
    applyToRecords(records, [{ type: "rule", op: "create", id: "r-allow", seq: 9, updatedAt: next.updatedAt, entity: next }]);
    expect(records.get(recordKey("rule", "r-allow"))).toEqual({ type: "rule", id: "r-allow", seq: 9, entity: next });
  });
});
