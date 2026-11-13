import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "A stranger at the sign-in page is asked for an email and a password", rows: [], surfaces: WEB, needs: [], tolerates: [/status of 401/] },
  {
    title: "A stranger who asks for the app is brought to the sign-in page, and stays there",
    rows: [], surfaces: ["W-s"], needs: [], tolerates: [/status of 401/],
  },
];

journeysOf("gate", () => {
  journey(GUARDS[0]!, async (b) => {
    const person = await b.person();
    await person.arrive("gate");
    await person.see("login-email");
    await person.see("login-password");
    await person.see("login-continue");
  });
  journey(GUARDS[1]!, async (b) => {
    const person = await b.person();
    await person.page.goto(`${b.origin}/`, { waitUntil: "commit" });
    await person.here("gate");
  });
});
