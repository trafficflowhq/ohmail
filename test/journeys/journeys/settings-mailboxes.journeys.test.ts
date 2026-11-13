import { paneGuards, paneJourneys } from "../bench/panes.js";
import { journeysOf, type Guard } from "../bench/web.js";

/** The connected mailboxes and the way to connect another. */
const PANE = paneGuards("settings-mailboxes");
export const GUARDS: Guard[] = [...PANE];

journeysOf("settings-mailboxes", () => {
  paneJourneys("settings-mailboxes", PANE, "mailbox-connect");
});
