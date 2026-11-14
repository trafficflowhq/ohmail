import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The subscription. Listed only where the server meters the account; this bench's server meters nothing. */
const PANE = paneGuards("settings-billing");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-billing", () => {
  paneJourneys("settings-billing", PANE);
});
