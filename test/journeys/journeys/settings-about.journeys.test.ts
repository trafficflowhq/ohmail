import { openPane, paneGuards, paneJourneys } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-about");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "About says which build this is", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("settings-about", () => {
  paneJourneys("settings-about", PANE);
  journey(GUARDS[PANE.length]!, async (b) => { await openPane(b, "settings-about", "about-build"); });
});
