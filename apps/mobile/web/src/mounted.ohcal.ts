/** Calendar settings use the same menu and pane layout as the mail app. */
import { calendar } from "@ohmail/app/calendar";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { phoneCalendarAbout } from "./remaining-settings";
import { hostedSettingsPanes } from "./hosted-settings";
import type { Bridge } from "./bridge";
import { nothingMounted, type Mounted } from "./frame-supplies";
import { PhoneCalendarNotifications, phoneGeneralPane, usePhoneCalendarNotificationsSummary } from "./settings-panes";

export const calendarBuild = true;

export default function mounted(
  bridge: Bridge,
  config: Pick<ShellConfig, "scope" | "setting" | "serverName" | "accountId" | "os" | "build">,
): Mounted {
  const empty = nothingMounted();
  return {
    ...empty,
    calendar,
    places: {
      ...empty.places,
      settings: mailSettings({
        ...NO_PANE_PARTS,
        ...hostedSettingsPanes(bridge, config, "calendar"),
        about: phoneCalendarAbout(bridge, config),
        general: phoneGeneralPane(bridge, config, true),
        notifications: PhoneCalendarNotifications,
        useNotificationsSummary: usePhoneCalendarNotificationsSummary,
      }),
    },
  };
}
