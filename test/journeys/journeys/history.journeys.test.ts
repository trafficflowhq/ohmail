import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "History opens from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo's History lists its old mail", rows: [], surfaces: ["W-d"], needs: [] },
];

journeysOf("history", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    await person.act("press", "rail-history");
    await person.here("history");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("history");
    await person.see("list-history");
  });
});
