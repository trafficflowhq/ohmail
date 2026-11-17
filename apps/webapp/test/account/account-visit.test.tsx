/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  catchConsole,
  catchLoads,
  en,
  json,
  serve,
  session,
  settle,
  Words,
  type Server,
} from "./account-harness";
import { AccountPane, useAccount, usePassword } from "../../../../packages/app/src/account/account/index.js";
import { useAccountDoor } from "../../app/(product)/mailbox/account-door";
import { AccountSection } from "../../app/(product)/mailbox/AccountSection";
import { usePasswordDoor } from "../../app/(product)/mailbox/password-door";

/**
 * THE CALLS OF ONE VISIT, BEFORE AND AFTER. The shipped section and the new pane over the web's filling are each
 * walked through the same visit over the same scripted server: open; sign this browser out; leave. The two ordered
 * lists of method, path and body keys are equal but for ONE declared difference: the shipped section also asked the
 * account's standing ("is there a subscription?") for the erase it drew inline; that question went to the delete
 * page with the erase. Both hand the one sign-out function the same account: the one the session's read named.
 *
 * The one sign-out function is stood in for (its own cases walk the wipe): the stand-in asks the server's sign-out
 * door and records the account it was handed.
 */
const wipe = vi.hoisted(() => ({ handed: [] as (string | undefined)[] }));
vi.mock("../../app/sign-out", () => ({
  signOut: async (owner?: string) => {
    wipe.handed.push(owner);
    await fetch("/auth/refresh/logout", { method: "POST" });
    return { cleared: true, remaining: [], inventoryComplete: true, serverRefused: null };
  },
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
}));

const SESSION = "GET /api/auth/session";
const ACCESS = "GET /api/account/access";
const LOGOUT = "POST /auth/refresh/logout";

/** The shell's way back to the sign-in page: this visit never takes it. */
const notAsked = (): void => {};
let server: Server;
let tab: ReturnType<typeof catchLoads>;
let written: ReturnType<typeof catchConsole>;
const scripted = (): Server =>
  serve({
    [SESSION]: () => json(session()),
    [ACCESS]: () => json({ metered: false }),
    [LOGOUT]: () => new Response(null, { status: 204 }),
  });

beforeEach(() => {
  wipe.handed = [];
  written = catchConsole();
  tab = catchLoads();
  server = scripted();
});
afterEach(() => {
  cleanup();
  server.restore();
  tab.restore();
  written.restore();
});

async function walk(pane: ReactNode) {
  const { unmount } = render(<Words>{pane}</Words>);
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.account.signOut }));
  });
  await settle();
  unmount();
  await settle();
  return { asked: server.asked(), handed: [...wipe.handed], loads: [...tab.loads] };
}

describe("one visit to Settings › Account asks the server the same things, in the same order", () => {
  it("the shipped section and the new pane, but for the standing the erase asked for", async () => {
    const before = await walk(<AccountSection />);
    cleanup();
    server.restore();
    server = scripted();
    wipe.handed = [];
    tab.loads.length = 0;

    function Anew() {
      return (
        <AccountPane
          body="pane"
          model={useAccount(useAccountDoor(notAsked))}
          password={usePassword(usePasswordDoor())}
          factor={() => null}
        />
      );
    }
    const after = await walk(<Anew />);

    expect(after.asked).toEqual([`${SESSION} {}`, `${LOGOUT} {}`]);
    expect(before.asked.filter((line) => line !== `${ACCESS} {}`)).toEqual(after.asked);
    expect(before.asked.filter((line) => line === `${ACCESS} {}`)).toHaveLength(1);
    expect(after.handed).toEqual(before.handed);
    expect(after.handed).toEqual(["account-under-test"]);
    expect(after.loads).toEqual(before.loads);
    expect(after.loads).toEqual(["/"]);
  });
});
