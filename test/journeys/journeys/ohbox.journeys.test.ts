import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "The Ohbox lists a new conversation by sender and subject, and says it is unread", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "Mark all read leaves no conversation in the Ohbox saying unread", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The Ohbox is reached from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
];

const NEW = { from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: true, text: "Good news twice." } as const;

journeysOf("ohbox", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("ohbox");
    expect((await person.spoken("conversation", { named })).description).toContain(say("message.rowUnread", {}, person.lang));
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("ohbox");
    const count = b.fixtures ? b.fixtures.count({ pile: "ohbox", unread: true }) : 1;
    await person.act("press", "mark-all-read", { args: { count } });
    const unread = say("message.rowUnread", {}, person.lang);
    await person.until(async () => !(await person.spoken("conversation", { named })).description.includes(unread), "the conversation to stop saying it is unread");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("settings");
    await person.act("press", "rail-ohbox");
    await person.here("ohbox");
    await person.see("conversation", { named });
  });
});
