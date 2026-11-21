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
  const labels = {
    ohbox: "ohbox",
    screener: "screener",
    scheduled: "scheduled",
    pairing: "devices",
  } as const;
  const detail = (Object.keys(labels) as (keyof typeof labels)[])
    .filter((kind) => model.carries.includes(kind) && model.channels[kind])
    .map((kind) => t(labels[kind]));
  return { value: t("on"), detail: detail.length ? detail.join(" · ") : undefined };
}
