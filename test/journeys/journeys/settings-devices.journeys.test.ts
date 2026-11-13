import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** Pairing another device to this account. */
const PANE = paneGuards("settings-devices");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-devices", () => {
  paneJourneys("settings-devices", PANE, "device-add");
});
