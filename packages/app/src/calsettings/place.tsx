/**
 * THE CALENDAR'S SETTINGS PLACE: the one Settings, reached from the calendar. It draws settings' own place as the
 * host registers it, its list and its section, and writes no menu or column of its own. Where the host mounts no
 * Settings it says so in one line.
 */
import { Empty } from "@ohmail/ui/base";
import { useSetupPort } from "../calsetup/index.js";
import { useFrame } from "../frame/commands.js";
import type { PaneProps, PlaceEntry, PlacePanes } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { useText } from "../text/index.js";
import { SettingsList } from "../settings/SettingsList.js";
import { SettingsReading } from "../settings/SettingsReading.js";
import type { SettingsPaneId } from "../settings/contract.js";

type Columns = Extract<PlacePanes, { kind: "columns" }>;

function useSettingsColumns(): Columns | null {
  const settings = useFrame().host.features.places.settings;
  return settings === NONE || settings.panes.kind !== "columns" ? null : settings.panes;
}

function useCalendarBeside() {
  const { commands } = useFrame();
  return {
    startAt: "calaccounts" as const,
    go: (sub: SettingsPaneId | null) => commands.go({ place: "calsettings", sub }),
  };
}

function CalSettingsList(props: PaneProps) {
  const t = useText("calsettings");
  const { commands, plan } = useFrame();
  const columns = useSettingsColumns();
  const beside = useCalendarBeside();
  const setup = useSetupPort();
  useKeyBindings(
    props.keysHere
      ? [
          {
            chord: "Escape",
            group: "navigate",
            label: t("close"),
            run: () =>
              plan.columns === 1 && props.route.sub ? beside.go(null) : commands.closeCalendarSettings(),
          },
        ]
      : [],
    "view",
  );
  if (columns === null && setup === NONE) return <Empty label={t("noSettings")} />;
  if (columns === null) return <SettingsList {...props} panes={null} beside={beside} />;
  const List = columns.List;
  return <List {...props} />;
}

function CalSettingsReading(props: PaneProps) {
  const columns = useSettingsColumns();
  const beside = useCalendarBeside();
  const setup = useSetupPort();
  if (columns === null && setup === NONE) return null;
  if (columns === null || columns.Reading === "reader")
    return <SettingsReading {...props} panes={null} beside={beside} />;
  const Reading = columns.Reading;
  return <Reading {...props} />;
}

export const calsettingsPlace: PlaceEntry = {
  id: "calsettings",
  body: "calsettings",
  rail: null,
  panes: { kind: "columns", List: CalSettingsList, Reading: CalSettingsReading },
};
