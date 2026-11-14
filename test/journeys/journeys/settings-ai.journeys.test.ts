import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The account's one AI switch. */
const PANE = paneGuards("settings-ai");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-ai", () => {
  paneJourneys("settings-ai", PANE, "ai-switch");
});
