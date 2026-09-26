import { canonicalDestination } from "@trafficflow/core/folder-name";
import { addressPriorityOver } from "@trafficflow/core/rule-order";
import { domainOfAddress } from "./consent-cutline.js";
import type { EngineMutation, RuleDTO } from "./types.js";

/**
 * AN ADDRESS RULE A PERSON WRITES IS NEVER OUTRANKED BY A RULE ON ITS DOMAIN. The router's order
 * (`@trafficflow/core/rule-order`) reads priority before kind, so a domain rule at a higher priority
 * filing elsewhere went on deciding an address that had just been pressed somewhere else. A write of
 * a `sender` rule carries the lowest priority at which no enabled rule for its domain filing
 * elsewhere outranks it; at equal priority the address wins by kind. The value is core's
 * `addressPriorityOver`, which the decide asks too; past the one bound it declines and the domain
 * rule keeps deciding. Anything else is returned as itself, so an ordinary write keeps its wire
 * body and idempotency hash.
 */
export function outrankCoveringDomains(rules: readonly RuleDTO[], m: EngineMutation): EngineMutation {
  if (m.kind !== "rule_create" && m.kind !== "rule_update") return m;
  let match: string;
  let held: number;
  if (m.kind === "rule_create") {
    if (m.ruleKind !== "sender") return m;
    match = m.match;
    held = m.priority ?? 0;
  } else {
    const rule = rules.find((r) => r.id === m.ruleId);
    if (!rule || rule.kind !== "sender") return m;
    match = rule.match;
    held = m.priority ?? finite(rule.priority);
  }
  const domain = domainOfAddress(match.trim().toLowerCase());
  if (domain === null || domain === "") return m;
  const covering = rules
    .filter((r) => r.enabled && r.kind === "domain" && r.match.trim().toLowerCase() === domain)
    .map((r) => ({ priority: r.priority, destination: canonicalDestination(r.destination) }));
  const need = addressPriorityOver(covering, canonicalDestination(m.destination), held);
  return need === null || need === held ? m : { ...m, priority: need };
}

function finite(p: number): number {
  return Number.isFinite(p) ? p : 0;
}
