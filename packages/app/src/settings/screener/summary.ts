import { useContext } from "react";
import { NONE } from "../../host/index.js";
import { ScreenerAboveContext } from "../../screener/contract.js";
import { useLocale, useText } from "../../text/index.js";
import type { PaneSummary } from "../contract.js";

/** Use the same readiness rules as the Screener's own section counts. */
export function useScreenerSummary(): PaneSummary | null {
  const above = useContext(ScreenerAboveContext);
  const t = useText("settingsMenu");
  const locale = useLocale();
  if (!above) return null;
  const { model, beside } = above;
  const copied = model.queueSettled && !beside.facts.owed && model.copyBehind !== true;
  const value = model.queueSettled
    ? model.waitingCount === 0 && !beside.facts.owed && !beside.facts.notOrganizingYet
      ? t("screenerDecided")
      : t("screenerWaiting", { count: model.waitingCount })
    : undefined;
  const details = copied
    ? [
        t("screenerScreened", { count: model.screenedOut.length }),
        ...(beside.junk === NONE ? [t("screenerSpam", { count: model.spam.length })] : []),
      ]
    : [];
  return {
    value,
    detail: details.join(" · ") || undefined,
    count:
      model.queueSettled && model.waitingCount
        ? new Intl.NumberFormat(locale).format(model.waitingCount)
        : undefined,
  };
}
