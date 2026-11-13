import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "An account that is not set up yet is brought to its setup, with the steps listed", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("first-run", () => {
  journey(GUARDS[0]!, async (b) => {
    const person = await b.person({ account: await b.account() });
    await person.arrive("first-run");
  });
});
