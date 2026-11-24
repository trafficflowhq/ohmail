import { stackOf } from "../bench/journey.js";
import { journey, journeysOf, type Guard } from "../bench/web.js";
import { PEOPLE } from "../vocabulary/world.js";

/**
 * MAIL THAT ARRIVES THROUGH A MAIL SERVER, on the self-hosted stack: a letter handed to the stack's own mail server
 * by an invented sender, brought in by its organizer, and shown where a person looks for it. Nothing is planted in
 * the stack's database: the letter takes the way every letter takes.
 */
export const GUARDS: Guard[] = [
  {
    title: "A first-time sender's letter that came through the mail server waits in the Screener",
    rows: [], surfaces: ["W-i"], needs: ["stack", "mail"],
  },
];

journeysOf("screener", () => {
  journey(GUARDS[0]!, async (b) => {
    const account = await b.account();
    const subject = "Kleine Ergänzung";
    await stackOf(b).deliver(account, { from: PEOPLE.stranger, subject, text: "Noch eine Zeile zum Angebot." });
    const person = await b.person({ account });
    await person.arrive("screener");
    await person.see("list-screener");
    await person.see("conversation", { named: `${PEOPLE.stranger.name}: ${subject}` });
  });
});
