import { expect } from "vitest";
import type { Bench, Stack } from "../bench/seam.js";
import { Authenticator } from "../bench/totp.js";
import { journey, journeysOf, type Guard } from "../bench/web.js";

/**
 * SIGNING IN ON A SELF-HOSTED INSTALL, as its operator runs it: the stack from its images, its own door, nothing
 * in front. What a move to another host must keep: the sign-in, the sign-up on an invite, a session across a new
 * API container, and a session cookie that is worth nothing under another name.
 */
export const GUARDS: Guard[] = [
  {
    title: "A person with an account signs in with their password and their authenticator's code, and arrives",
    rows: [], surfaces: ["W-i"], needs: ["stack"], tolerates: [/status of 401/],
  },
  {
    title: "A person with an invite's link makes an account and its second factor, and arrives at its setup",
    rows: [], surfaces: ["W-i"], needs: ["stack"], tolerates: [/status of 401/],
  },
  {
    title: "A signed-in person stays signed in across a new API container, with what they chose, and can still change it",
    rows: [], surfaces: ["W-i"], needs: ["stack"],
  },
  {
    title: "A session cookie under a name the install was not set up for opens nothing: the door refuses it, and so does the API",
    rows: [], surfaces: ["W-i"], needs: ["stack"], tolerates: [/status of 421/],
  },
];

const stackOf = (b: Bench): Stack => {
  if (!b.stack) throw new Error("this journey walks the self-hosted stack");
  return b.stack;
};

journeysOf("gate", () => {
  journey(GUARDS[0]!, async (b) => {
    const who = await stackOf(b).registered();
    const person = await b.person();
    await person.arrive("gate");
    await person.act("type", "login-email", { value: who.email });
    await person.act("type", "login-password", { value: who.password });
    await person.act("press", "login-continue");
    await person.until(async () => (await person.offered("login-code")) || (await person.offered("login-code-instead")), "the sign-in to ask for the second factor", 30_000);
    if (!(await person.offered("login-code"))) await person.act("press", "login-code-instead");
    await person.act("type", "login-code", { value: await who.code() });
    await person.act("press", "login-code-verify");
    // An account with no mailbox yet carries on with its setup.
    await person.here("first-run");
  });

  journey(GUARDS[1]!, async (b) => {
    const person = await b.person();
    await person.follow(stackOf(b).invite());
    await person.act("type", "invite-email", { value: `grace-${Date.now()}@selfhost.example` });
    await person.act("type", "invite-name", { value: "Grace Invited" });
    await person.act("type", "invite-password", { value: `invited-${Date.now()}-kiln-shelf` });
    await person.act("press", "invite-create");
    await person.until(async () => (await person.offered("join-key")) || (await person.offered("join-use-totp")), "the setup to ask for a second factor", 30_000);
    if (!(await person.offered("join-key"))) await person.act("press", "join-use-totp");
    // The key, read off the page as a person types it into their authenticator.
    const app = new Authenticator(await person.text("join-key"));
    await person.act("type", "join-code", { value: await app.code() });
    await person.act("press", "join-activate");
    await person.reads("join.step_codes_title");
  });

  journey(GUARDS[2]!, async (b) => {
    const account = await b.account();
    const person = await b.person({ account });
    const first = person.lang;
    const other = first === "en" ? "de" : "en";
    await person.speak(other);
    await stackOf(b).recreate("api");
    // Arriving finds the section by its name in the chosen language: signed out, or the choice lost, it never comes.
    await person.arrive("settings-general");
    await person.speak(first);
    await person.arrive("settings-general");
    expect((await person.spoken(`language-${first}`)).pressed).toBe("true");
  });

  journey(GUARDS[3]!, async (b) => {
    const stack = stackOf(b);
    const account = await b.account();
    const elsewhere = new URL(stack.elsewhere);
    const person = await b.person({ account, host: elsewhere.hostname });
    const door = await person.follow(`${stack.elsewhere}/`);
    expect(door.status, "the install's door answered under a name it was not set up for").toBe(421);
    expect(await person.offered("rail")).toBe(false);
    // Past the door, at the API itself: the same cookie under the install's own name is the control.
    const home = await stack.inside({ host: new URL(b.origin).host, path: "/auth/session", account });
    expect(home, "the API did not know the account under its own name: this ask proves nothing").toEqual({ status: 200, user: true });
    const there = await stack.inside({ host: elsewhere.host, path: "/auth/session", account });
    expect(there.user, "the API took the session cookie under a foreign name").toBe(false);
  });
});
