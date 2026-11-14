import { Button } from "@ohmail/ui/base";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { useText } from "../text/index.js";
import { useCalendarPanes } from "../calsettings/panes.js";
import { useFrame, useSelectionBar } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import type { SettingsBeside, SettingsPanes } from "./contract.js";
import { useSettingsZone } from "./keyboard.js";
import { menuOf, shownOf } from "./menu.js";
import { PaneColumn } from "./PaneColumn.js";
import { SettingsMenu } from "./SettingsMenu.js";

export interface SettingsPartProps extends PaneProps {
  readonly panes: SettingsPanes | null;
  readonly beside: SettingsBeside;
}

/**
 * The list's column. Beside a reading column it is the menu. On one column it is the menu at rest, or the section
 * the route names standing over it, with the way back; the dock gives way while a section stands.
 */
export function SettingsList({ route, plan, keysHere, panes, beside }: SettingsPartProps) {
  const { host, commands } = useFrame();
  const t = useText("calsettings");
  const calendar = route.place === "calsettings";
  const menu = [...useCalendarPanes(calendar), ...menuOf(host, panes)];
  const shown = shownOf(route.sub, menu, plan.columns, calendar ? "calaccounts" : beside.startAt);
  const oneColumn = plan.columns === 1;
  const over = oneColumn && shown !== null;
  useSelectionBar(over);
  useSettingsZone(menu, shown?.id ?? null, oneColumn, beside.go);
  if (over) return <PaneColumn pane={shown} plan={plan} keysHere={keysHere} back={() => beside.go(null)} />;
  return (
    <SettingsMenu
      menu={menu}
      current={oneColumn ? null : (shown?.id ?? null)}
      phone={plan.device === "phone"}
      calendarFirst={calendar}
      leading={
        plan.rail === "dock" && (calendar || plan.device === "phone") ? (
          <ProductSwitch kind="round" />
        ) : undefined
      }
      tools={
        calendar ? (
          <Button
            kind="quiet"
            size="s"
            icon="x"
            label={t("close")}
            onPress={commands.closeCalendarSettings}
          />
        ) : undefined
      }
      go={beside.go}
    />
  );
}
