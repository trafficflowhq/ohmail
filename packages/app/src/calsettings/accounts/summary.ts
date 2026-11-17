/** What Calendar accounts says in the menu, from the mirror alone: how many, and whether one wants a new sign-in. */
import { accountsOf } from "@ohmail/app-logic/calendar/setup";
import type { PaneSummary } from "../../settings/contract.js";
import { useText } from "../../text/index.js";
import { useCalendarMirror } from "../../calsetup/index.js";

export function useAccountsSummary(): PaneSummary | null {
  const t = useText("calsettings");
  const mirror = useCalendarMirror();
  if (mirror === null) return null;
  const accounts = accountsOf(mirror.connections, mirror.calendars);
  const out = accounts.some((a) => a.state === "signedOut");
  return {
    count: String(accounts.length),
    value: t(
      out ? "accounts.state.signedOut" : accounts.length ? "accounts.state.inStep" : "accounts.noneShort",
    ),
    hot: out,
  };
}
