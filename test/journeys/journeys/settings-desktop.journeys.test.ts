import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The desktop app's own section; no web setting has it. */
const PANE = paneGuards("settings-desktop");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-desktop", () => {
  paneJourneys("settings-desktop", PANE);
});
