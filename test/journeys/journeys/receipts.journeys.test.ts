import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "Receipts draws in the built app, with its letters", rows: ["stream-view-does-not-draw"], surfaces: EVERY_WEB, needs: [] },
];

const LETTER = { from: PEOPLE.skylark, subject: "The joy of small tools", pile: "receipts", unread: true, text: "A love letter to tools that do one thing." } as const;

journeysOf("receipts", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("receipts");
    await person.see("list-receipts");
    expect((await person.spoken("conversation", { named })).description).toContain(say("message.rowUnread", {}, person.lang));
  });
});
