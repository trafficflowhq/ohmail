import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-away");
export const GUARDS: Guard[] = [
  ...PANE,
  {
    title: "Pressing the away switch says it is not saved yet, never that it is on",
    rows: ["away-switch-says-on-before-a-save"], surfaces: WEB, needs: [],
  },
  {
    title: "A save the server refuses keeps the typed message and says it did not save",
    rows: ["away-refused-save-drops-the-message"], surfaces: WEB, needs: [],
    tolerates: [/status of 503/],
  },
];

journeysOf("settings-away", () => {
  paneJourneys("settings-away", PANE, "away-switch");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-away", "away-switch");
    await person.act("type", "away-message", { value: "Back on Monday." });
    await person.act("press", "away-switch");
    await person.reads("away.unsavedStillOff");
  });
  journey(GUARDS[PANE.length + 1]!, async (b) => {
    const { person } = await openPane(b, "settings-away", "away-switch");
    await person.act("type", "away-message", { value: "Back on Monday." });
    await person.act("press", "away-switch");
    b.faults.push((method, pattern) => (method === "PUT" && pattern === "/away-responder" ? "refuse" : null));
    await person.act("press", "away-save");
    await person.reads("away.failedStillOff");
    await person.until(async () => (await person.holds("away-message")) === "Back on Monday.", "the typed message to still be in its box");
  });
});
