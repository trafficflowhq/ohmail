/**
 * THE CALENDAR'S SETTINGS PLACE: the one Settings, reached from the calendar. It draws settings' own place as the
 * host registers it, its list and its section, and writes no menu or column of its own. Where the host mounts no
 * Settings it says so in one line.
 */
import { Empty } from "@ohmail/ui/base";
import { useFrame } from "../frame/commands.js";
import type { PaneProps, PlaceEntry, PlacePanes } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";

type Columns = Extract<PlacePanes, { kind: "columns" }>;

function useSettingsColumns(): Columns | null {
  const settings = useFrame().host.features.places.settings;
  return settings === NONE || settings.panes.kind !== "columns" ? null : settings.panes;
}

function CalSettingsList(props: PaneProps) {
  const t = useText("calsettings");
  const columns = useSettingsColumns();
  if (columns === null) return <Empty label={t("noSettings")} />;
  const List = columns.List;
  return <List {...props} />;
}

function CalSettingsReading(props: PaneProps) {
  const columns = useSettingsColumns();
  if (columns === null || columns.Reading === "reader") return null;
  const Reading = columns.Reading;
  return <Reading {...props} />;
}

export const calsettingsPlace: PlaceEntry = {
  id: "calsettings",
  body: "calsettings",
  rail: null,
  panes: { kind: "columns", List: CalSettingsList, Reading: CalSettingsReading },
};
