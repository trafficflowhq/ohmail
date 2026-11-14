import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The storage allowance. Listed only where the server's access answer carries one; this bench's carries none. */
const PANE = paneGuards("settings-storage");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-storage", () => {
  paneJourneys("settings-storage", PANE);
});
