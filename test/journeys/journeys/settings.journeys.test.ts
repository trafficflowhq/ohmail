import { expect } from "vitest";
import { menuOf, wholeMenu } from "../bench/panes.js";
import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Settings lists this setting's sections, and no other", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo lists the same sections through both of its doors", rows: [], surfaces: ["W-d"], needs: [] },
  { title: "Settings is reached from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo asks no server anything, through either of its doors", rows: [], surfaces: ["W-d"], needs: [] },
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
      expect(person.requests().map((u) => new URL(u).pathname).filter((p) => SERVER_PATH.test(p)), door).toEqual([]);
    }
  });
});
