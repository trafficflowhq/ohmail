import type { AuthVerdict } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import {
  compareRules, effectForDestination, evaluateRules,
  type OhboxPolicy, type Rule,
} from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * A THIRD TERM ON A SENDER RULE — `rules.body_contains` (mail 0052), in the evaluator.
 *
 * The case, stated as a person would: a sender writes the SAME subject on every message —
 * "Notification" — and the text of the nightly `[NinjaFirewall]` alert is what distinguishes it
 * from the invoice. A subject term cannot split that sender; the body term is the same
 * conjunction one field deeper.
 *
 * `rules-subject.test.ts` names the three ways a green run here would be about nothing, and each
 * applies verbatim with "subject" replaced by "body": a term never consulted (so the NEGATIVE
 * assertion is in the same test as the positive one), a term that never DECIDES (so the ids are
 * pinned to make the id tie-break the wrong answer), and absence read as a term (so `null`, `""`
 * and blanks are asserted to mean "no term"). One direction is NEW here and has no subject
 * analogue: a subject-carrying rule and a body-carrying rule for one address must order
 * deterministically, and a rule carrying BOTH terms must beat either single-term rule.
 *
 * Each case below was mutated and watched go red; the mutations are named at the test that
 * catches them.
 */

const UNAUTHENTICATED: AuthVerdict = "unauthenticated";

const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

function msg(from: string, textBody: string, subject = "Notification"): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject, from: { name: null, address: from }, to: [], cc: [],
    date: null, headers: {}, textBody, htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** `effect` from the destination, exactly as `drizzle-repo.ts#listRules` derives it. */
const rule = (over: Partial<Rule>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: "sender", match: SENDER, destination,
    effect: effectForDestination(destination),
    priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, ...over,
  };
};

const decide = (
  m: NormalizedMessage, rules: Rule[] = [], known: Set<string> = new Set([SENDER]),
  ohboxPolicy: OhboxPolicy = "people_and_replied",
) => evaluateRules({ msg: m, rules, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth: UNAUTHENTICATED, ohboxPolicy, identity: null });

/**
 * The pair the feature is for: one body-narrowed rule and one broad one, same address. Identical
 * in priority, effect, kind, provenance and (absent) subject term, so only the body clause can
 * order them — and the ids are chosen so the id tie-break orders them the WRONG way. A missing
 * clause makes the broad rule win every time, deterministically, not half the time.
 */
const NARROW = rule({
  id: "z-narrow", destination: "ohmail/News", bodyContains: TOKEN,
});
const BROAD = rule({ id: "a-broad", destination: "INBOX" });

describe("a sender rule with a body term", () => {
  it("files the mail whose text carries the term and leaves the sender's other mail alone", () => {
    // ONE rule set, BOTH directions — either assertion alone is satisfiable by a bug. Deleting
    // the `bodySatisfies` conjunct from `matches` makes the second expect fail (the narrow rule
    // then claims the invoice too); reversing `bodyRank` makes the first fail.
    const rules = [NARROW, BROAD];

    const alert = decide(msg(SENDER, `${TOKEN} brute-force attempt blocked on example.com`), rules);
    expect(alert).toEqual({
      destination: "ohmail/News", matchedRuleId: "z-narrow", source: "rule",
    });

    const invoice = decide(msg(SENDER, "Rechnung 2026-08. Zahlbar in 30 Tagen."), rules);
    expect(invoice).toEqual({ destination: "INBOX", matchedRuleId: "a-broad", source: "rule" });
  });

  it("matches the text case-insensitively and anywhere in the body", () => {
    // The sender is under no obligation to keep capitalisation stable, and the tag may sit at
    // the top or in a footer. `toLowerCase().includes(term)` is the whole claim.
    const rules = [NARROW, BROAD];
    for (const text of [
      `${TOKEN} nightly report`,
      "[ninjafirewall] nightly report",
      "[NINJAFIREWALL] nightly report",
      `Your site was scanned.\n\n${TOKEN}\nUnsubscribe here.`,
      `prose before — ${TOKEN.toLowerCase()} — prose after`,
    ]) {
      expect(decide(msg(SENDER, text), rules).matchedRuleId, JSON.stringify(text)).toBe("z-narrow");
    }
  });

  it("does not fire for a DIFFERENT sender whose text carries the token", () => {
    // The term NARROWS; it never widens. A stranger quoting the token stays at the gate, and a
    // different known sender does not inherit the rule. Deleting the `case "sender"` address
    // comparison would pass every other test in this file.
    const rules = [NARROW, BROAD];

    const stranger = decide(
      msg("someone@elsewhere.example", `${TOKEN} you have won`), rules, new Set([SENDER]),
    );
    expect(stranger).toEqual({
      destination: "ohmail/Screener", matchedRuleId: null, source: "screener",
    });

    const otherKnown = decide(
      msg("colleague@example.com", `${TOKEN} fyi`), rules,
      new Set([SENDER, "colleague@example.com"]),
    );
    expect(otherKnown.matchedRuleId).toBeNull();
  });

  it("cannot admit a sender the same rule without a term would have refused", () => {
    // The migration's safety claim as an executable statement: for EVERY message, adding a body
    // term can only turn a match into a non-match — never a refusal into an admission.
    const withTerm = [NARROW];
    const withoutTerm = [rule({ id: "z-narrow", destination: "ohmail/News" })];
    const texts = [`${TOKEN} a`, "no token here", "", "   ", TOKEN.toLowerCase()];
    const senders = [SENDER, "stranger@elsewhere.example"];

    for (const from of senders) {
      for (const text of texts) {
        const narrowed = decide(msg(from, text), withTerm, new Set([SENDER]));
        const bare = decide(msg(from, text), withoutTerm, new Set([SENDER]));
        const label = `${from} / ${JSON.stringify(text)}`;
        if (narrowed.matchedRuleId !== bare.matchedRuleId) {
          expect(narrowed.matchedRuleId, label).toBeNull();
        }
      }
    }
  });

  it("treats an empty body as satisfying no term — the retro passes' body-less row", () => {
    // This is the REAL shape of the seam, not a synthetic one: a message whose `message_bodies`
    // row does not exist reaches the retro/tidy/rescreen passes as `textBody: ""`, and ingest
    // writes `""` for a message with no text part it could derive. `"".includes(term)` is false
    // for every non-empty term — fail-closed, the broad rule takes it and nothing moves on the
    // strength of a body nobody could read.
    expect(decide(msg(SENDER, ""), [NARROW, BROAD]).matchedRuleId).toBe("a-broad");
    expect(decide(msg(SENDER, ""), [NARROW]).matchedRuleId).toBeNull();
  });

  it("reads null, empty and whitespace-only terms as NO term", () => {
    // The three representations of absence. The database forbids the last two
    // (`rules_body_contains_nonempty`), asserted here anyway because a CHECK constrains rows the
    // migration reached, not a fixture or a mirror row. A blank read literally would match every
    // message — for a body term literally every one, since every message has a body to substring.
    for (const term of [null, "", "   ", "\t\n"]) {
      const only = [rule({ id: "z-narrow", destination: "ohmail/News", bodyContains: term })];
      expect(decide(msg(SENDER, "anything at all"), only).matchedRuleId, JSON.stringify(term))
        .toBe("z-narrow");
    }
  });

  it("is honoured on a domain rule too, because such a row is representable", () => {
    // `RulesService` refuses a term on anything but `sender`, but `kind` reaches the evaluator
    // through an unvalidated cast off a bare `text` column. A stored term is always applied —
    // ignoring it would make the row match every message while its data says it is specific.
    const domainNarrow = rule({
      id: "d", kind: "domain", match: "sichersatt.example",
      destination: "ohmail/News", bodyContains: TOKEN,
    });
    expect(decide(msg(SENDER, `${TOKEN} x`), [domainNarrow]).matchedRuleId).toBe("d");
    expect(decide(msg(SENDER, "invoice text"), [domainNarrow]).matchedRuleId).toBeNull();
  });

  it("composes with a subject term — BOTH must hold", () => {
    // The two conjuncts are independent, and a rule may carry both. Either one failing takes the
    // rule out of play; this is what "conjunction" means and it is asserted in all four states.
    const both = rule({
      id: "z-both", destination: "ohmail/News",
      subjectContains: "Alert", bodyContains: TOKEN,
    });
    const fire = (subject: string, text: string) =>
      decide(msg(SENDER, text, subject), [both, BROAD]).matchedRuleId;
    expect(fire("Alert: nightly", `${TOKEN} details`)).toBe("z-both");
    expect(fire("Alert: nightly", "no token")).toBe("a-broad");
    expect(fire("Invoice", `${TOKEN} details`)).toBe("a-broad");
    expect(fire("Invoice", "no token")).toBe("a-broad");
  });
});

describe("the order: a body term is specificity", () => {
  it("outranks a bare rule for the same address, and NOT by an id coin toss", () => {
    // Ascending-wins; the ids are chosen so the final tie-break would order these the OTHER way.
    // Delete the `bodyRank` clause from `compareRules` and this goes red deterministically.
    expect(NARROW.id > BROAD.id).toBe(true);
    expect(compareRules(NARROW, BROAD)).toBeLessThan(0);
    expect(compareRules(BROAD, NARROW)).toBeGreaterThan(0);
    expect([BROAD, NARROW].sort(compareRules).map((r) => r.id)).toEqual(["z-narrow", "a-broad"]);
  });

  it("ranks BELOW a subject term: subject-only beats body-only, both-terms beats subject-only", () => {
    // THE DIRECTION THAT HAS NO SUBJECT ANALOGUE, pinned so the two statements of the order (this
    // comparator and the SQL) cannot drift apart silently. The ids are nudged against every
    // clause under test: ascending id order is the opposite of what each clause wants.
    const bodyOnly = rule({ id: "a-body", destination: "ohmail/News", bodyContains: TOKEN });
    const subjectOnly = rule({ id: "z-subject", destination: "ohmail/News", subjectContains: "Alert" });
    const both = rule({
      id: "z-zboth", destination: "ohmail/News", subjectContains: "Alert", bodyContains: TOKEN,
    });
    // subject-only beats body-only (the subject clause fires first)…
    expect(compareRules(subjectOnly, bodyOnly)).toBeLessThan(0);
    // …and both-terms beats subject-only (it loses neither clause).
    expect(compareRules(both, subjectOnly)).toBeLessThan(0);
    expect([bodyOnly, subjectOnly, both].sort(compareRules).map((r) => r.id))
      .toEqual(["z-zboth", "z-subject", "a-body"]);
  });

  it("does not reach across kinds — a domain rule with a term still loses to any sender rule", () => {
    // The clause sits BELOW `kind`: it refines a claim about the same principal. Moving
    // `bodyRank` above the `kind` clause makes this go red.
    const domainWithTerm = rule({
      id: "a-domain", kind: "domain", match: "sichersatt.example",
      destination: "ohmail/News", bodyContains: TOKEN,
    });
    const senderBare = rule({ id: "z-sender", destination: "INBOX" });
    expect(compareRules(senderBare, domainWithTerm)).toBeLessThan(0);
    expect(decide(msg(SENDER, `${TOKEN} x`), [domainWithTerm, senderBare]).matchedRuleId)
      .toBe("z-sender");
  });

  it("loses to a higher numeric priority and to a deny, which are both above it", () => {
    // Priority is the user-facing dial and `deny` is their explicit no; neither may be overturned
    // by a term — so a body rule cannot sneak a sender past a screen-out.
    const louder = rule({ id: "z-louder", destination: "INBOX", priority: 5 });
    expect(decide(msg(SENDER, `${TOKEN} x`), [NARROW, louder]).matchedRuleId).toBe("z-louder");

    const deny = rule({ id: "z-deny", destination: "ohmail/Screened" });
    const d = decide(msg(SENDER, `${TOKEN} x`), [NARROW, deny]);
    expect(d).toEqual({
      destination: "ohmail/Screened", matchedRuleId: "z-deny", source: "rule",
    });
  });

  it("ranks a whitespace-only term as BARE, so the matcher and the order agree", () => {
    // The two must classify a row identically, or the blank rule wins its tie in the order and
    // then declines to fire — a rule matching everything. Changing `bodyRank` to
    // `r.bodyContains === null ? 1 : 0` makes this go red.
    const blank = rule({ id: "z-blank", destination: "ohmail/News", bodyContains: "   " });
    const bare = rule({ id: "a-bare", destination: "INBOX" });
    expect(compareRules(blank, bare)).toBeGreaterThan(0);   // the id tie-break decides, not the term
    expect(decide(msg(SENDER, "invoice text"), [blank, bare]).matchedRuleId).toBe("a-bare");
  });

  it("is a total order still — the comparator never returns 0 for two distinct ids", () => {
    const set = [
      NARROW, BROAD,
      rule({ id: "m", destination: "ohmail/Receipts", bodyContains: "Rechnung" }),
      rule({ id: "s", destination: "ohmail/News", subjectContains: "Alert" }),
      rule({ id: "b", destination: "ohmail/News", subjectContains: "Alert", bodyContains: TOKEN }),
    ];
    for (const a of set) {
      for (const b of set) {
        if (a.id === b.id) continue;
        expect(compareRules(a, b), `${a.id} vs ${b.id}`).not.toBe(0);
        expect(Number.isNaN(compareRules(a, b))).toBe(false);
      }
    }
  });
});
