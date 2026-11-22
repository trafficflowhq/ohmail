import { expect } from "vitest";
import { EVERY_WEB, WEB, firstCachedOhboxPaint, journey, journeysOf, personWith, resetOhboxPaint, sharedBrowserPaint, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "The Ohbox lists a new conversation by sender and subject, and says it is unread", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "Mark all read leaves no conversation in the Ohbox saying unread", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The Ohbox is reached from the rail", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The first Ohbox list frame already shows the browser's cached letter", rows: [], surfaces: WEB, needs: [] },
  { title: "A shared browser does not paint the previous account's face or mail", rows: [], surfaces: WEB, needs: [], tolerates: [/SyncAbortedError/, /status of 409/] },
  { title: "A reset keeps the surviving letter on screen and removes a deleted letter", rows: [], surfaces: ["W-s"], needs: [], tolerates: [/status of 410/] },
];

const NEW = { from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: true, text: "Good news twice." } as const;

journeysOf("ohbox", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("ohbox");
    expect((await person.spoken("conversation", { named })).description).toContain(say("ohbox.row.unread", {}, person.lang));
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("ohbox");
    const count = b.fixtures ? b.fixtures.count({ pile: "ohbox", unread: true }) : 1;
    await person.act("press", "mark-all-read", { args: { count } });
    const unread = say("ohbox.row.unread", {}, person.lang);
    await person.until(async () => !(await person.spoken("conversation", { named })).description.includes(unread), "the conversation to stop saying it is unread");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("settings");
    await person.act("press", "rail-ohbox");
    await person.here("ohbox");
    await person.see("conversation", { named });
  });
  journey(GUARDS[3]!, async (b) => {
    const { person, named } = await personWith(b, NEW);
    await person.arrive("ohbox");
    await person.see("conversation", { named });
    b.faults.push((_method, path) => path === "/sync" || path === "/sync/snapshot" ? "hold" : null);
    expect(await firstCachedOhboxPaint(person, NEW.subject)).toEqual({ rows: true, waiting: false });
  });
  journey(GUARDS[4]!, async (b) => {
    const account = await b.account();
    await account.planter.plant({ conversations: [NEW] });
    const person = await b.person({ account });
    await person.arrive("ohbox");
    await person.see("conversation", { named: `${NEW.from.name}: ${NEW.subject}` });
    await sharedBrowserPaint(b, person, account, NEW.subject);
  });
  journey(GUARDS[5]!, async (b) => {
    const account = await b.account();
    const [, deleted] = await account.planter.plant({
      conversations: [NEW, { ...NEW, from: PEOPLE.giulia, subject: "Workshop meeting" }],
    });
    const person = await b.person({ account });
    await person.arrive("ohbox");
    await person.see("conversation", { named: `${PEOPLE.ben.name}: ${NEW.subject}` });
    await person.see("conversation", { named: `${deleted!.from}: ${deleted!.subject}` });
    await resetOhboxPaint(person, NEW.subject, deleted!);
  });
});
