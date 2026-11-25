/** Calendar settings use the same menu and pane layout as the mail app. */
import { calendar } from "@ohmail/app/calendar";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { phoneCalendarAbout } from "./remaining-settings";
import { hostedSettingsPanes } from "./hosted-settings";
import { accountDataPanes } from "./account-data-panes";
import type { Bridge } from "./bridge";
import { nothingMounted, type Mounted } from "./frame-supplies";
import { PhoneCalendarNotifications, phoneGeneralPane, usePhoneCalendarNotificationsSummary } from "./settings-panes";

export default function mounted(
  bridge: Bridge,
  config: Pick<ShellConfig, "scope" | "setting" | "serverName" | "accountId" | "os" | "build">,
): Mounted {
  const empty = nothingMounted();
  const { billing, storage } = accountDataPanes(bridge, config);
  return {
    ...empty,
    calendar,
    places: {
      ...empty.places,
      settings: mailSettings({
        ...NO_PANE_PARTS,
        ...hostedSettingsPanes(bridge, config),
        billing, storage,
        about: phoneCalendarAbout(bridge, config),
        general: phoneGeneralPane(bridge, config, true),
        notifications: PhoneCalendarNotifications,
        useNotificationsSummary: usePhoneCalendarNotificationsSummary,
      }),
    },
  };
}
