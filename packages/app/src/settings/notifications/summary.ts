import { createContext, useContext } from "react";
import { useText } from "../../text/index.js";
import type { PaneSummary } from "../contract.js";
import type { NotificationsModel } from "./model.js";
import { NOTIFICATIONS_NAMESPACE } from "./namespace.js";

export const NotificationsContext = createContext<NotificationsModel | null>(null);

/** The menu shares the pane's mounted model, including the device's permission. */
export function useNotificationSummary(): PaneSummary | null {
  const model = useContext(NotificationsContext);
  const t = useText(NOTIFICATIONS_NAMESPACE);
  if (!model) return null;
  if (model.permission === "denied") return { value: t("blocked"), hot: true };
  if (!model.live) return { value: t("off") };
  const mail = [
    ["ohbox", "ohbox"],
    ["screener", "screener"],
    ["scheduled", "scheduled"],
    ["pairing", "devices"],
  ] as const;
  const calendar = [
    ["cal_alert", "shortAlerts"],
    ["cal_invitation", "shortInvitations"],
    ["cal_change", "shortChanges"],
    ["cal_answer", "shortAnswers"],
    ["cal_found", "shortFound"],
  ] as const;
  const detail = [
    ...mail.filter(([kind]) => model.carries.includes(kind) && model.channels[kind]).map(([, key]) => t(key)),
    ...calendar
      .filter(([kind]) => model.carries.includes(kind) && model.calendarChoices?.[kind])
      .map(([, key]) => t(key)),
  ];
  return { value: t("on"), detail: detail.length ? detail.join(" · ") : undefined };
}
