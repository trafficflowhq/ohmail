import { calendarDayMenu, WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "The Day event menu opens by pointer and keyboard", rows: [], surfaces: WEB, needs: [] },
  { title: "Calendar opens from Mail and lets the person return to the Ohbox", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("calendar", () => {
  journey(GUARDS[0]!, async (b) => {
    const { account, person } = await signedIn(b);
    const title = "Ceramics workshop";
    const fixture = await account.planter.plantCalendarInvitation(title);
    await person.follow(`${b.origin}/#/cal/day/${fixture.date}`);
    await calendarDayMenu(person, title, b.size === "compact");
  });

  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("ohbox");
    await person.act("press", "switch-calendar");
    await person.here("calendar");
    await person.act("press", "switch-mail");
    await person.here("ohbox");
  });
});
