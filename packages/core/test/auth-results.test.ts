import { describe, it, expect } from "vitest";
import {
  authVerdictFromHeaders, effectForDestination, evaluateRules,
  type AuthVerdict, type Rule,
} from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * THE DEMOTE-ONLY HALF OF THE AUTHENTICATION VERDICT.
 *
 * Three guards here were mutation-watched, and the anti-regression one is the most important
 * thing in the slice:
 *
 *  · GUARD 3 — a trusted `dkim=fail` demotes a message that would otherwise have been allowed.
 *    MUTATION: delete the two `if (auth === "fail") return screened;` lines in `evaluateRules`.
 *  · GUARD 4 — **NO `Authentication-Results` AT ALL routes exactly as before.** This is the
 *    large-backlog case: `kickstart.ts`'s re-route only fires when `evaluateRules`
 *    does NOT answer Screener, so a rule that made a missing verdict fail closed would send the
 *    whole backlog to the Screener and reverse a shipped fix.
 *    MUTATION: `if (auth !== "pass") return screened;`.
 *  · GUARD 5 — an `Authentication-Results` a SENDER inserted is worth exactly as much as none.
 *    MUTATION: take `values[0]` without consulting `trustedAuthservIds`.
 */

/** The account's own provider. Everything else in these fixtures is somebody claiming to be it. */
const PROVIDER = new Set(["mx.provider.example"]);
const NOBODY: ReadonlySet<string> = new Set<string>();

interface MsgOpts {
  headers?: Record<string, string[]>;
  subject?: string;
}

function msg(from: string, o: MsgOpts = {}): NormalizedMessage {
  const headers: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = v;
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: o.subject ?? "s", from: { name: null, address: from }, to: [], cc: [],
    date: null, headers, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

const rule = (over: Partial<Rule>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: "sender", match: "", destination,
    effect: effectForDestination(destination),
    priority: 0, provenance: "manual", enabled: true, ...over,
  };
};

const decide = (
  m: NormalizedMessage, auth: AuthVerdict, rules: Rule[] = [], known: Set<string> = new Set(),
) => evaluateRules({ msg: m, rules, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth, identity: null });

const ar = (...values: string[]): Record<string, string[]> => ({ "authentication-results": values });

describe("authVerdictFromHeaders — GUARD 5: only the trusted position is read", () => {
  it("IGNORES an Authentication-Results a sender inserted (unlisted authserv-id)", () => {
    const h = ar("evil.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example");
    expect(authVerdictFromHeaders(h, "ceo@bank.example", PROVIDER)).toBe("unavailable");
  });

  it("reads only the topmost field: an untrusted one on top hides a provider-id field below it", () => {
    // Nothing outside the provider can write above its stamp at SMTP, so a provider-id field below
    // an untrusted top was written by the sender, in either direction.
    const h = ar(
      "evil.example; dkim=pass header.d=bank.example",
      "mx.provider.example; dkim=fail header.d=bank.example",
    );
    expect(authVerdictFromHeaders(h, "ceo@bank.example", PROVIDER)).toBe("unavailable");
  });

  // Microsoft stamps its own field with no authserv-id; a sender can write one naming it below.
  const NO_ID_STAMP = "spf=fail (sender IP is 192.0.2.1) smtp.mailfrom=bank.example; dkim=none (message not signed) "
    + "header.d=none;dmarc=fail action=none header.from=bank.example;compauth=fail reason=001";
  const MS = new Set(["mx.microsoft.com"]);

  it("a no-id stamp on top: a sender-written provider-id `pass` below is never read", () => {
    const h = ar(NO_ID_STAMP, "mx.microsoft.com; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example");
    expect(authVerdictFromHeaders(h, "alerts@bank.example", MS)).toBe("unavailable");
  });

  it("a no-id stamp on top: a provider-id `fail` below is not read either", () => {
    const h = ar(NO_ID_STAMP, "mx.microsoft.com; dmarc=fail header.from=bank.example");
    expect(authVerdictFromHeaders(h, "alerts@bank.example", MS)).toBe("unavailable");
  });

  it("reads the TOPMOST trusted header when two claim the provider's id — the last hop prepends", () => {
    const h = ar(
      "mx.provider.example; dkim=fail header.d=bank.example",
      "mx.provider.example; dkim=pass header.d=bank.example",
    );
    expect(authVerdictFromHeaders(h, "ceo@bank.example", PROVIDER)).toBe("fail");
  });

  it("an EMPTY allowlist believes nobody — the default a deployment starts on", () => {
    const h = ar("mx.provider.example; dmarc=fail header.from=bank.example");
    expect(authVerdictFromHeaders(h, "ceo@bank.example", NOBODY)).toBe("unavailable");
  });

  it("matches an authserv-id written as an absolute FQDN, and ignores the optional version", () => {
    const h = ar("mx.provider.example. 1; dmarc=fail header.from=bank.example");
    expect(authVerdictFromHeaders(h, "ceo@bank.example", PROVIDER)).toBe("fail");
  });
});

describe("authVerdictFromHeaders — what counts as a failure, and what deliberately does not", () => {
  it("dkim=fail is a failure", () => {
    expect(authVerdictFromHeaders(
      ar("mx.provider.example; dkim=fail header.d=bank.example"), "ceo@bank.example", PROVIDER,
    )).toBe("fail");
  });

  it("dmarc=fail is a failure", () => {
    expect(authVerdictFromHeaders(
      ar("mx.provider.example; spf=pass smtp.mailfrom=relay.example; dmarc=fail header.from=bank.example"),
      "ceo@bank.example", PROVIDER,
    )).toBe("fail");
  });

  it("spf=fail ALONE is NOT a failure — every ordinary forward fails SPF", () => {
    expect(authVerdictFromHeaders(
      ar("mx.provider.example; spf=fail smtp.mailfrom=relay.example"), "anna@bank.example", PROVIDER,
    )).toBe("unavailable");
  });

  it("temperror and permerror are absence of evidence, not evidence of failure", () => {
    expect(authVerdictFromHeaders(
      ar("mx.provider.example; dkim=temperror; dmarc=permerror"), "anna@bank.example", PROVIDER,
    )).toBe("unavailable");
  });

  it("`none` is absence of evidence", () => {
    expect(authVerdictFromHeaders(
      ar("mx.provider.example; dkim=none; spf=none; dmarc=none"), "anna@bank.example", PROVIDER,
    )).toBe("unavailable");
  });

  it("an ALIGNED dkim=pass outranks a broken third-party signature on the same message", () => {
    // The mailing-list shape: the list re-signs, the original signature breaks, the author's own
    // domain still verifies. Treating this as a failure would screen mail the user asked for.
    const h = ar("mx.provider.example; dkim=pass header.d=bank.example; dkim=fail header.d=list.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("pass");
  });

  it("dmarc=pass outranks a dkim=fail — DMARC is aligned by definition", () => {
    const h = ar("mx.provider.example; dkim=fail header.d=esp.example; dmarc=pass header.from=bank.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("pass");
  });

  it("an UNALIGNED dkim=pass is not a pass for the claimed author", () => {
    const h = ar("mx.provider.example; dkim=pass header.d=someone-else.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("unavailable");
  });

  it("a subdomain signature is aligned", () => {
    const h = ar("mx.provider.example; dkim=pass header.i=@mail.bank.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("pass");
  });

  it("does not lose a clause to a semicolon inside a quoted reason", () => {
    // `value.split(";")` truncates here and the dmarc=fail is never seen — a parse failure that
    // reads as "no evidence" and therefore fails OPEN.
    const h = ar('mx.provider.example; dkim=fail reason="bad sig; resigned"; dmarc=fail header.from=bank.example');
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("fail");
  });

  it("an absent header is `unavailable`, and so is a map that inherits one", () => {
    expect(authVerdictFromHeaders(Object.create(null) as Record<string, unknown>, "a@b.example", PROVIDER))
      .toBe("unavailable");
    const inherited = Object.create(ar("mx.provider.example; dkim=fail")) as Record<string, unknown>;
    expect(authVerdictFromHeaders(inherited, "a@b.example", PROVIDER)).toBe("unavailable");
  });
});

describe("authVerdictFromHeaders — a dkim=fail only demotes when it is ALIGNED", () => {
  it("an UNALIGNED third-party dkim=fail is NOT a failure — it is not evidence about this author", () => {
    // `header.d=esp.example` is an ESP/list signer, not the author's domain. Its failure says
    // nothing about anna@bank.example, so it must read as "no evidence", never as her failure.
    // MUTATION: gate the fail on `r.result === "fail"` alone (drop the `dkimAligned` check) and
    // this returns "fail".
    const h = ar("mx.provider.example; dkim=fail header.d=esp.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("unavailable");
  });

  it("an ALIGNED dkim=fail is still a failure — the fix narrows, it does not disable", () => {
    const h = ar("mx.provider.example; dkim=fail header.d=bank.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("fail");
  });

  it("an unaligned third-party dkim=fail does NOT override an allow rule — end to end", () => {
    // The verdict is not evidence, so the user's own allow still wins: INBOX, credited to the rule.
    // Same MUTATION as above turns this into an `ohmail/Screener` demotion that beats the allow.
    const m = msg("anna@bank.example", {
      headers: ar("mx.provider.example; dkim=fail header.d=esp.example"),
    });
    const verdict = authVerdictFromHeaders(m.headers, m.from.address, PROVIDER);
    expect(verdict).toBe("unavailable");

    const rules = [rule({ id: "r1", kind: "sender", match: "anna@bank.example", destination: "INBOX" })];
    const d = decide(m, verdict, rules, new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "r1", source: "rule" });
  });
});

describe("authVerdictFromHeaders — RFC 8601 CFWS around `=` does not drop a valid result", () => {
  it("tolerates folding whitespace around `=` in both the method and its properties", () => {
    // `dkim = fail` and `header.d = bank.example` fold whitespace around the `=`. Without CFWS
    // tolerance the tokeniser splits each into three tokens, the clause is dropped, and the failure
    // reads as "no evidence" — failing OPEN. The prop must parse too, or the aligned fail is not
    // seen as aligned. MUTATION: drop the `collapseWsAroundEq` call in `parseAuthMethodResult`.
    const h = ar("mx.provider.example; dkim = fail header.d = bank.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("fail");
  });

  it("tolerates a CFWS comment sitting around the `=` as well", () => {
    // RFC 8601 CFWS is comment OR folding whitespace. MUTATION: drop the `stripAuthComments` call.
    const h = ar("mx.provider.example; dkim (checked)=(ok) fail header.d=bank.example");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("fail");
  });

  it("still returns unavailable when whitespace around `=` yields no real result", () => {
    // Tolerating CFWS must not manufacture a verdict out of a `none`/absent line.
    const h = ar("mx.provider.example; dkim = none ; spf = none");
    expect(authVerdictFromHeaders(h, "anna@bank.example", PROVIDER)).toBe("unavailable");
  });
});

describe("evaluateRules — GUARD 3: a failing verdict DEMOTES, in one direction only", () => {
  it("demotes a KNOWN sender to the Screener", () => {
    const d = decide(msg("anna@bank.example"), "fail", [], new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
  });

  it("demotes a message an ALLOW RULE would have let through, and does not credit the rule", () => {
    const rules = [rule({ id: "r1", kind: "sender", match: "anna@bank.example", destination: "INBOX" })];
    const d = decide(msg("anna@bank.example"), "fail", rules, new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
  });

  it("demotes instead of applying the Reads heuristic", () => {
    const m = msg("news@bank.example", { headers: { "list-unsubscribe": ["<https://x.example/u>"] } });
    expect(decide(m, "fail", [], new Set(["news@bank.example"])).destination).toBe("ohmail/Screener");
  });

  it("NEVER WEAKENS A DENY RULE — Quarantine is stricter than the Screener", () => {
    const rules = [rule({
      id: "q", kind: "sender", match: "anna@bank.example", destination: "ohmail/Quarantine",
    })];
    const d = decide(msg("anna@bank.example"), "fail", rules, new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "ohmail/Quarantine", matchedRuleId: "q", source: "rule" });
  });

  it("never weakens a Screened rule either", () => {
    const rules = [rule({
      id: "s", kind: "domain", match: "bank.example", destination: "ohmail/Screened",
    })];
    const d = decide(msg("anna@bank.example"), "fail", rules, new Set(["anna@bank.example"]));
    expect(d.destination).toBe("ohmail/Screened");
  });

  it("a rule whose `effect` survived an unvalidated cast as garbage is still not weakened", () => {
    // `rules.effect` is a bare `text` column that `drizzle-repo.ts#listRules` casts. A value
    // outside the union must not turn a Quarantine into a Screener demotion.
    const rules = [{
      ...rule({ id: "q", kind: "sender", match: "anna@bank.example", destination: "ohmail/Quarantine" }),
      effect: "sideways" as Rule["effect"],
    }];
    const d = decide(msg("anna@bank.example"), "fail", rules, new Set(["anna@bank.example"]));
    expect(d.destination).toBe("ohmail/Quarantine");
  });
});

describe("evaluateRules — GUARD 4: ABSENT EVIDENCE ROUTES EXACTLY AS BEFORE", () => {
  /**
   * The anti-regression guard. `"unauthenticated"` is what every pre-W7 call site states and
   * what a NULL `messages.auth_verdict` resolves to; `"unavailable"` is what a real parse of a
   * message with no trusted header returns. Both must be indistinguishable from the pre-slice
   * evaluator, and `"pass"` must not be needed to reach any of these answers.
   */
  const NO_EVIDENCE: AuthVerdict[] = ["unauthenticated", "unavailable", "pass"];

  it.each(NO_EVIDENCE)("a known sender still reaches INBOX-level handling with auth=%s", (auth) => {
    const d = decide(msg("anna@bank.example"), auth, [], new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: null, matchedRuleId: null, source: "unclear" });
  });

  it.each(NO_EVIDENCE)("an allow rule still wins with auth=%s", (auth) => {
    const rules = [rule({ id: "r1", kind: "sender", match: "anna@bank.example", destination: "INBOX" })];
    const d = decide(msg("anna@bank.example"), auth, rules, new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "r1", source: "rule" });
  });

  it.each(NO_EVIDENCE)("the Reads heuristic still fires for a known sender with auth=%s", (auth) => {
    const m = msg("news@bank.example", { headers: { "precedence": ["bulk"] } });
    expect(decide(m, auth, [], new Set(["news@bank.example"])).destination).toBe("ohmail/News");
  });

  it("THE BACKLOG CASE: a message with NO Authentication-Results is not demoted", () => {
    // End to end through the real parser: no header → `unavailable` → routed as before. This is
    // the shape of ~every row in a large live backlog.
    const m = msg("anna@bank.example");
    const verdict = authVerdictFromHeaders(m.headers, m.from.address, PROVIDER);
    expect(verdict).toBe("unavailable");

    const rules = [rule({ id: "r1", kind: "domain", match: "bank.example", destination: "ohmail/News" })];
    const d = decide(m, verdict, rules, new Set(["anna@bank.example"]));
    expect(d).toEqual({ destination: "ohmail/News", matchedRuleId: "r1", source: "rule" });
  });

  it("A SENDER-FORGED VERDICT CANNOT DEMOTE EITHER — guards 4 and 5 in one message", () => {
    const m = msg("anna@bank.example", {
      headers: ar("evil.example; dkim=fail header.d=bank.example"),
    });
    const verdict = authVerdictFromHeaders(m.headers, m.from.address, PROVIDER);
    expect(verdict).toBe("unavailable");
    expect(decide(m, verdict, [], new Set(["anna@bank.example"])).source).toBe("unclear");
  });

  it("an unknown sender is screened whatever the verdict says — the gate is unchanged", () => {
    for (const auth of ["unauthenticated", "unavailable", "pass", "fail"] as AuthVerdict[]) {
      expect(decide(msg("stranger@x.example"), auth).destination).toBe("ohmail/Screener");
    }
  });
});
