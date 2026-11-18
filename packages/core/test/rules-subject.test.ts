import type { AuthVerdict } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import {
  compareRules, effectForDestination, evaluateRules,
  type OhboxPolicy, type Rule,
} from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * A SECOND TERM ON A SENDER RULE — `rules.subject_contains` (mail 0050), in the evaluator.
 *
 * The case this exists for, stated as a person would: one sender sends the invoice AND
 * the nightly `[NinjaFirewall]` alert. Before this the account had one lever for that address — all
 * of it to Reads, or all of it to the Ohbox — so filing the alerts out filed the invoices with
 * them. The requirement is a rule that says BOTH things at once, and a bare sender rule beside it
 * that keeps everything else where it was.
 *
 * ── WHAT WOULD MAKE A GREEN RUN HERE WORTHLESS ─────────────────────────────────────────────
 *
 * Three ways, and each has a test written against it rather than around it:
 *
 *  1. **A term that is never consulted.** Every "the narrow rule fired" assertion would pass
 *     identically if `subject_contains` were ignored, because the narrow rule ALSO matches the
 *     sender. So the load-bearing assertion is the NEGATIVE one — the sender's other mail must NOT
 *     go where the narrow rule points — and it is asserted in the same test as the positive one,
 *     from one rule set, so neither can be green on its own.
 *  2. **A term that is consulted but never DECIDES.** Two `manual` sender rules for one address at
 *     one priority tie all the way down to a UUID comparison, so a specificity clause that does
 *     nothing is invisible half the time. `outrankingIsNotAnIdCoinToss` pins the ids so ascending
 *     id order is the OPPOSITE of what the subject rank wants — the trick `rules.pg.test.ts` uses
 *     for provenance, for the same reason it had to.
 *  3. **Absence read as a term.** `null`, `""` and `"   "` must all mean "no term". A
 *     whitespace-only term read literally passes on nearly every subject, which looks like the
 *     column working right up to the day somebody clears the field.
 *
 * Each case below was mutated and watched go red; the mutations are named at the test that catches
 * them.
 */

const UNAUTHENTICATED: AuthVerdict = "unauthenticated";

const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

function msg(from: string, subject: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject, from: { name: null, address: from }, to: [],
    date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** `effect` from the destination, exactly as `drizzle-repo.ts#listRules` derives it. */
const rule = (over: Partial<Rule>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: "sender", match: SENDER, destination,
    effect: effectForDestination(destination),
    priority: 0, provenance: "manual", enabled: true, subjectContains: null, ...over,
  };
};

const decide = (
  m: NormalizedMessage, rules: Rule[] = [], known: Set<string> = new Set([SENDER]),
  ohboxPolicy: OhboxPolicy = "people_and_replied",
) => evaluateRules({ msg: m, rules, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth: UNAUTHENTICATED, ohboxPolicy, identity: null });

/**
 * THE PAIR THE FEATURE IS FOR: one narrow rule and one broad one, for the same address.
 *
 * Identical in priority, effect, kind and provenance, so the ONLY thing that can order them is the
 * subject-term clause — and the ids are chosen so that the id tie-break would order them the WRONG
 * way if that clause did nothing. `"z-narrow" > "a-broad"`, and `compareRules` returns `-1` for the
 * winner, so a missing clause makes the broad rule win every time rather than half the time. That
 * is deliberately stronger than a coin toss: a coin toss is a flake, and a flake gets re-run.
 */
const NARROW = rule({
  id: "z-narrow", destination: "ohmail/News", subjectContains: TOKEN,
});
const BROAD = rule({ id: "a-broad", destination: "INBOX" });

describe("a sender rule with a subject term", () => {
  it("files the mail it names and leaves the sender's other mail in the Ohbox", () => {
    // ONE rule set, BOTH directions, because either assertion alone is satisfiable by a bug.
    // Deleting the `subjectSatisfies` guard from `matches` makes the second expect fail (the
    // narrow rule then claims the invoice too); reversing `subjectRank` makes the first fail.
    const rules = [NARROW, BROAD];

    const alert = decide(msg(SENDER, `${TOKEN} Alert: brute-force attempt blocked`), rules);
    expect(alert).toEqual({
      destination: "ohmail/News", matchedRuleId: "z-narrow", source: "rule",
    });

    const invoice = decide(msg(SENDER, "Rechnung 2026-08 / Invoice"), rules);
    expect(invoice).toEqual({ destination: "INBOX", matchedRuleId: "a-broad", source: "rule" });
  });

  it("matches the subject case-insensitively and anywhere in the line", () => {
    // The user reads the token off their own mail; the sender is under no obligation to keep its
    // capitalisation stable, and the token is a PREFIX in the real corpus but must not be required
    // to be one. `toLowerCase().includes(term)` is the whole claim.
    const rules = [NARROW, BROAD];
    for (const subject of [
      `${TOKEN} nightly report`,
      "[ninjafirewall] nightly report",
      "[NINJAFIREWALL] nightly report",
      `Re: fwd: ${TOKEN} nightly report`,
      `weekly digest — ${TOKEN}`,
    ]) {
      expect(decide(msg(SENDER, subject), rules).matchedRuleId, subject).toBe("z-narrow");
    }
  });

  it("does not fire for a DIFFERENT sender whose subject carries the token", () => {
    // The term NARROWS; it never widens. A stranger quoting the token in their subject must stay at
    // the gate, and a different known sender must not inherit this rule. Deleting the `case
    // "sender"` address comparison would pass every other test in this file.
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
    // The safety claim the migration and the docblock both make, as an executable statement: for
    // EVERY message, adding a term can only turn a match into a non-match. So a rule with a term
    // never produces a decision the rule without one would not have produced, and in particular
    // never pulls an unknown sender through the gate.
    const withTerm = [NARROW];
    const withoutTerm = [rule({ id: "z-narrow", destination: "ohmail/News" })];
    const subjects = [`${TOKEN} a`, "no token here", "", "   ", TOKEN.toLowerCase()];
    const senders = [SENDER, "stranger@elsewhere.example"];

    for (const from of senders) {
      for (const subject of subjects) {
        const narrowed = decide(msg(from, subject), withTerm, new Set([SENDER]));
        const bare = decide(msg(from, subject), withoutTerm, new Set([SENDER]));
        const label = `${from} / ${JSON.stringify(subject)}`;
        // Either the term changed nothing, or it took the rule out of play — and when it takes the
        // rule out of play the answer is the gate or a heuristic, never a different rule's folder.
        if (narrowed.matchedRuleId !== bare.matchedRuleId) {
          expect(narrowed.matchedRuleId, label).toBeNull();
        }
      }
    }
  });

  it("treats an absent subject as satisfying no term", () => {
    // `mime.ts` writes `""` for a message with no `Subject` header, so this is a real shape and not
    // a synthetic one. `"".includes(term)` is false for every non-empty term, which is the
    // fail-closed direction for a narrowing conjunct: the broad rule takes it.
    expect(decide(msg(SENDER, ""), [NARROW, BROAD]).matchedRuleId).toBe("a-broad");
    expect(decide(msg(SENDER, ""), [NARROW]).matchedRuleId).toBeNull();
  });

  it("reads null, empty and whitespace-only terms as NO term", () => {
    // The three representations of absence. The database forbids the last two
    // (`rules_subject_contains_nonempty`), and this is asserted anyway because a CHECK constrains
    // rows the migration reached and says nothing about a fixture, a `sidecar` mirror row or an
    // older client's echo. A `"   "` read literally would match almost every subject — the failure
    // that looks exactly like the feature working.
    for (const term of [null, "", "   ", "\t\n"]) {
      const only = [rule({ id: "z-narrow", destination: "ohmail/News", subjectContains: term })];
      expect(decide(msg(SENDER, "anything at all"), only).matchedRuleId, JSON.stringify(term))
        .toBe("z-narrow");
    }
  });

  it("is honoured on a domain rule too, because such a row is representable", () => {
    // `RulesService` refuses a term on anything but `sender`, but `kind` reaches the evaluator
    // through an unvalidated `as` cast off a bare `text` column. The fail-closed reading is to
    // APPLY a stored term whatever the kind: ignoring it would make this row match every subject
    // while its own data says it is specific. Restricting `subjectSatisfies` to `kind === "sender"`
    // makes the second expect fail.
    const domainNarrow = rule({
      id: "d", kind: "domain", match: "sichersatt.example",
      destination: "ohmail/News", subjectContains: TOKEN,
    });
    expect(decide(msg(SENDER, `${TOKEN} x`), [domainNarrow]).matchedRuleId).toBe("d");
    expect(decide(msg(SENDER, "invoice"), [domainNarrow]).matchedRuleId).toBeNull();
  });
});

describe("the order: a subject term is specificity", () => {
  it("outranks a bare rule for the same address, and NOT by an id coin toss", () => {
    // `compareRules` is ascending-wins. The ids are chosen so the final tie-break would order these
    // two the OTHER way, which is what makes this non-vacuous: delete the `subjectRank` clause and
    // this goes red deterministically rather than half the time.
    expect(NARROW.id > BROAD.id).toBe(true);
    expect(compareRules(NARROW, BROAD)).toBeLessThan(0);
    expect(compareRules(BROAD, NARROW)).toBeGreaterThan(0);
    expect([BROAD, NARROW].sort(compareRules).map((r) => r.id)).toEqual(["z-narrow", "a-broad"]);
  });

  it("does not reach across kinds — a domain rule with a term still loses to any sender rule", () => {
    // The clause sits BELOW `kind` deliberately: it refines a claim about the same principal. A
    // subject term is not a licence to outrank a more specific principal, or a domain rule with a
    // term would beat the user's own address rule. Moving `subjectRank` above the `kind` clause
    // makes this go red.
    const domainWithTerm = rule({
      id: "a-domain", kind: "domain", match: "sichersatt.example",
      destination: "ohmail/News", subjectContains: TOKEN,
    });
    const senderBare = rule({ id: "z-sender", destination: "INBOX" });
    expect(compareRules(senderBare, domainWithTerm)).toBeLessThan(0);
    expect(decide(msg(SENDER, `${TOKEN} x`), [domainWithTerm, senderBare]).matchedRuleId)
      .toBe("z-sender");
  });

  it("loses to a higher numeric priority and to a deny, which are both above it", () => {
    // Priority is the user-facing dial and `deny` is their explicit no; neither may be overturned by
    // a term. `evaluateRules` returns the deny rule's own destination, so this is also the assertion
    // that a subject rule cannot be used to sneak a sender past a screen-out.
    const louder = rule({ id: "z-louder", destination: "INBOX", priority: 5 });
    expect(decide(msg(SENDER, `${TOKEN} x`), [NARROW, louder]).matchedRuleId).toBe("z-louder");

    const deny = rule({ id: "z-deny", destination: "ohmail/Screened" });
    const d = decide(msg(SENDER, `${TOKEN} x`), [NARROW, deny]);
    expect(d).toEqual({
      destination: "ohmail/Screened", matchedRuleId: "z-deny", source: "rule",
    });
  });

  it("ranks a whitespace-only term as BARE, so the matcher and the order agree", () => {
    // The two must classify a row identically. If the ORDER treated `"  "` as a term while the
    // MATCHER treated it as absent, the `"  "` rule would win the tie and then fire on everything —
    // which is not merely inconsistent, it is the widening this column is designed to be incapable
    // of. Changing `subjectRank` to `r.subjectContains === null ? 1 : 0` makes this go red.
    const blank = rule({ id: "z-blank", destination: "ohmail/News", subjectContains: "   " });
    const bare = rule({ id: "a-bare", destination: "INBOX" });
    expect(compareRules(blank, bare)).toBeGreaterThan(0);   // the id tie-break decides, not the term
    expect(decide(msg(SENDER, "invoice"), [blank, bare]).matchedRuleId).toBe("a-bare");
  });

  it("is a total order still — the comparator never returns 0 for two distinct ids", () => {
    // The property the whole comparator exists for, re-checked over a set that now includes the new
    // clause in both states. A `NaN` or a `0` here is a comparator that is not an order at all.
    const set = [NARROW, BROAD, rule({ id: "m", destination: "ohmail/Receipts", subjectContains: "Rechnung" })];
    for (const a of set) {
      for (const b of set) {
        if (a.id === b.id) continue;
        expect(compareRules(a, b), `${a.id} vs ${b.id}`).not.toBe(0);
        expect(Number.isNaN(compareRules(a, b))).toBe(false);
      }
    }
  });
});
