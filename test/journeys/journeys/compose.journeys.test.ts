import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, personWith, signedIn, type Guard } from "../bench/web.js";

import { PEOPLE } from "../vocabulary/world.js";

const OFFLINE: Guard[] = ["new letter", "reply"].map<Guard>((surface) => ({
  title: `The first ${surface} accepts text offline after the Ohbox loads`,
  rows: [],
  surfaces: ["W-s"],
  needs: [],
  // The browser deliberately refuses every request after we take it offline.
  tolerates: [/^console: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/],
}));

const WHILE_LOADING: Guard[] = OFFLINE.map((guard) => ({
  ...guard,
  title: guard.title + " with a Settings script response held",
}));

export const GUARDS: Guard[] = [
  { title: "A letter with a recipient, a subject and words can be sent", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo sends a letter and says so", rows: [], surfaces: ["W-d"], needs: [] },
  {
    title: "A letter whose formatting was removed and retyped plain is still sent",
rows: [], surfaces: ["W-d"], needs: [],
  },
  ...OFFLINE,
  ...WHILE_LOADING,
];

journeysOf("compose", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    expect((await person.spoken("compose-send")).disabled).toBe(true);
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.until(async () => !(await person.spoken("compose-send")).disabled, "Send to be offered");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("press", "compose-bold");
    await person.act("write", "compose-body", { value: "Loud words." });
    await person.act("keyIn", "compose-body", { value: "Control+A" });
    await person.act("keyIn", "compose-body", { value: "Delete" });
    await person.act("write", "compose-body", { value: "Plain words." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });

  [...OFFLINE, ...WHILE_LOADING].forEach((guard, index) => journey(guard, async (b) => {
    const reply = index % 2 === 1;
    const whileLoading = index >= OFFLINE.length;
    const { person, named } = await personWith(b, {
      from: PEOPLE.ben, subject: "Kiln schedule", text: "The next firing is on Friday.", pile: "ohbox",
    });
    await person.arrive("ohbox");
    await person.see("conversation", { named });
    if (reply) {
      await person.act("press", "conversation", { named });
      await person.see("reply");
    }
    if (whileLoading) {
      await person.goOfflineWhileOpeningSettings();
      await person.here("ohbox", 5_000);
    } else await person.goOffline();
    if (reply) await person.act("press", "reply");
    else await person.act("keyIn", "conversation", { named, value: "c" });
    const body = reply ? "reply-body" : "compose-body";
    const text = "These words were written offline.";
    await person.see(body, {}, 5_000);
    await person.act("write", body, { value: text });
    expect(await person.text(body)).toBe(text);
  }));
});
