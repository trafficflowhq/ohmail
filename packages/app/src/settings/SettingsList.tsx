import { useFrame, useSelectionBar } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import type { SettingsBeside, SettingsPanes } from "./contract.js";
import { menuOf, shownOf } from "./menu.js";
import { PaneColumn } from "./PaneColumn.js";
import { SettingsMenu } from "./SettingsMenu.js";

export interface SettingsPartProps extends PaneProps {
  readonly panes: SettingsPanes;
  readonly beside: SettingsBeside;
}

/**
 * The list's column. Beside a reading column it is the menu. On one column it is the menu at rest, or the section
 * the route names standing over it, with the way back; the dock gives way while a section stands.
 */
export function SettingsList({ route, plan, keysHere, panes, beside }: SettingsPartProps) {
  const { host } = useFrame();
  const menu = menuOf(host, panes);
  const shown = shownOf(route.sub, menu, plan.columns, beside.startAt);
  const over = plan.columns === 1 && shown !== null;
  useSelectionBar(over);
  if (over) return <PaneColumn pane={shown} plan={plan} keysHere={keysHere} back={() => beside.go(null)} />;
  return (
    <SettingsMenu menu={menu} current={plan.columns === 2 ? (shown?.id ?? null) : null} go={beside.go} />
  );
}
