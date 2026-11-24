import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import type { SettingsPane } from "../settings/contract.js";
import { AccountsPane } from "./accounts/AccountsPane.js";
import { useAccountsSummary } from "./accounts/summary.js";
import { ViewPane, useViewSummary } from "./view/ViewPane.js";
import { MailCalendarPane, useMailCalendarSummary } from "./view/MailCalendarPane.js";

export const calendarAccountsPane = { Body: AccountsPane, useSummary: useAccountsSummary, hasFoot: true };
export const calendarViewPane = { Body: ViewPane, useSummary: useViewSummary };

const common = { group: "calendar", listed: () => true } as const;

const calendarPanes = [
  {
    ...common,
    id: "calaccounts",
    icon: "calendar",
    label: { namespace: "calsettings", key: "accounts.title" },
    ...calendarAccountsPane,
  },
  {
    ...common,
    id: "calview",
    icon: "day",
    label: { namespace: "calsettings", key: "view.title" },
    ...calendarViewPane,
  },
  {
    ...common,
    id: "calmail",
    icon: "frommail",
    label: { namespace: "calsettings", key: "mail.title" },
    Body: MailCalendarPane,
    useSummary: useMailCalendarSummary,
  },
] satisfies readonly SettingsPane[];

/** While the calendar is off, its account switch is still in the shared Settings. */
export function useCalendarPanes(inCalendar: boolean): readonly SettingsPane[] {
  const { host } = useFrame();
  if (inCalendar) return calendarPanes;
  return host.features.calendar !== NONE && host.wires.calendar !== NONE ? [calendarPanes[0]] : [];
}
