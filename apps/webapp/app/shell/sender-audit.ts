"use client";

/**
 * Why your mail went where it went — the first "why" surface, and the hard part is refusing to say more than is
 * known: the mirror sees much less than the router. Three answers, no fourth: `gate` — the message is in
 * `ohmail/Screener`, not an inference; `rule` — an enabled rule matches this sender AND files into the folder
 * the message is actually in (present tense — never "this rule filed this message", false for every message
 * older than its rule); `arrival` — everything else, claiming nothing: known senders route through `contacts`,
 * absent from the mirror's vocabulary, so a rule-less Ohbox message is explained by something this module
 * cannot read. Precedence is not attempted (`RuleDTO` carries no `effect`; a rule is only reported when it
 * agrees with where the message is). This reads the mirror — `screening.auditCount` says so.
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
import { bodyTextOf } from "./subject-rule";

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
 * Does the rule's second term (mail 0050) also hold for this subject? `true` when it has none. A
 * conjunction, asked in ADDITION to {@link ruleMatchesSender}: the `rule` attribution claims in the
 * present tense that a rule sends mail from here to this place, and for a subject rule that is only
 * true of messages whose subject matches — without this, the detail view for `info@` would label
 * the invoice with the `[NinjaFirewall]` rule, the exact assertion the header forbids. Case-folded
 * substring, matching `core/src/rules.ts#subjectSatisfies`; a blank term reads as no term — the
 * CHECK forbids storing one, and this code is handed values the CHECK never saw.
 */
export function ruleSubjectHolds(rule: RuleDTO, subject: string): boolean {
  const term = (rule.subjectContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (term === "") return true;
  return subject.toLowerCase().includes(term.toLowerCase());
}

/**
 * Does the rule's BODY term (mail 0052) VERIFIABLY hold for this message? `true` when it has none.
 * {@link ruleSubjectHolds}' contract against `text` — what the mirror holds
 * (`subject-rule.ts#bodyTextOf`: full body where hydrated, snippet otherwise), a floor of the
 * server's haystack, so the honest reading of a miss is "cannot verify". A body rule whose term
 * sits deeper than the client's text is NOT named, and the message reads as "arrival" — an
 * attribution this module already prefers over a claim it cannot check.
 */
export function ruleBodyHolds(rule: RuleDTO, text: string): boolean {
  const term = (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (term === "") return true;
  return text.toLowerCase().includes(term.toLowerCase());
}

/**
 * Attribute a set of messages. The rules are read once for the whole set, not per message. A sender
 * rule is preferred over a domain rule when both agree with the folder — the more specific TRUE
 * statement to show a person, not a reproduction of the router's precedence, which this module does
 * not attempt. A rule carrying a subject term is only offered for a message whose subject satisfies
 * it ({@link ruleSubjectHolds}) — the conjunction is checked per message, which is why the rules
 * are filtered here and not once for the whole set.
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
      (r) => r.destination === message.folder
        && ruleMatchesSender(r, message.from.address)
        && ruleSubjectHolds(r, message.subject ?? "")
        && ruleBodyHolds(r, bodyTextOf(message)),
    );
    // Among the rules that hold, the one carrying a term (subject or body, mail 0052) is the more
    // specific TRUE statement — and it is also the one the router would pick (`compareRules`'
    // specificity clauses), so preferring it costs nothing this module refuses to do: it is still
    // only ever reporting a rule that AGREES with where the message already is.
    const rule = hits.find((r) => r.kind === "sender"
        && ((r.subjectContains ?? "").trim() !== "" || (r.bodyContains ?? "").trim() !== ""))
      ?? hits.find((r) => r.kind === "sender")
      ?? hits[0];
    return { message, attribution: rule ? { kind: "rule", rule } : { kind: "arrival" } };
  });
}
