import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** Inviting somebody to a self-hosted server. */
const PANE = paneGuards("settings-invites");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-invites", () => {
  paneJourneys("settings-invites", PANE, "invite-make");
});
