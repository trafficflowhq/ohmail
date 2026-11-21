import { expect } from "vitest";
import { expect as browserExpect } from "@playwright/test";
import type { PlaywrightPerson } from "../bench/dom-playwright.js";
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
      const person = await b.person({ door }) as PlaywrightPerson;
      const { page } = person;
      await person.arrive("ohbox");
      await person.see("list-new");
      await person.arrive("settings");
      await wholeMenu("W-d", person);
      await person.act("press", "menu-settings-general");
      await person.act("press", "language-de");
      const german = page.getByRole("button", { name: "Deutsch", exact: true });
      await browserExpect(page.locator("html")).toHaveAttribute("lang", "de");
      await browserExpect(german).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await browserExpect(page.locator("html")).toHaveAttribute("lang", "de");
      await browserExpect(german).toHaveAttribute("aria-pressed", "true");
      expect(person.requests().map((u) => new URL(u).pathname).filter((p) => SERVER_PATH.test(p)), door).toEqual([]);
    }
  });
  journey(GUARDS[4]!, async (b) => {
    const person = await b.person() as PlaywrightPerson;
    const { page } = person;
    await page.addInitScript(() => {
      if (typeof Notification !== "undefined") {
        Notification.requestPermission = async () => { throw new Error("Demo Settings asked for notification permission"); };
      }
    });
    await person.arrive("ohbox");
    await person.act("press", "rail-settings");
    expect(await wholeMenu("W-d", person)).toEqual(menuOf("W-d", person.lang));

    await person.act("press", "menu-settings-general");
    await person.act("press", "theme-dark");
    await page.reload();
    await person.see("theme-dark");
    expect((await person.spoken("theme-dark")).pressed).toBe("true");

    await person.act("press", "menu-settings-notifications");
    const news = page.getByRole("switch", { name: "News", exact: true });
    await browserExpect(news).toHaveAttribute("aria-checked", "false");
    await news.click();
    await browserExpect(news).toHaveAttribute("aria-checked", "true");

    await person.act("press", "menu-settings-rules");
    await person.here("settings-rules");
    await person.reads("rules.empty");

    await person.act("press", "menu-settings-tags");
    await person.act("type", "tag-new", { value: "Demo pottery" });
    await person.act("press", "tag-add");
    await person.see("rail-tag", { named: "Demo pottery" });
    await person.act("press", "rail-tag", { named: "Demo pottery" });
    await browserExpect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/tag\/[^/]+$/);

    await person.act("press", "rail-settings");
    await person.act("press", "menu-settings-about");
    await browserExpect(page.getByText(/A demo mailbox, invented for it/)).toBeVisible();
    expect(person.requests().map((u) => new URL(u).pathname).filter((path) => SERVER_PATH.test(path))).toEqual([]);
  });
});
