import type { UnsubscribeClaim } from "@ohmail/client-engine";
import type { DecisionScope } from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import type { Text } from "../../text/index.js";

export function unsubscribeDisclosure(
  t: Text,
  address: string,
  scope: DecisionScope,
  claim: UnsubscribeClaim,
): string | null {
  if (claim === "none") return null;
  return scope === "domain"
    ? t("barUnsubDomain", { claim, domain: displayDomainLabel(address) })
    : t("barUnsub", { claim, who: displayAddress(address) });
}
