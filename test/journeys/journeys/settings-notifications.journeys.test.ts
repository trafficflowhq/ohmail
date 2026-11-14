import { openPane, paneGuards, paneJourneys } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-notifications");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Notifications has the one switch for this device's notices", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("settings-notifications", () => {
  paneJourneys("settings-notifications", PANE);
  journey(GUARDS[PANE.length]!, async (b) => { await openPane(b, "settings-notifications", "notify-master"); });
});
