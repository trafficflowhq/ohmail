import { PLACE_IDS, type FramePlaces } from "@ohmail/app/frame/contract";
import { NONE } from "@ohmail/app/host";
import {
  MailGround,
  mailPlaces,
  mailReader,
  mailSettings,
  mailStages,
  NO_PANE_PARTS,
  NO_STAGE_PARTS,
} from "@ohmail/app/mail";
import { letterBody } from "@ohmail/app/reader/body";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import type { Mounted } from "./frame-supplies";
import { phoneMailboxWires } from "./mailboxes-wire";
import { phoneSettingsParts } from "./remaining-settings";
import { phoneNewMailPane, phoneYourNamePane } from "./settings-panes";

// The phone's page has no framed PDF preview.
const reader = mailReader({ body: letterBody, look: NONE });

export default function mounted(bridge: Bridge, config: Pick<ShellConfig, "scope" | "setting" | "os" | "build">): Mounted {
  const places = {
    ...mailPlaces(),
    settings: mailSettings({
      ...NO_PANE_PARTS,
      ...phoneSettingsParts(bridge, config),
      general: config.setting === "standalone" ? phoneYourNamePane(bridge, config.scope) : NONE,
      notifications: phoneNewMailPane(bridge),
    }),
  };
  return {
    places: Object.fromEntries(PLACE_IDS.map((id) => [id, places[id] ?? NONE])) as FramePlaces,
    stages: mailStages(NO_STAGE_PARTS),
    reader,
    above: MailGround,
    mailboxWires: phoneMailboxWires(bridge, config.scope, config.setting === "standalone"),
  };
}
