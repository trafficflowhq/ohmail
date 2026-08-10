"use client";

/**
 * WHY YOUR MAIL WENT WHERE IT WENT — the product's first "why" surface.
 *
 * The requirement: click through to a detailed view of every message from one address or
 * domain, and how each was classified. Until this, nothing in ohmail answered that question
 * at all — mail appeared in a pile and the reasoning was invisible.
 *
 * ── THE HARD PART IS REFUSING TO SAY MORE THAN IS KNOWN ─────────────────────────────────
 *
 * This is the first thing a user will trust about the router, and the client mirror can see
 * much less than the router can. Three answers are available and there is deliberately no
 * fourth:
 *
 *  · `gate` — the message is in `ohmail/Screener`. Not an inference: it IS the folder.
 *  · `rule` — an ENABLED rule in the mirror matches this sender **and files into the folder
 *    the message is actually in**. Read the tense: it says *a rule sends mail from here to
 *    this place*, which is true right now and checkable. It does NOT say "this rule filed
 *    this message", which would be false for every message older than its rule — and once
 *    rules become routine, that is most of them.
 *  · `arrival` — everything else, claiming NOTHING. This is the important one. A yes decision
 *    also writes a `contacts` row and the pipeline routes known senders independently of
 *    rules; `contacts` is not in the mirror's entity vocabulary at all
 *    (`client-engine/src/types.ts`), so a rule-less Ohbox message is genuinely explained by
 *    something this module cannot read. Calling it "unexplained" would be an assertion about
 *    the router made by code that cannot see it.
 *
 * A bought AI suggestion rides along with `gate` and is never an attribution of its own:
 * it is advice about a sender still waiting, and nothing has ever routed on one.
 *
 * ── WHAT IS DELIBERATELY NOT ATTEMPTED ──────────────────────────────────────────────────
 *
 * **Rule precedence.** `core/src/rules.ts#compareRules` ranks on priority, then `effect`,
 * then kind, then provenance — and `RuleDTO` carries no `effect` (it is derived at the
 * adapter boundary in `drizzle-repo.ts#listRules`), so the winner cannot be computed here
 * without a second, weaker copy of the consent evaluator that would drift from the real one.
 * It is not needed: a rule is only ever reported when it AGREES with where the message
 * already is, so the claim holds whether or not that rule is the one that wins. A `header`
 * rule can never be reported — the mirror holds no headers — which is the other reason the
 * copy says "a rule" and not "the rule".
 *
 * **Exhaustiveness.** This reads the mirror, so it covers the mail ohmail has synced and no
 * more. The copy says exactly that; see `screening.auditCount` in `messages/en.json`.
 */
import {
  FOLDER_OF_VIEW,
  rulesList,
  senderKey,
  type EngineMessage,
  type EntityReader,
  type RuleDTO,
  type ScreenerSenderDTO,
} from "@ohmail/client-engine";

export type MailAttribution =
  | { kind: "gate"; suggestion: ScreenerSenderDTO["ai"] }
  | { kind: "rule"; rule: RuleDTO }
  | { kind: "arrival" };

export interface AttributedMessage {
  message: EngineMessage;
  attribution: MailAttribution;
}

/** Everything after the first `@`, lower-cased — `core/src/rules.ts#domainOf`, exactly. */
export function auditDomainOf(address: string): string {
  const at = address.indexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/**
 * Does this rule match this sender, by the SAME test `core/src/rules.ts#matches` applies?
 *
 * Exact equality on a lower-cased address, or on everything after the first `@`. Not a suffix
 * test: `corp.com` must not match `mail.corp.com` (the core matcher has no subdomain
 * semantics) nor `evil-corp.com` (a lookalike an attacker chooses). `header` rules answer
 * false — there are no headers in the mirror to test, and guessing is worse than silence.
 */
export function ruleMatchesSender(rule: RuleDTO, address: string): boolean {
  const addr = address.trim().toLowerCase();
  if (rule.kind === "sender") return rule.match.trim().toLowerCase() === addr;
  if (rule.kind === "domain") {
    const d = auditDomainOf(addr);
    return d !== "" && rule.match.trim().toLowerCase() === d;
  }
  return false;
}

/**
 * Attribute a set of messages. The rules are read ONCE for the whole set, not per message.
 *
 * A sender rule is preferred over a domain rule when both agree with the folder, because that
 * is the more specific TRUE statement to show a person — not because it reproduces the
 * router's precedence, which this module explicitly does not attempt.
 */
export function attributeMessages(
  reader: EntityReader, messages: readonly EngineMessage[],
): AttributedMessage[] {
  const rules = rulesList(reader).filter((r) => r.enabled);
  const senders = reader.list<ScreenerSenderDTO>("screener_sender");

  return messages.map((message): AttributedMessage => {
    if (message.folder === FOLDER_OF_VIEW.screener) {
      const key = senderKey(message.from.address);
      const row = senders.find((s) => senderKey(s.from.address) === key);
      return { message, attribution: { kind: "gate", suggestion: row?.ai ?? null } };
    }
    const hits = rules.filter(
      (r) => r.destination === message.folder && ruleMatchesSender(r, message.from.address),
    );
    const rule = hits.find((r) => r.kind === "sender") ?? hits[0];
    return { message, attribution: rule ? { kind: "rule", rule } : { kind: "arrival" } };
  });
}
