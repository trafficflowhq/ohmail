import { expect } from "vitest";
import { EVERY_WEB, WEB, journey, journeysOf, personWith, signedIn, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "The Screener lists a first-time sender who is waiting", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "One Screener section is pressed, and switching sections changes the sender list", rows: [], surfaces: EVERY_WEB, needs: [] },
  {
    title: "The rail's Screener entry carries no number when nobody is waiting",
    rows: [], surfaces: WEB, needs: [],
  },
];

const WAITING = { from: PEOPLE.stranger, subject: "Kleine Ergänzung", pile: "screener", unread: true } as const;

journeysOf("screener", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, WAITING);
    await person.arrive("screener");
    await person.see("list-screener");
    await person.see("conversation", { named });
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, WAITING);
    await person.arrive("screener");
    await person.see("conversation", { named });
    const spam = await person.offered("screener-junk") ? "screener-junk" : "screener-spam";
    const sections = ["screener-waiting", "screener-screened", spam];
    const pressed = () => Promise.all(sections.map(async (section) => (await person.spoken(section)).pressed));
    expect(await pressed()).toEqual(["true", "false", "false"]);
    await person.act("press", "screener-screened");
    await person.until(async () => (await person.spoken("screener-screened")).pressed === "true", "Screened out to be the pressed section");
    expect(await pressed()).toEqual(["false", "true", "false"]);
    await person.gone("conversation", { named });
  });
  journey(GUARDS[2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    // The Ohbox has drawn its mail, so the counts have arrived.
    await person.see("list-earlier");
    expect(await person.listed("rail", "button")).toContain(say("screener.title", {}, person.lang));
  });
});
