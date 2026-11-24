import { expect } from "vitest";
import { menuOf, wholeMenu } from "../bench/panes.js";
import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Settings lists this setting's sections, and no other", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo lists the same sections through both of its doors", rows: [], surfaces: ["W-d"], needs: [] },
  { title: "Settings is reached from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo asks no server anything, through either of its doors", rows: [], surfaces: ["W-d"], needs: [] },
  { title: "Demo Settings changes the fixture mail and keeps device choices in this browser", rows: [], surfaces: ["W-d"], needs: [] },
];

/** The paths a browser asks a server on: the API's, the session's, the handshake's. */
const SERVER_PATH = /^\/(?:api|auth|pair|events|hello|health)(?:\/|$)/;

journeysOf("settings", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("settings");
    expect(await wholeMenu(b.setting, person)).toEqual(menuOf(b.setting, person.lang));
  });
  journey(GUARDS[1]!, async (b) => {
    const person = await b.person({ door: "/?demo=1" });
    await person.arrive("settings");
    expect(await wholeMenu("W-d", person)).toEqual(menuOf("W-d", person.lang));
  });
  journey(GUARDS[2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    await person.act("press", "rail-settings");
    await person.here("settings");
  });
  journey(GUARDS[3]!, async (b) => {
    for (const door of ["/demo", "/?demo=1"] as const) {
      const person = await b.person({ door });
      await person.arrive("ohbox");
      await person.see("list-new");
      await person.arrive("settings");
      await wholeMenu("W-d", person);
      await person.act("press", "menu-settings-general");
      await person.act("press", "language-de");
      await person.hearsLanguage("de");
      await person.until(async () => (await person.spoken("language-de")).pressed === "true", "German to be selected");
      await person.reload();
      await person.hearsLanguage("de");
      await person.until(async () => (await person.spoken("language-de")).pressed === "true", "German to remain selected");
      expect(person.requests().map((u) => new URL(u).pathname).filter((p) => SERVER_PATH.test(p)), door).toEqual([]);
    }
  });
  journey(GUARDS[4]!, async (b) => {
    const person = await b.person({ lang: "en" });
    await person.refuseNotificationPrompt();
    await person.arrive("ohbox");
    await person.act("press", "rail-settings");
    expect(await wholeMenu("W-d", person)).toEqual(menuOf("W-d", person.lang));

    await person.act("press", "menu-settings-general");
    await person.act("press", "theme-dark");
    await person.reload();
    await person.see("theme-dark");
    expect((await person.spoken("theme-dark")).pressed).toBe("true");

    await person.act("press", "menu-settings-notifications");
    await person.until(async () => (await person.spoken("notify-news")).checked === "false", "News notifications to be off");
    await person.act("press", "notify-news");
    await person.until(async () => (await person.spoken("notify-news")).checked === "true", "News notifications to be on");

    await person.act("press", "menu-settings-rules");
    await person.here("settings-rules");
    await person.readsWithDot("rules.empty");

    await person.act("press", "menu-settings-tags");
    await person.act("type", "tag-new", { value: "Demo pottery" });
    await person.act("press", "tag-add");
    await person.act("press", "rail-tags");
    await person.see("rail-tag", { named: "Demo pottery" });
    await person.act("press", "rail-tag", { named: "Demo pottery" });
    await person.inTag();

    await person.act("press", "rail-settings");
    await person.act("press", "menu-settings-about");
    await person.reads("about.p1");
    expect(person.requests().map((u) => new URL(u).pathname).filter((path) => SERVER_PATH.test(path))).toEqual([]);
  });
});
