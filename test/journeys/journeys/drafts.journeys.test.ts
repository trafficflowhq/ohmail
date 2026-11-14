import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Drafts opens from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo's Drafts lists the letter that was started", rows: [], surfaces: ["W-d"], needs: [] },
];

journeysOf("drafts", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    await person.act("press", "rail-drafts");
    await person.here("drafts");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("drafts");
    await person.see("list-drafts");
  });
});
