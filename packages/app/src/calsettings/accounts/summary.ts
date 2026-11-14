/** What Calendar accounts says in the menu, from the mirror alone: how many, and whether one wants a new sign-in. */
import { accountsOf } from "@ohmail/app-logic/calendar/setup";
import type { PaneSummary } from "../../settings/contract.js";
import { useLocale, useText } from "../../text/index.js";
import { useCalendarMirror } from "../../calsetup/index.js";

export function useAccountsSummary(): PaneSummary | null {
  const t = useText("calsettings");
  const locale = useLocale();
  const mirror = useCalendarMirror();
  if (mirror === null) return null;
  const accounts = accountsOf(mirror.connections, mirror.calendars);
  const out = accounts.some((a) => a.state === "signedOut");
  const ways = [...new Set(accounts.map(({ way }) => t(`way.${way}`)))];
  return {
    count: accounts.length ? new Intl.NumberFormat(locale).format(accounts.length) : undefined,
    detail: ways.length
      ? new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(ways)
      : undefined,
    value: t(
      out ? "accounts.state.signedOut" : accounts.length ? "accounts.state.inStep" : "accounts.noneShort",
    ),
    hot: out,
  };
}
