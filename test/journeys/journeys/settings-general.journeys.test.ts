import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { EVERY_WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-general");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Choosing the dark theme leaves Dark as the pressed choice", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The language row offers both languages, and one is the pressed one", rows: [], surfaces: EVERY_WEB, needs: [] },
];

journeysOf("settings-general", () => {
  paneJourneys("settings-general", PANE, "theme");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-general", "theme");
    await person.act("press", "theme-dark");
    await person.until(async () => (await person.spoken("theme-dark")).pressed === "true", "Dark to be the pressed theme");
    expect((await person.spoken("theme-light")).pressed).toBe("false");
  });
  journey(GUARDS[PANE.length + 1]!, async (b) => {
    const { person } = await openPane(b, "settings-general", "language");
    const pressed = [(await person.spoken("language-en")).pressed, (await person.spoken("language-de")).pressed];
    expect(pressed.sort()).toEqual(["false", "true"]);
    expect(pressed[person.lang === "en" ? 0 : 1]).toBeDefined();
  });
});
