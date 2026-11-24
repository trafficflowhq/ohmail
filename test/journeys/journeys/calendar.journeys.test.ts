import { WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Calendar opens from Mail and lets the person return to the Ohbox", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("calendar", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    await person.act("press", "switch-calendar");
    await person.here("calendar");
    await person.act("press", "switch-mail");
    await person.here("ohbox");
  });
});
