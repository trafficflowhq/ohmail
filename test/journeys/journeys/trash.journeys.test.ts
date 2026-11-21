import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, personWith, signedIn, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "Trash opens at its own address", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo says it has no Trash", rows: [], surfaces: ["W-d"], needs: [] },
];

const DELETED = { from: PEOPLE.ben, subject: "The old kiln booking", pile: "ohbox", deleted: true } as const;

journeysOf("trash", () => {
  journey(GUARDS[0]!, async (b) => {
    if (b.fixtures) {
      const { person } = await signedIn(b);
      await person.arrive("trash");
      await person.see("trash-region");
      return;
    }
    const { person, named } = await personWith(b, DELETED);
    await person.arrive("trash");
    await person.see("list-trash");
    await person.see("trash-letter", { named });
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("trash");
    expect(await person.text("trash-region")).toContain(say("trash.unavailable", {}, person.lang));
  });
});
