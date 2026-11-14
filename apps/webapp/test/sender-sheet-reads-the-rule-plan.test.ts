import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, consentPartition, heldRuleId, pressRules, type SyncChange } from "@ohmail/client-engine";
import { planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * A READER-ONLY INSTALL PLANS OVER THE ORGANIZER'S COPY, IN THE SCREENING PLANNER (moved word for word out of
 * `sender-sheet-reads-the-rule.test.tsx`, whose other cases draw today's sender sheet, `app/components/sender-menu/SenderMenu.tsx`,
 * which no host's entry reaches): a press's rule plan reads the organizer's copy of the rules and the presses still
 * waiting on it. These cases render nothing; they hold over the planner, which stays.
 */
const NOW = new Date("2026-09-28T07:00:00.000Z");
const ADDR = "bea@example.invalid";
let seq = 0;

function msg(id: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `letter ${id}`, from: { name: "Bea", address: ADDR }, to: [], cc: [],
    date: "2026-09-27T12:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-27T12:00:00.000Z",
  } as EngineMessage;
}

function rule(id: string, destination: string, o: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-28T06:25:41.000Z", updatedAt: "2026-09-28T06:25:41.000Z", ...o,
  } as RuleDTO;
}

describe("on a reader-only install the sheet plans over the organizer's copy", () => {
  it("a stale row of this device says the Ohbox, the organizer files News: the Ohbox press rewrites the rule", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const copy = { mailboxId: "mb", rules: [rule("profile:mb:0", "ohmail/News")], asOf: NOW.toISOString(), from: { kind: "local", name: "Host", since: null }, updatedAt: NOW.toISOString(), applied: [] };
    await store.applyChanges([
      { type: "message", op: "create", id: "a", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg("a", "ohmail/News") },
      { type: "rule", op: "create", id: "local-1", seq: ++seq, updatedAt: NOW.toISOString(), entity: rule("local-1", "INBOX") },
      { type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: copy },
    ] as SyncChange[]);
    const placeOf = consentPartition(store, { now: NOW }).placeOf;
    const stale = planScreeningChange(senderScreening(store, "a", undefined, placeOf)!, "ohbox", "sender", true, false);
    expect(stale.ruleState, "over the device's own row").toBe("already");
    const over = pressRules(store, { travels: true, queued: [], applied: [], unsettled: [], now: NOW });
    const plan = planScreeningChange(senderScreening(store, "a", undefined, placeOf, over)!, "ohbox", "sender", true, false);
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: "local-1", destination: "INBOX", applyRetro: false }]);
  });

  it("a Move back to the copy's place while a press to the Ohbox waits on the organizer retargets after it", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const copy = { mailboxId: "mb", rules: [rule("profile:mb:0", "ohmail/News")], asOf: NOW.toISOString(), from: { kind: "local", name: "Host", since: null }, updatedAt: NOW.toISOString(), applied: [] };
    await store.applyChanges([
      { type: "message", op: "create", id: "a", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg("a", "INBOX") },
      { type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: copy },
    ] as SyncChange[]);
    const key = { kind: "sender", match: ADDR, subjectContains: null, bodyContains: null };
    const move = (unsettled: Parameters<typeof pressRules>[1]["unsettled"]) => planScreeningChange(senderScreening(store, "a", undefined, undefined,
      pressRules(store, { travels: true, queued: [], applied: [], unsettled, now: NOW }))!, "reads", "sender", true, false);
    expect(move([]).ruleState, "the copy alone").toBe("already");
    const plan = move([{ kind: "rule.update", key, destination: "INBOX" }]);
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: heldRuleId(key), destination: "ohmail/News", applyRetro: false }]);
  });
});
