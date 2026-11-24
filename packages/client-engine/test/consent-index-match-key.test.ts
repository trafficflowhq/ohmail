import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { consentIndex, decidedDestination } from "@ohmail/client-engine";

/**
 * THE CLIENT KEYS A RULE THE WAY THE ROUTER AND THE QUEUE SQL DO — `ruleMatchKey`, the SQL's
 * `trim(lower(match))`, which strips spaces only. A padded rule decides its sender on every door;
 * a tab is not a space to the SQL, so it is not one here either.
 */

const rule = (match: string, destination: RuleDTO["destination"] = "INBOX"): RuleDTO => ({
  id: `r-${match}`, kind: "sender", match, destination, priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z", subjectContains: null, bodyContains: null,
});

describe("one match key for the consent index", () => {
  it("a space-padded rule decides its sender", () => {
    expect(decidedDestination(consentIndex([rule("  Anna@X.test ")]), "anna@x.test")).toBe("INBOX");
  });

  it("a tab is not a space to the queue's SQL, and not to the client", () => {
    expect(decidedDestination(consentIndex([rule("\tanna@x.test")]), "anna@x.test")).toBeNull();
  });
});
