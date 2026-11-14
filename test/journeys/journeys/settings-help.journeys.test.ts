import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** Where a person writes to support; only a build that names a support address has it. */
const PANE = paneGuards("settings-help");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-help", () => {
  paneJourneys("settings-help", PANE);
});
