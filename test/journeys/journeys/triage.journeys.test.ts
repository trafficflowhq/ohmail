import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Triage offers its three piles, and the pressed pile is the one shown", rows: [], surfaces: EVERY_WEB, needs: [] },
];

journeysOf("triage", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("triage");
    await person.see("triage-piles");
    await person.act("press", "triage-set-aside");
    await person.until(async () => (await person.spoken("triage-set-aside")).pressed === "true", "Parked to be the pressed pile");
    expect((await person.spoken("triage-reply-later")).pressed).toBe("false");
  });
});
