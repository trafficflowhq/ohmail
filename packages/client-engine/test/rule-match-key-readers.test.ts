import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HELD_RELEASE_TYPE, MemoryMirrorStore, outrankCoveringDomains, ruleFingerprint, ruleTwins, screenerSegments,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * EVERY CLIENT READER KEYS A RULE THE WAY THE ROUTER AND THE QUEUE SQL DO. `rules.match` has no
 * trim constraint, and the SQL's `trim` strips spaces only, so a match padded with a TAB names
 * nobody on the router while a space-padded one names its sender. These readers stripped every
 * whitespace and read the tab-padded rule as that sender's. Each case pins both halves.
 */

const AT = "2026-09-20T09:00:00.000Z";

function rule(o: { id?: string; kind?: RuleDTO["kind"]; match: string; destination?: Folder; priority?: number }): RuleDTO {
  return {
    id: o.id ?? "r1", kind: o.kind ?? "sender", match: o.match, destination: o.destination ?? "INBOX",
    priority: o.priority ?? 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: AT, updatedAt: AT,
  };
}

function held(from: string): EngineMessage {
  return {
    id: `m-${from}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "hello", from: { name: null, address: from }, to: [], cc: [], date: AT,
    folder: "ohmail/Screener" as Folder, snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT,
  };
}

/** The Screener's waiting senders over a mirror holding anna's mail and one held-release group. */
async function waitingWith(match: string): Promise<string[]> {
  const store = new MemoryMirrorStore();
  await store.load();
  const m = held("anna@x.test");
  const group = { id: "g1", kind: "sender", match, destination: "INBOX", count: 1, total: 1 };
  await store.applyChanges([
    { type: "message", op: "create", id: m.id, seq: 1, updatedAt: AT, entity: m },
    { type: HELD_RELEASE_TYPE, op: "create", id: group.id, seq: 2, updatedAt: AT, entity: group },
  ] as SyncChange[]);
  return screenerSegments(store, new Date(AT)).waiting.map((s) => s.from.address);
}

describe("a match padded with a tab names nobody on every client reader", () => {
  it("rule twins", () => {
    expect(ruleTwins([rule({ match: "\tanna@x.test" })], "sender", "anna@x.test")).toEqual([]);
    expect(ruleTwins([rule({ match: " Anna@X.test " })], "sender", "anna@x.test"), "CONTROL: spaces").toHaveLength(1);
  });

  it("the address rank's covering domain", () => {
    const press = { kind: "rule_create", ruleKind: "sender", match: "anna@x.test", destination: "INBOX" } as const;
    const covering = (match: string) => [rule({ kind: "domain", match, destination: "ohmail/Screened", priority: 5 })];
    expect(outrankCoveringDomains(covering("\tx.test"), press)).toBe(press);
    expect(outrankCoveringDomains(covering("  x.test "), press), "CONTROL: spaces").toMatchObject({ priority: 5 });
  });

  it("the press forecast's fingerprint", () => {
    const plain = ruleFingerprint(rule({ match: "anna@x.test" }));
    expect(ruleFingerprint(rule({ match: "\tanna@x.test" }))).not.toBe(plain);
    expect(ruleFingerprint(rule({ match: " ANNA@x.test  " })), "CONTROL: spaces").toBe(plain);
  });

  it("the held-release claim on the Screener", async () => {
    expect(await waitingWith("\tanna@x.test")).toEqual(["anna@x.test"]);
    expect(await waitingWith(" anna@x.test "), "CONTROL: spaces claim the sender").toEqual([]);
  });
});
