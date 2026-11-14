import { expect } from "vitest";
import { EVERY_WEB, WEB, journey, journeysOf, personWith, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";
import { PEOPLE } from "../vocabulary/world.js";

export const GUARDS: Guard[] = [
  { title: "Opening a conversation shows its letter and offers Reply", rows: [], surfaces: EVERY_WEB, needs: [] },
  {
    title: "A letter turns read once it has been opened and stayed on screen",
    rows: ["read-letter-stays-unread"], surfaces: EVERY_WEB, needs: [],
  },
  {
    title: "A letter that was read on screen is marked read at the server",
    rows: ["read-letter-stays-unread"], surfaces: WEB, needs: [],
  },
  {
    title: "A waiting sender's letter is shown with its pictures blocked, and nothing asks for them",
    rows: [], surfaces: WEB, needs: [],
  },
  { title: "Reply's own key opens the reply", rows: [], surfaces: EVERY_WEB, needs: [] },
];

const UNREAD = { from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: true, letters: 2, text: "Good news twice." } as const;
const PICTURE_HOST = "pictures.atelier-eichspan.example";
/** From somebody still waiting in the Screener: nobody has let them in. */
const PICTURES = {
  from: PEOPLE.stranger, subject: "Glaze samples", pile: "screener", unread: true, text: "Three glazes.",
  html: `<p>Three glazes.</p><img src="https://${PICTURE_HOST}/glaze.png" width="40" height="40" alt="glaze">`,
} as const;

journeysOf("reader", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, named } = await personWith(b, UNREAD);
    await person.arrive("ohbox");
    await person.act("press", "conversation", { named });
    await person.see("reader");
    await person.see("reply");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person, named } = await personWith(b, UNREAD);
    await person.arrive("ohbox");
    const unread = say("message.rowUnread", {}, person.lang);
    expect((await person.spoken("conversation", { named })).description).toContain(unread);
    await person.act("press", "conversation", { named });
    await person.until(async () => !(await person.spoken("conversation", { named })).description.includes(unread), "the row to stop saying it is unread");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person, named } = await personWith(b, UNREAD);
    await person.arrive("ohbox");
    const before = b.heard.length;
    await person.act("press", "conversation", { named });
    // The far end: the server took a change to the account's messages, and answered it.
    await person.until(async () => b.heard.slice(before).some((h) => h.method === "PATCH" && h.pattern === "/messages" && h.status === 200),
      "the server to take the read mark");
  });
  journey(GUARDS[3]!, async (b) => {
    const { person, named } = await personWith(b, PICTURES);
    await person.arrive("screener");
    await person.act("press", "conversation", { named });
    await person.see("images-blocked");
    // The far end: nothing asked for the picture, at its own host or through the server's proxy,
    // and not when the letter is shown in the sender's own formatting either.
    const asked = (): string[] => person.requests().filter((u) => u.includes(PICTURE_HOST));
    expect(asked()).toEqual([]);
    await person.act("press", "show-original");
    await person.see("show-as-text");
    await person.see("images-blocked");
    expect(asked()).toEqual([]);
  });
  journey(GUARDS[4]!, async (b) => {
    const { person, named } = await personWith(b, UNREAD);
    await person.arrive("ohbox");
    await person.act("press", "conversation", { named });
    await person.act("shortcut", "reply");
    await person.see("reply-send");
  });
});
