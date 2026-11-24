import { expect } from "vitest";
import { openPane } from "../bench/panes.js";
import type { Bench, Person } from "../bench/seam.js";
import { WEB, holdSignOutCookieClear, journey, journeysOf, signInPaintWhileLeaving, signOutReachedFront, type DoorFault, type Guard } from "../bench/web.js";

/**
 * Where a signed-out person stands differs by setting: a self-hosted server shows its sign-in
 * page; the managed app sends them to its front page, which another deployment serves and this
 * bench does not serve. The completed exit reaches that front door with the rail gone.
 * The pressing tab also stays in progress while revocation or browser cleanup is pending.
 */
const TOLERATED = [/status of 401/, /status of 404/];

export const GUARDS: Guard[] = [
  { title: "Sign out ends the session at the server and takes the person out of the app", rows: [], surfaces: WEB, needs: [], tolerates: TOLERATED },
  { title: "After signing out, asking for the app again stays at the sign-in page", rows: [], surfaces: ["W-s"], needs: [], tolerates: TOLERATED },
  {
    // The other tab's engine logs that its sync was cut off under it; that line is expected here.
    title: "Sign out in one tab takes the other tab out before the server has answered",
    rows: ["sign-out-leaves-the-other-tab-signed-in"], surfaces: WEB, needs: [], tolerates: [...TOLERATED, /SyncAbortedError/],
  },
  {
    title: "A sign-out the server never answers still ends, and the sign-in page finishes it",
    rows: ["sign-out-hangs-then-loops"], surfaces: ["W-s"], needs: [], tolerates: [...TOLERATED, /SyncAbortedError/],
  },
  { title: "A fresh sign-in page keeps the departed account's face off screen during sign-out", rows: [], surfaces: ["W-s"], needs: [], tolerates: [...TOLERATED, /SyncAbortedError/] },
];

async function out(b: Bench, person: Person): Promise<void> {
  await person.gone("rail", {}, 60_000);
  if (b.setting === "W-s") await person.here("gate");
}

const isSignOut = (method: string, pattern: string): boolean => method === "POST" && pattern === "/auth/refresh/logout";
/** The sign-out door holds every request it is asked. */
const held: DoorFault = (method, pattern) => (isSignOut(method, pattern) ? "hold" : null);
/** The door never answers the press, and answers whoever asks after it, as a server that came back would. */
function heldOnce(): DoorFault {
  let asked = 0;
  return (method, pattern) => (isSignOut(method, pattern) && (asked += 1) === 1 ? "hold" : null);
}

journeysOf("sign-out", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, account } = await openPane(b, "settings-account", "sign-out");
    const clearCookies = await holdSignOutCookieClear(person);
    b.faults.push(held);
    try {
      await person.act("press", "sign-out");
      await person.until(async () => b.held().length > 0, "the sign-out request to reach the server");
      await person.gone("rail");
      await person.reads("account.signOutBusy");
      expect(await b.sessionLive(account!), "the held request has yet to revoke the session").toBe(true);
      b.release();
      await person.until(async () => clearCookies.asked(), "the pressing tab to finish revoking and sweeping");
      expect(await b.sessionLive(account!)).toBe(false);
      expect((await b.ask(account!, "GET", "/auth/session")).status).toBe(401);
      await person.reads("account.signOutBusy");
    } finally {
      clearCookies.release();
      b.release();
    }
    await signOutReachedFront(person);
    await out(b, person);
    expect(await b.sessionLive(account!)).toBe(false);
    expect((await b.ask(account!, "GET", "/auth/session")).status).toBe(401);
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await openPane(b, "settings-account", "sign-out");
    await person.act("press", "sign-out");
    await out(b, person);
    await person.front();
    await person.here("gate");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person, account } = await openPane(b, "settings-account", "sign-out");
    const other = await person.tab();
    await other.arrive("ohbox");
    // The server is not answering, so nothing it says can take the other tab out: only the first tab can.
    b.faults.push(held);
    await person.act("press", "sign-out");
    await out(b, other);
    expect(await b.sessionLive(account!), "the server had not ended the session yet").toBe(true);
    b.release();
    await out(b, person);
  });
  journey(GUARDS[3]!, async (b) => {
    const { person, account } = await openPane(b, "settings-account", "sign-out");
    b.faults.push(heldOnce());
    await person.act("press", "sign-out");
    await out(b, person);
    await person.until(async () => !(await b.sessionLive(account!)), "the sign-in page to end the session at the server", 60_000);
    await person.front();
    await person.here("gate");
    await person.see("login-continue");
  });
  journey(GUARDS[4]!, async (b) => {
    const { person, account } = await openPane(b, "settings-account", "sign-out");
    await signInPaintWhileLeaving(b, person, account!.accountId);
  });
});
