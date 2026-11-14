import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { EVERY_WEB, WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-general");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Choosing the dark theme leaves Dark as the pressed choice", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The language row offers both languages, and one is the pressed one", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "A reader can change the theme from the rail and return to the saved choice", rows: [], surfaces: WEB, needs: [] },
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
  journey(GUARDS[PANE.length + 2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    const open = async () => {
      await person.act("press", "rail-settings");
      await person.act("press", "menu-settings-general");
      await person.here("settings-general");
    };
    await open();
    await person.act("press", "theme-dark");
    await person.until(async () => (await person.spoken("theme-dark")).pressed === "true", "the dark theme to be selected");
    await person.act("press", "rail-ohbox");
    await person.here("ohbox");
    await open();
    expect((await person.spoken("theme-dark")).pressed).toBe("true");
  });
});
