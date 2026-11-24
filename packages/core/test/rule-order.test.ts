import type { AuthVerdict } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import {
  compareRules, effectForDestination, evaluateRules, standingRule,
  type Rule,
} from "../src/rules.js";
import { effectForDestination as leafEffect } from "../src/rule-order.js";
import { DESTINATIONS, LEGACY_NEWS_FOLDER, type NormalizedMessage } from "../src/types.js";

/**
 * THE ORDER'S KIND OUTRANKS ITS EFFECT (FIX-024).
 *
 * A person the account allowed BY NAME used to be screened out by a deny rule on their domain:
 * `compareRules` ranked deny over allow before it asked how narrowly each rule names the sender,
 * so the router filed their new mail to Screened. The order now asks the kind first, and deny over
 * allow decides only between rules of one kind — the same shape the pinned term cases keep: a
 * term never overturns a screen-out (`rules-subject`, `rules-body`).
 */

const PERSON = "person@shop.example";
const OTHER = "other@shop.example";

function msg(from: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "hello", from: { name: null, address: from }, to: [], cc: [],
    date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

const rule = (over: Partial<Rule>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: "sender", match: PERSON, destination, effect: effectForDestination(destination),
    priority: 0, provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null, ...over,
  };
};

const decide = (from: string, rules: Rule[]) => evaluateRules({
  msg: msg(from), rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated" as AuthVerdict, ohboxPolicy: "people_and_replied", identity: null,
});

const NAMED_ALLOW = rule({ id: "z-named", destination: "INBOX" });
const DOMAIN_DENY = rule({ id: "a-domain", kind: "domain", match: "shop.example", destination: "ohmail/Screened", provenance: "manual" });

describe("a person allowed by name is not screened out by a rule on their domain", () => {
  it("the router files their new mail by the address rule", () => {
    // Ids and provenance both favour the domain rule, so only the kind clause can decide.
    expect(compareRules(NAMED_ALLOW, DOMAIN_DENY)).toBeLessThan(0);
    for (const rules of [[NAMED_ALLOW, DOMAIN_DENY], [DOMAIN_DENY, NAMED_ALLOW]]) {
      expect(decide(PERSON, rules)).toEqual({ destination: "INBOX", matchedRuleId: "z-named", source: "rule" });
      expect(standingRule(rules, PERSON)?.id).toBe("z-named");
    }
  });

  it("and the domain rule still holds everybody it names who has no rule of their own", () => {
    expect(decide(OTHER, [NAMED_ALLOW, DOMAIN_DENY])).toEqual({ destination: "ohmail/Screened", matchedRuleId: "a-domain", source: "rule" });
  });

  it("deny still outranks allow between two rules of one kind, and priority still outranks the kind", () => {
    const hold = rule({ id: "z-hold", destination: "ohmail/Screened" });
    expect(decide(PERSON, [NAMED_ALLOW, hold]).destination).toBe("ohmail/Screened");
    const loud = rule({ id: "z-loud", kind: "domain", match: "shop.example", destination: "ohmail/Screened", priority: 5 });
    expect(decide(PERSON, [NAMED_ALLOW, loud]).destination).toBe("ohmail/Screened");
  });
});

describe("the leaf's destination mapping is the router's", () => {
  it("agrees on every destination, the pre-0.22 spelling and a value outside the union", () => {
    const deny = new Set(["ohmail/Screener", "ohmail/Screened", "ohmail/Quarantine"]);
    expect(DESTINATIONS.length).toBe(6);
    for (const d of DESTINATIONS) {
      expect(leafEffect(d)).toBe(effectForDestination(d));
      expect(leafEffect(d)).toBe(deny.has(d) ? "deny" : "allow");
    }
    for (const odd of [LEGACY_NEWS_FOLDER, "Projects", "constructor", ""]) expect(leafEffect(odd)).toBe("allow");
  });
});
