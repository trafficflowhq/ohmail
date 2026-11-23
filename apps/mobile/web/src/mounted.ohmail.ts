import { PLACE_IDS, type FramePlaces } from "@ohmail/app/frame/contract";
import { NONE } from "@ohmail/app/host";
import {
  MailGround,
  mailPlaces,
  mailReader,
  mailSettings,
  NO_PANE_PARTS,
} from "@ohmail/app/mail";
import { letterBody } from "@ohmail/app/reader/body";
import {
  BrowserFoldersPane, BrowserRulesPane, BrowserSignaturesPane, BrowserTagsPane,
} from "@ohmail/app/settings/browser";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { hostedSettingsPanes } from "./hosted-settings";
import { accountDataPanes } from "./account-data-panes";
import type { Bridge } from "./bridge";
import type { Mounted } from "./frame-supplies";
import { phoneMailboxWires } from "./mailboxes-wire";
import { phoneSettingsParts } from "./remaining-settings";
import { phoneGeneralPane, phoneHelpPane, phoneNewMailPane, PhoneScreenerPane } from "./settings-panes";

// The phone's page has no framed PDF preview.
const reader = mailReader({ body: letterBody, look: NONE });

export default function mounted(
  bridge: Bridge,
  config: Pick<ShellConfig, "scope" | "setting" | "os" | "build"> & Pick<ShellConfig, "serverName" | "accountId">,
): Mounted {
  const places = {
    ...mailPlaces(),
    settings: mailSettings({
      ...NO_PANE_PARTS,
      ...hostedSettingsPanes(bridge, config),
      ...phoneSettingsParts(bridge, config),
      ...accountDataPanes(bridge, config),
      general: phoneGeneralPane(bridge, config),
      notifications: phoneNewMailPane(bridge, config.scope, config.os === "android"),
      screener: PhoneScreenerPane,
      rules: BrowserRulesPane,
      tags: BrowserTagsPane,
      folders: BrowserFoldersPane,
      signatures: BrowserSignaturesPane,
      help: phoneHelpPane(config.os),
    }),
  };
  return {
    places: Object.fromEntries(PLACE_IDS.map((id) => [id, places[id] ?? NONE])) as FramePlaces,
    stages: { firstRun: NONE },
    reader,
    above: MailGround,
    mailboxWires: phoneMailboxWires(bridge, config.scope, config.setting === "standalone"),
  };
}
