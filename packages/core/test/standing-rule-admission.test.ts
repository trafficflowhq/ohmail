import { describe, it, expect } from "vitest";
import {
  effectForDestination, evaluateRules, senderIsDecided, standingRule,
  type AuthVerdict, type OhboxPolicy, type Rule,
} from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * ═══ A RULE YOU WROTE APPLIES TO THE MAIL THAT ARRIVES AFTER IT ════════════════════════════
 *
 * ── THE DEFECT, MEASURED AT THIS LANE'S BASE ───────────────────────────────────────────────
 *
 * A sender carrying an enabled rule with a SUBJECT or BODY term had every message of theirs the
 * term did not name held at the consent gate. Meanwhile both consent surfaces read that sender as
 * DECIDED — `packages/services/src/consent-cutline.ts`' `decided_sender`/`decided_domain` CTEs
 * and the client's `consent-cutline.ts#consentIndex`, whose own comment is "terms narrow
 * placement, never admission. Never add a term check here." So one message was presented in the
 * Ohbox by the rule's projection and listed behind a Screener waiting row by the gate, at the
 * same time. Driven through the real pipeline in `packages/services/test/ruled-sender-one-list.pg.test.ts`,
 * the base answered `desired_folder = 'ohmail/Screener'`, one waiting row, and
 * `cutlineCounts` `decidedSenders: 1, activeUndecidedSenders: 0` — the two ends, one account,
 * two answers.
 *
 * Two implementations of one question is what produced it. {@link standingRule} is the routing
 * side of the predicate those two already spell, and {@link namesAuthor} is now the one place the
 * sender/domain claim is written.
 *
 * ── THE TWO ARMS, AND WHY THEY DIFFER ──────────────────────────────────────────────────────
 *
 * An ADMISSION admits and does not PLACE. The standing arm is reached ONLY when a term did not
 * match — a rule with no term always claims the message and never gets here — so filing to that
 * rule's destination would make the term inert for everything else that sender writes, which is
 * the one thing terms exist to prevent. The admitted message takes the ordinary post-gate path.
 *
 * A DENIAL is carried out, above `auth` and above everything, as every denial in this function
 * is: a sender the person said no to is never re-admitted, and the destination is the one the
 * person named.
 *
 * ── MUTATIONS WATCHED (each applied, watched RED, restored, `cmp`-proven identical) ────────
 *
 * Named at the case each one reddens; the run counts are in `changes/fix-018-ruled-senders-applied-after.md`.
 */

const UNAUTH: AuthVerdict = "unauthenticated";
const NARROW = "partner@bank.example";

function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "the quarterly figures", from: { name: null, address: NARROW }, to: [], cc: [],
    date: null, headers: { from: [NARROW] }, textBody: "the numbers are in the attachment",
    htmlBody: null, hasAttachments: false, attachments: [], ...over,
  };
}

const rule = (over: Partial<Rule> = {}): Rule => {
  const destination = over.destination ?? "ohmail/News";
  return {
    id: "r1", kind: "sender", match: NARROW, destination,
    effect: effectForDestination(destination),
    priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, ...over,
  };
};

const decide = (
  rules: Rule[], known: Set<string> = new Set(), auth: AuthVerdict = UNAUTH,
  ohboxPolicy: OhboxPolicy = "people_and_replied", m: NormalizedMessage = msg(),
) => evaluateRules({ msg: m, rules, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth, ohboxPolicy, identity: null });

describe("a narrowed rule decides about the SENDER, not only the mail it names", () => {
  /**
   * THE DEFECT ITSELF, on the subject term.
   *
   * MUTATION: delete the `standingRule` consult from `evaluateRules`, restoring
   * `if (!isKnownAuthor(author, knownSenders)) return screened;` ⇒ this case and the five below
   * it RED, `source: "screener"` for every one.
   */
  it("a subject-narrowed rule's sender is admitted for mail the term does not name", () => {
    const d = decide([rule({ subjectContains: "invoice" })]);
    expect(d.destination).not.toBe("ohmail/Screener");
    expect(d.source).not.toBe("screener");
  });

  it("a body-narrowed rule's sender is admitted the same way", () => {
    const d = decide([rule({ bodyContains: "unsubscribe" })]);
    expect(d.source).not.toBe("screener");
  });

  it("a DOMAIN rule with a term admits the whole domain's senders", () => {
    const d = decide([rule({ kind: "domain", match: "bank.example", subjectContains: "invoice" })]);
    expect(d.source).not.toBe("screener");
  });

  /**
   * THE HALF THAT KEEPS THE TERM DOING ITS JOB — the load-bearing negative.
   *
   * The admission must not FILE the mail where the narrowed rule points, or the term would be
   * inert for everything else that sender writes.
   *
   * MUTATION: return `{ destination: standing.destination, matchedRuleId: standing.id,
   * source: "rule" }` from the admitting arm ⇒ this case RED (`ohmail/News` for
   * `ohmail/Receipts`/`null`), and `rule-retro`'s narrowed backlog would move with it.
   */
  it("the admission does NOT file the mail at the narrowed rule's destination", () => {
    const d = decide([rule({ destination: "ohmail/News", subjectContains: "invoice" })]);
    expect(d.destination).not.toBe("ohmail/News");
    expect(d.matchedRuleId).toBeNull();
  });

  /** POSITIVE CONTROL for the pair: the mail the term DOES name still goes where the rule says. */
  it("the mail the term names is still filed by the rule, unchanged", () => {
    const d = decide([rule({ destination: "ohmail/News", subjectContains: "quarterly" })]);
    expect(d).toMatchObject({ destination: "ohmail/News", matchedRuleId: "r1", source: "rule" });
  });

  /**
   * A DENIAL IS CARRIED OUT, not re-asked.
   *
   * MUTATION: drop the deny arm (fall through to the admission) ⇒ this case RED, the denied
   * sender's mail admitted to the ordinary post-gate path.
   */
  it("a narrowed DENY rule sends the sender's other mail where the deny says", () => {
    const d = decide([rule({ destination: "ohmail/Quarantine", subjectContains: "invoice" })]);
    expect(d).toMatchObject({
      destination: "ohmail/Quarantine", matchedRuleId: "r1", source: "rule",
    });
  });

  /**
   * THE DENIAL OUTRANKS `auth`, exactly as the claiming-rule deny does.
   *
   * MUTATION: move the deny arm below `if (auth === "fail") return screened;` ⇒ RED.
   */
  it("the denial is carried out even when the message failed authentication", () => {
    const d = decide([rule({ destination: "ohmail/Screened", subjectContains: "invoice" })], new Set(), "fail");
    expect(d.destination).toBe("ohmail/Screened");
  });
});

describe("the admission is an admission and nothing more", () => {
  /**
   * A FORGED `From` NAMING A DECIDED SENDER IS STILL SCREENED.
   *
   * The whole point of `auth === "fail"`: reading it may DEMOTE, never admit. A standing decision
   * about a person is not a standing decision about somebody spoofing them.
   *
   * MUTATION: return the admission above the `auth` check ⇒ RED, `null`/`unclear` for `screener`.
   */
  it("`auth === \"fail\"` still screens an admitted sender's message", () => {
    const d = decide([rule({ subjectContains: "invoice" })], new Set(), "fail");
    expect(d).toMatchObject({ destination: "ohmail/Screener", source: "screener" });
  });

  /**
   * A RULE POINTING AT THE SCREENER IS THE ABSENCE OF A DECISION WRITTEN DOWN — the same
   * exclusion `consentIndex` and `decided_sender` make, so a sender whose only rule is that one
   * is still asked about on all three surfaces.
   *
   * MUTATION: drop the `destination === "ohmail/Screener"` skip from {@link standingRule} ⇒ RED:
   * the sender is admitted, and a queue nobody can empty follows.
   */
  it("a rule pointing AT the Screener is not a standing decision", () => {
    const d = decide([rule({ destination: "ohmail/Screener", subjectContains: "invoice" })]);
    expect(d).toMatchObject({ destination: "ohmail/Screener", source: "screener" });
    expect(standingRule([rule({ destination: "ohmail/Screener" })], NARROW)).toBeNull();
  });

  /**
   * A DISABLED rule decides nothing — the first skip in both spellings of the predicate.
   *
   * MUTATION: drop `if (!r.enabled) continue;` from {@link standingRule} ⇒ RED.
   */
  it("a disabled rule is not a standing decision", () => {
    const d = decide([rule({ enabled: false, subjectContains: "invoice" })]);
    expect(d.source).toBe("screener");
  });

  /**
   * A `header` RULE NAMES A HEADER, NOT A PRINCIPAL, so it decides nothing about anybody —
   * `consentIndex` skips it for the same reason.
   *
   * MUTATION: let the `header` kind through {@link namesAuthor} ⇒ RED.
   */
  it("a header rule is not a standing decision about a sender", () => {
    const d = decide([rule({ kind: "header", match: "list-unsubscribe", subjectContains: "x" })]);
    expect(d.source).toBe("screener");
    expect(standingRule([rule({ kind: "header", match: "from" })], NARROW)).toBeNull();
  });

  /**
   * AN AMBIGUOUS `From` INHERITS NOBODY'S DECISION — the fail-closed half of {@link namesAuthor}.
   * Two author mailboxes in the raw header, so `authorAddress` answers `null`.
   *
   * MUTATION: drop `if (author === null) return false;` from {@link namesAuthor} ⇒ GREEN here,
   * and that is the honest reading: both comparisons answer false for `null` anyway, so the
   * guard's consumer is the TYPE — `tsc -b` refuses the mutation at `rules.ts` TS2345, which
   * makes the null case unrepresentable rather than merely handled. The runtime assertion below
   * is `standingRule`'s own answer for a `null` author.
   */
  it("a message claiming two authors inherits no decision", () => {
    const m = msg({ headers: { from: [`${NARROW}, someone@else.example`] } });
    const d = decide([rule({ subjectContains: "invoice" })], new Set(), UNAUTH, "people_and_replied", m);
    expect(d).toMatchObject({ destination: "ohmail/Screener", source: "screener" });
    expect(standingRule([rule()], null)).toBeNull();
  });

  /** CONTROL: an unruled stranger is held at the gate exactly as before. */
  it("an unruled stranger is still held at the gate", () => {
    expect(decide([])).toMatchObject({ destination: "ohmail/Screener", source: "screener" });
  });

  /** CONTROL: a known correspondent with no rule at all takes the path they always took. */
  it("a known correspondent with no rule is unaffected", () => {
    expect(decide([], new Set([NARROW])).source).not.toBe("screener");
  });
});

describe("standingRule resolves by the router's own total order", () => {
  /**
   * DENY OVER ALLOW at equal priority — {@link compareRules}' first clause, and the fail-safe
   * direction for a person who said no to somebody and yes to their domain.
   *
   * MUTATION: return the first hit instead of the `compareRules` minimum ⇒ RED under the
   * ascending-id order this fixture pins.
   */
  it("a denial outranks an admission for the same sender", () => {
    const rules = [
      rule({ id: "a", destination: "INBOX", subjectContains: "invoice" }),
      rule({ id: "b", destination: "ohmail/Quarantine", subjectContains: "invoice" }),
    ];
    expect(standingRule(rules, NARROW)?.id).toBe("b");
    expect(decide(rules).destination).toBe("ohmail/Quarantine");
  });

  /** The address claim outranks the domain claim — `KIND_RANK`, in the same position. */
  it("a sender rule outranks a domain rule for the same message", () => {
    const rules = [
      rule({ id: "d", kind: "domain", match: "bank.example", destination: "ohmail/Receipts", subjectContains: "invoice" }),
      rule({ id: "s", kind: "sender", match: NARROW, destination: "ohmail/News", subjectContains: "invoice" }),
    ];
    expect(standingRule(rules, NARROW)?.id).toBe("s");
  });
});

describe("senderIsDecided is the gate's own reading of a sender", () => {
  const known = (addresses: string[]) => ({ addresses: new Set(addresses), inferred: new Set<string>(), lists: new Map() });
  const own = new Set(["me@home.example"]);
  /** The gate's answer for a letter from `from`, as the undecided-sender walk asks it. */
  const gate = (from: string, rules: Rule[], contacts: string[], over: Partial<NormalizedMessage> = {}) => evaluateRules({
    msg: msg({ from: { name: null, address: from }, headers: { from: [from] }, ...over }), rules, ownAddresses: own,
    knownSenders: known(contacts), auth: "unavailable", ohboxPolicy: "people_and_replied", identity: null,
  }).source;

  it("a decided sender is never the gate's to hold, whatever the letter says", () => {
    const cases: Array<{ from: string; rules: Rule[]; contacts: string[] }> = [
      { from: NARROW, rules: [rule()], contacts: [] },
      { from: NARROW, rules: [rule({ subjectContains: "invoice" })], contacts: [] },
      { from: NARROW, rules: [rule({ destination: "ohmail/Quarantine" })], contacts: [] },
      { from: NARROW, rules: [rule({ kind: "domain", match: "bank.example" })], contacts: [] },
      { from: NARROW, rules: [], contacts: [NARROW] },
      { from: "me@home.example", rules: [], contacts: [] },
    ];
    for (const c of cases) {
      expect(senderIsDecided(c.from, c.rules, known(c.contacts), own)).toBe(true);
      expect(gate(c.from, c.rules, c.contacts)).not.toBe("screener");
    }
  });

  it("nobody decided about a stranger, a paused rule's sender, one a rule keeps at the Screener, or a broken address", () => {
    expect(senderIsDecided(NARROW, [], known([]), own)).toBe(false);
    expect(senderIsDecided(NARROW, [rule({ enabled: false })], known([]), own)).toBe(false);
    expect(senderIsDecided(NARROW, [rule({ destination: "ohmail/Screener" })], known([]), own)).toBe(false);
    expect(senderIsDecided(NARROW, [rule({ kind: "header", match: "list-id" })], known([]), own)).toBe(false);
    // Not one usable mailbox: the gate fails closed on it, so no contact row decides it.
    expect(senderIsDecided("", [], known([""]), own)).toBe(false);
    expect(senderIsDecided("a@x.example, b@y.example", [], known(["a@x.example, b@y.example"]), own)).toBe(false);
    expect(gate(NARROW, [], [])).toBe("screener");
  });
});
