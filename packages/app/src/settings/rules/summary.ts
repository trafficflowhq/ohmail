import { useMailState } from "@ohmail/app-logic/mail-state";
import { ruleDestinationPile, useRuleSettings } from "@ohmail/app-logic/press/rule-settings";
import { actingRules } from "@ohmail/app-logic/press/rules-standing";
import { rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import { useNowAt } from "@ohmail/app-logic/session/day-clock";
import { placeLabel } from "@ohmail/app-logic/text/format";
import { useLocale, useText } from "../../text/index.js";
import type { PaneSummary } from "../contract.js";

/** The same rules the pane shows, including an organizer's published copy. */
export function useRulesSummary(): PaneSummary | null {
  const { mailboxes, state } = useMailState();
  const { data } = useRuleSettings(rulesPostureOf(mailboxes), useNowAt());
  const locale = useLocale();
  const t = useText("settingsMenu");
  if (!state.settled || state.owed) return null;
  const { shown } = actingRules(data.rules);
  const counts = new Map<string, number>();
  for (const rule of shown) {
    const pile = ruleDestinationPile(rule.destination);
    const place = pile ? t(`rulePlace.${pile}`) : placeLabel(rule.destination);
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  if (shown.length === 0) return { detail: t("none") };
  const order = ["ohbox", "reads", "receipts", "screened", "spam"].map((pile) => t(`rulePlace.${pile}`));
  const rank = (place: string) => {
    const at = order.indexOf(place);
    return at < 0 ? order.length : at;
  };
  return {
    count: new Intl.NumberFormat(locale).format(shown.length),
    detail: [...counts]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([place, count]) => t("ruleCount", { place, count }))
      .join(" · "),
  };
}
