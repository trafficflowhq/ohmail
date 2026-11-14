import { useCalendarPanes } from "../calsettings/panes.js";
import { useFrame } from "../frame/commands.js";
import { menuOf, shownOf } from "./menu.js";
import { PaneColumn } from "./PaneColumn.js";
import type { SettingsPartProps } from "./SettingsList.js";

/** The reading column beside the menu: the section the route names, or the one that stands for none. */
export function SettingsReading({ route, plan, keysHere, panes, beside }: SettingsPartProps) {
  const { host } = useFrame();
  const calendar = route.place === "calsettings";
  const menu = [...useCalendarPanes(calendar), ...menuOf(host, panes)];
  const shown = shownOf(route.sub, menu, plan.columns, calendar ? "calaccounts" : beside.startAt);
  return shown === null ? null : <PaneColumn pane={shown} plan={plan} keysHere={keysHere} back={null} />;
}
