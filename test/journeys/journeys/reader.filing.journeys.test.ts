import { WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "Park moves the open conversation from the Ohbox into Parked", rows: [], surfaces: WEB, needs: [] },
  { title: "Undo after deleting an open conversation brings it back to the Ohbox", rows: [], surfaces: WEB, needs: [] },
];

const LETTER = { from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: false } as const;

journeysOf("reader", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("ohbox");
    await person.act("press", "conversation", { named });
    await person.act("press", "park");
    await person.gone("conversation", { named });
    await person.act("press", "rail-set-aside");
    await person.see("conversation", { named });
  });

  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, LETTER);
    await person.arrive("ohbox");
    await person.act("press", "conversation", { named });
    await person.act("press", "more");
    await person.act("press", "delete-letter");
    await person.gone("conversation", { named });
    await person.act("press", "undo");
    await person.see("conversation", { named });
  });
});
