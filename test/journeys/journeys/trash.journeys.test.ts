import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";

export const GUARDS: Guard[] = [
  { title: "Trash opens at its own address", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo says it has no Trash", rows: [], surfaces: ["W-d"], needs: [] },
];

journeysOf("trash", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("trash");
    await person.see("list-trash");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("trash");
    expect(await person.text("list-trash")).toContain(say("trash.unavailable", {}, person.lang));
  });
});
