import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { effectForDestination, standingRule, type Rule } from "@trafficflow/core/mail";
import {
  MemoryMirrorStore,
  consentIndex,
  consentPartition,
  decidedDestination,
  rulesList,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ONE ORDER FOR A SENDER'S RULES, ON THE SERVER AND ON EVERY CLIENT.
 *
 * The router files a sender's mail by core `standingRule` (the minimum under `compareRules`); the
 * clients present that sender's INBOX mail by `consentIndex` + `decidedDestination`. Each pair
 * below is one where the client's old order (newest-created first, the first admitting twin wins,
 * the address before its domain) and the router's disagreed. Every case asks the client for the
 * router's answer, in both input orders, and once through the partition a person sees.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const OLDER = "2026-09-01T08:00:00.000Z";
const NEWER = "2026-09-07T08:00:00.000Z";
const ADDR = "person@shop.example";
let seq = 0;

type R = Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">;

function rule(o: R): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "promoted", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: OLDER, updatedAt: OLDER,
    subjectContains: null, bodyContains: null, ...o,
  };
}

/** The mirror row as the router's adapter maps it: the effect is the destination's side of the gate. */
function asCore(r: RuleDTO): Rule {
  return {
    id: r.id, kind: r.kind, match: r.match, destination: r.destination as Rule["destination"],
    effect: effectForDestination(r.destination as Rule["destination"]), priority: r.priority,
    provenance: r.provenance, enabled: r.enabled,
    subjectContains: r.subjectContains ?? null, bodyContains: r.bodyContains ?? null,
  };
}

function inbox(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: ADDR }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-20T09:00:00.000Z",
  };
}

async function mirrorOf(rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(), entity: inbox("m1") },
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return store;
}

/** Each pair: the router's answer, and what the client's old order answered instead. */
const CASES: Array<{ name: string; rules: RuleDTO[]; router: Folder; oldClient: Folder }> = [
  {
    name: "two admitting twins tie on everything: the id decides, not the newer instant",
    rules: [rule({ id: "9-newer", destination: "INBOX", createdAt: NEWER }), rule({ id: "1-older", destination: "ohmail/Receipts" })],
    router: "ohmail/Receipts", oldClient: "INBOX",
  },
  {
    name: "an admitting twin and a holding twin: deny over allow",
    rules: [rule({ id: "1-newer", destination: "INBOX", createdAt: NEWER }), rule({ id: "9-older", destination: "ohmail/Screened" })],
    router: "ohmail/Screened", oldClient: "INBOX",
  },
  {
    name: "a subject-narrowed admission beside a screen-out: the term never overturns the deny",
    rules: [rule({ id: "1-term", destination: "ohmail/News", subjectContains: "digest", createdAt: NEWER }), rule({ id: "9-bare", destination: "ohmail/Screened" })],
    router: "ohmail/Screened", oldClient: "ohmail/News",
  },
  {
    name: "a higher-priority domain rule over a named hold: priority first",
    rules: [rule({ id: "1-sender", destination: "ohmail/Screened" }), rule({ id: "9-domain", kind: "domain", match: "shop.example", destination: "ohmail/News", priority: 10 })],
    router: "ohmail/News", oldClient: "ohmail/Screened",
  },
  {
    name: "what the user typed outranks the onboarding seed",
    rules: [rule({ id: "1-seed", destination: "INBOX", provenance: "seeded-from-sent", createdAt: NEWER }), rule({ id: "9-manual", destination: "ohmail/Receipts", provenance: "manual" })],
    router: "ohmail/Receipts", oldClient: "INBOX",
  },
];

describe("a sender's competing rules decide the same way on the client as in the router", () => {
  it.each(CASES)("$name", async ({ rules, router, oldClient }) => {
    // The pair is a real disagreement: the router's answer is not the one the old order gave.
    expect(router).not.toBe(oldClient);
    expect(standingRule(rules.map(asCore), ADDR)?.destination).toBe(router);
    for (const input of [rules, [...rules].reverse()]) {
      expect(decidedDestination(consentIndex(input), ADDR)).toBe(router);
    }
    // And where a person sees it — INVERTED by ARCH-R902: the order decides the
    // sender's STANDING; an INBOX letter no rule moved stays in the INBOX unless the winner denies.
    const store = await mirrorOf(rules);
    expect(decidedDestination(consentIndex(rulesList(store)), ADDR)).toBe(router);
    expect(consentPartition(store, { now: NOW }).placeOf.get("m1"))
      .toBe(effectForDestination(router as Rule["destination"]) === "deny" ? router : "INBOX");
  });

  it("a subject-narrowed twin outranks the bare rule it refines, for the mail its term names only", async () => {
    // The router files the digest by the narrowed rule and everything else by the bare one; the
    // sender's one destination is the bare rule's, and each message presents where it is filed.
    const rules = [rule({ id: "1-bare", destination: "INBOX", createdAt: NEWER }), rule({ id: "9-term", destination: "ohmail/News", subjectContains: "digest" })];
    for (const input of [rules, [...rules].reverse()]) expect(decidedDestination(consentIndex(input), ADDR)).toBe("INBOX");
    const store = await mirrorOf(rules);
    await store.applyChanges([
      { type: "message", op: "create", id: "m2", seq: ++seq, updatedAt: NOW.toISOString(), entity: { ...inbox("m2"), subject: "The weekly digest" } },
    ] as SyncChange[]);
    // INVERTED by ARCH-R902: m2 never filed stays in the INBOX; the router's filing arrives as its folder.
    const placeOf = consentPartition(store, { now: NOW }).placeOf;
    expect(placeOf.get("m2")).toBe("INBOX");
    expect(placeOf.get("m1")).toBe("INBOX");
  });

  it("a person allowed by name is never screened out by a rule on their domain, on either side", async () => {
    // The kind outranks the effect: the address rule is the narrower claim about who this is.
    const rules = [rule({ id: "9-sender", destination: "INBOX" }), rule({ id: "1-domain", kind: "domain", match: "shop.example", destination: "ohmail/Screened" })];
    expect(standingRule(rules.map(asCore), ADDR)?.destination).toBe("INBOX");
    for (const input of [rules, [...rules].reverse()]) expect(decidedDestination(consentIndex(input), ADDR)).toBe("INBOX");
    expect(consentPartition(await mirrorOf(rules), { now: NOW }).placeOf.get("m1")).toBe("INBOX");
    // And somebody else at that domain, named by no rule of their own, is held by it.
    expect(decidedDestination(consentIndex(rules), "other@shop.example")).toBe("ohmail/Screened");
  });

  it("admits the ordinary case: one rule decides, and a disabled or Screener-pointing twin decides nothing", () => {
    const one = [rule({ id: "1", destination: "ohmail/News" })];
    expect(decidedDestination(consentIndex(one), ADDR)).toBe("ohmail/News");
    const inert = [...one, rule({ id: "0", destination: "ohmail/Screened", enabled: false }), rule({ id: "00", destination: "ohmail/Screener" })];
    expect(decidedDestination(consentIndex(inert), ADDR)).toBe("ohmail/News");
    expect(decidedDestination(consentIndex([]), ADDR)).toBeNull();
  });
});
