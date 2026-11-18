/**
 * HOW WIDE A DECISION REACHES before the person chooses: the row's own scope, as the store answered it, else the
 * sender alone.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { isSharedProviderDomain } from "@trafficflow/core/rule-order";
import type { DecisionScope } from "./decision.js";

export function defaultScopeOf(sender: ScreenerSenderDTO): DecisionScope {
  return sender.scope ?? "sender";
}

/** Is the address at a domain where anyone can register one? Such a domain is never offered as a scope. */
export function isSharedDomain(address: string): boolean {
  return isSharedProviderDomain(address.slice(address.lastIndexOf("@") + 1));
}
