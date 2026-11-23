import { type ReactNode } from "react";
import { useSetupPort } from "../calsetup/index.js";
import { CalendarSettingsScope, useSharedCalendarSettings } from "../calsettings/settings-read.js";
import { useFrame } from "../frame/commands.js";
import { MonthRunScope } from "../month/MonthRunScope.js";
import { NONE } from "../host/index.js";
import { CalendarCheckScope } from "./check.js";
import { CalendarFirstStepScope } from "./CalendarFirstStep.js";
import { CalendarAddressScope } from "./own-addresses.js";
import { CalendarKeys } from "./CalendarKeys.js";

function CalendarBindings() {
  const enabled = useSharedCalendarSettings()?.said?.enabledAt !== null;
  return enabled ? <CalendarKeys /> : null;
}

export function CalendarAbove({ children }: { children: ReactNode }) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  const setup = useSetupPort();
  if (port === NONE) return children;
  return (
    <CalendarSettingsScope port={port} setup={setup}>
      <CalendarFirstStepScope port={port}>
        <CalendarAddressScope>
          <CalendarCheckScope>
            <CalendarBindings />
            <MonthRunScope>{children}</MonthRunScope>
          </CalendarCheckScope>
        </CalendarAddressScope>
      </CalendarFirstStepScope>
    </CalendarSettingsScope>
  );
}
