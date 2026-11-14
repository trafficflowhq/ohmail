import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The second factors and the recovery codes. */
const PANE = paneGuards("settings-security");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-security", () => {
  paneJourneys("settings-security", PANE, "recovery-codes");
});
