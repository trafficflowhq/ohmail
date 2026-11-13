import { EVERY_WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "Search has one box, named Search, and it takes the focus", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "Searching a sender's name finds their letter", rows: [], surfaces: ["W-d"], needs: [] },
];

const LETTER = { from: PEOPLE.giulia, subject: "Glaze order", pile: "ohbox", unread: false } as const;

journeysOf("search", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await personWith(b, LETTER);
    await person.arrive("search");
    await person.see("search-box");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, row } = await personWith(b, LETTER);
    await person.arrive("search");
    await person.act("type", "search-box", { value: row.from });
    await person.see("search-hit", { named: row.subject });
  });
});
