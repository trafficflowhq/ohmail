/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type EngineMessage, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { planScreeningChange, screeningToast, senderScreening } from "@ohmail/app-logic/press/sender-screening";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE SHEET'S PRESS OVER A RULE OHMAIL INFERRED, ALSO-MOVE OFF (REVIEW-026 HIGH 1). The rule already
 * pointed at the Ohbox, so the press wrote nothing and said "a rule was already sending their future
 * mail there" while their newsletters went on to News. It claims the rule now, moves nothing, and
 * the toast says the rule is theirs; over the person's own rule nothing is written, as before.
 */
const NOW = "2026-10-01T21:00:00.000Z";
const ADDR = "letters@vendor.example";

async function sheet(provenance: RuleDTO["provenance"]) {
  const m: EngineMessage = {
    id: "m-1", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Issue 4",
    from: { name: null, address: ADDR }, to: [], cc: [], date: NOW, folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
  const r: RuleDTO = {
    id: "r-1", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance, enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW, updatedAt: NOW, subjectContains: null, bodyContains: null,
  };
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: m.id, seq: 1, updatedAt: NOW, entity: m },
    { type: "rule", op: "create", id: r.id, seq: 2, updatedAt: NOW, entity: r },
  ] as SyncChange[]);
  return senderScreening(store, "m-1")!;
}

describe("a press over an inferred twin at the place, also-move off", () => {
  it("claims the rule and says so", async () => {
    const plan = planScreeningChange(await sheet("promoted"), "ohbox", "sender", true, false);
    expect(plan.ruleState).toBe("already");
    expect(plan.claimed).toBe(true);
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: false }]);
    expect(screeningToast(plan, "confirmed", 0)).toBe("toastClaimed");
    expect(screeningToast({ ...plan, retro: true }, "confirmed", 0)).toBe("toastClaimedRetro");
  });
  it("over the person's own rule: nothing written, the old sentence", async () => {
    const plan = planScreeningChange(await sheet("manual"), "ohbox", "sender", true, false);
    expect(plan.ruleMutations).toEqual([]);
    expect(screeningToast(plan, null, 0)).toBe("toastAlreadyRuled");
  });
  it("both catalogues carry both sentences", () => {
    for (const cat of [en, de] as unknown as { screening: Record<string, string> }[]) {
      expect(cat.screening.toastClaimed).toMatch(/\{place\}/);
      expect(cat.screening.toastClaimedRetro).toMatch(/\{place\}/);
    }
  });
});
