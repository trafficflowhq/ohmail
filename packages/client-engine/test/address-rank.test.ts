import type { EngineMutation, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { outrankCoveringDomains } from "@ohmail/client-engine";
import { RULE_PRIORITY_MAX } from "@trafficflow/core/rule-order";

/**
 * AN ADDRESS RULE IS WRITTEN AT A PRIORITY ITS DOMAIN'S RULES DO NOT OUTRANK.
 * The router reads priority before kind; the engine lifts a sender rule's write to the covering
 * domain rules' priority, never past the one bound, and hands every other write back as itself.
 */
const ADDR = "info@shop.example";
/** The pre-0.22 News spelling a stored rule can still carry; the mirror's `Folder` type does not name it. */
const LEGACY = "ohmail/Reads" as unknown as Folder;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-05T08:00:00.000Z", updatedAt: "2026-08-05T08:00:00.000Z",
    subjectContains: null, bodyContains: null, ...o,
  } as RuleDTO;
}

const wide = rule({ id: "dom-5", kind: "domain", match: "shop.example", destination: "ohmail/News", priority: 5 });
const bare = rule({ id: "bare", destination: "INBOX" });
const create: EngineMutation = { kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX" };

describe("an address rule is written at a priority its domain's rules do not outrank", () => {
  it("a create and a retarget are lifted to the covering domain rule's priority", () => {
    expect(outrankCoveringDomains([wide], create)).toEqual({ ...create, priority: 5 });
    const update: EngineMutation = { kind: "rule_update", ruleId: bare.id, destination: "INBOX", applyRetro: true };
    expect(outrankCoveringDomains([wide, bare], update)).toEqual({ ...update, priority: 5 });
  });

  it("a domain rule at the bound is met at the bound; one past it declines the lift", () => {
    const atBound = { ...wide, priority: RULE_PRIORITY_MAX };
    expect(outrankCoveringDomains([atBound], create)).toEqual({ ...create, priority: RULE_PRIORITY_MAX });
    expect(outrankCoveringDomains([{ ...wide, priority: RULE_PRIORITY_MAX + 1 }], create)).toBe(create);
  });

  it("anything else is handed back as itself, so its wire body does not change", () => {
    expect(outrankCoveringDomains([], create)).toBe(create);
    expect(outrankCoveringDomains([{ ...wide, destination: "INBOX" }], create)).toBe(create);
    // One place in either spelling: a domain rule filing to the old News name is not elsewhere.
    const news: EngineMutation = { ...create, destination: "ohmail/News" };
    expect(outrankCoveringDomains([{ ...wide, destination: LEGACY }], news)).toBe(news);
    expect(outrankCoveringDomains([{ ...wide, enabled: false }], create)).toBe(create);
    const wideCreate: EngineMutation = { kind: "rule_create", ruleKind: "domain", match: "shop.example", destination: "INBOX" };
    expect(outrankCoveringDomains([wide], wideCreate)).toBe(wideCreate);
    const held: EngineMutation = { ...create, priority: 9 };
    expect(outrankCoveringDomains([wide], held)).toBe(held);
  });
});
