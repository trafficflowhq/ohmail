/**
 * The calendar's settings: two panes in Settings' own shape (Calendar accounts, View) and the calendar's Settings
 * place, which draws the one Settings. The panes register by Settings' registration line once it lists their ids:
 * `paneOf("calaccounts", calendarAccountsPane)`, `paneOf("calview", calendarViewPane)`.
 */
import type { SettingsPane } from "../settings/contract.js";
import { AccountsPane } from "./accounts/AccountsPane.js";
import { useAccountsSummary } from "./accounts/summary.js";
import { ViewPane } from "./view/ViewPane.js";

export const calendarAccountsPane: Pick<SettingsPane, "Body" | "useSummary"> = {
  Body: AccountsPane,
  useSummary: useAccountsSummary,
};
export const calendarViewPane: Pick<SettingsPane, "Body"> = { Body: ViewPane };
export { calsettingsPlace } from "./place.js";
