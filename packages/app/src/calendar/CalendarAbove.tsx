import { useEffect, type ReactNode } from "react";
import { useSetupPort } from "../calsetup/index.js";
import { CalendarSettingsScope, useCalendarEnabled } from "../calsettings/settings-read.js";
import { useFrame } from "../frame/commands.js";
import { isCalendarPlace } from "../frame/product.js";
import { MonthRunScope } from "../month/MonthRunScope.js";
import { NONE } from "../host/index.js";
import { CalendarCheckScope } from "./check.js";
import { CalendarKeys } from "./CalendarKeys.js";

function CalendarState() {
  const { route, commands, host } = useFrame();
  const enabled = useCalendarEnabled();
  const hasSettings = host.features.places.settings !== NONE;
  useEffect(() => {
    if (!enabled && isCalendarPlace(route.place) && hasSettings) {
      commands.go({ place: "settings", sub: "calaccounts" }, { replace: true });
    }
  }, [enabled, route.place, commands, hasSettings]);
  return enabled ? <CalendarKeys /> : null;
}

export function CalendarAbove({ children }: { children: ReactNode }) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  const setup = useSetupPort();
  if (port === NONE) return children;
  return (
    <CalendarSettingsScope port={port} setup={setup}>
      <CalendarCheckScope>
        <CalendarState />
        <MonthRunScope>{children}</MonthRunScope>
      </CalendarCheckScope>
    </CalendarSettingsScope>
  );
}
