import { useFrame } from "../frame/commands.js";
import { menuOf, shownOf } from "./menu.js";
import { PaneColumn } from "./PaneColumn.js";
import type { SettingsPartProps } from "./SettingsList.js";

/** The reading column beside the menu: the section the route names, or the one that stands for none. */
export function SettingsReading({ route, plan, keysHere, panes, beside }: SettingsPartProps) {
  const { host } = useFrame();
  const shown = shownOf(route.sub, menuOf(host, panes), plan.columns, beside.startAt);
  return shown === null ? null : <PaneColumn pane={shown} plan={plan} keysHere={keysHere} back={null} />;
}
