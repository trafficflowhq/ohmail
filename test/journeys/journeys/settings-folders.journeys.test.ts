import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The switch that brings the mailbox's own folders into the app. */
const PANE = paneGuards("settings-folders");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-folders", () => {
  paneJourneys("settings-folders", PANE, "folders-switch");
});
