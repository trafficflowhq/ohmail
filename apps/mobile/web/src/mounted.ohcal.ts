/** Calendar settings use the same menu and pane layout as the mail app. */
import { NONE } from "@ohmail/app/host";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { hostedSettingsPanes } from "./hosted-settings";
import { accountDataPanes } from "./account-data-panes";
import type { Bridge } from "./bridge";
import { nothingMounted, type Mounted } from "./frame-supplies";
import { PhoneCalendarNotifications, phoneGeneralPane, usePhoneCalendarNotificationsSummary } from "./settings-panes";

export default function mounted(
  bridge: Bridge,
  config: Pick<ShellConfig, "scope" | "setting"> & Pick<ShellConfig, "serverName" | "accountId">,
): Mounted {
  const empty = nothingMounted();
  const { billing, storage } = accountDataPanes(bridge, config);
  return {
    ...empty,
    places: {
      ...empty.places,
      settings: mailSettings({
        ...NO_PANE_PARTS,
        ...hostedSettingsPanes(bridge, config),
        billing, storage,
        general: phoneGeneralPane(bridge, config, true),
        notifications: PhoneCalendarNotifications,
        useNotificationsSummary: usePhoneCalendarNotificationsSummary,
      }),
    },
  };
}
