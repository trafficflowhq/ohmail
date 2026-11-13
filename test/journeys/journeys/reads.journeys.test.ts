import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "News draws in the built app, with its letters", rows: ["stream-view-does-not-draw"], surfaces: EVERY_WEB, needs: [] },
  {
    title: "A News letter that is pressed and stays on screen turns read",
    rows: ["pressed-stream-letter-never-reads"], surfaces: EVERY_WEB, needs: [],
  },
  {
    title: "Wheeling the News list reads nothing that only passed by",
    rows: [], surfaces: ["W-d"], needs: [],
  },
];

const LETTER = { from: PEOPLE.skylark, subject: "The joy of small tools", pile: "reads", unread: true, text: "A love letter to tools that do one thing." } as const;

journeysOf("reads", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("reads");
    await person.see("list-reads");
    expect((await person.spoken("conversation", { named })).description).toContain(say("message.rowUnread", {}, person.lang));
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("reads");
    await person.act("press", "conversation", { named });
    const unread = say("message.rowUnread", {}, person.lang);
    await person.until(async () => !(await person.spoken("conversation", { named })).description.includes(unread), "the pressed letter to stop saying it is unread");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("reads");
    const unread = say("message.rowUnread", {}, person.lang);
    const rows = (await person.see("list-reads")).getByRole("option");
    const before: string[] = [];
    for (const row of await rows.all()) if ((await row.getAttribute("aria-description"))?.endsWith(unread)) before.push((await row.getAttribute("aria-label"))!);
    expect(before.length).toBeGreaterThan(3);
    const last = before[before.length - 1]!;
    await person.act("wheel", "list-reads", { value: "4000" });
    await person.act("wheel", "list-reads", { value: "-4000" });
    // The hold has passed once a letter that WAS pressed has stopped saying it is unread.
    await person.act("press", "conversation", { named });
    await person.until(async () => !(await person.spoken("conversation", { named })).description.includes(unread), "the pressed letter to stop saying it is unread");
    // The list's last unread letter only passed by under the wheel.
    expect((await person.spoken("conversation", { named: last })).description, last).toContain(unread);
  });
});
