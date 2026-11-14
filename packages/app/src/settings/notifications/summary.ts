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
  return model?.permission === "denied" ? { value: t("blocked"), hot: true } : null;
}
