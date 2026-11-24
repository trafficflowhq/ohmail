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
import { usePasswordDoor } from "../../app/(product)/mailbox/password-door";

/** One Account visit, from opening to sign-out. The delete page owns the separate subscription read. */
const wipe = vi.hoisted(() => ({ handed: [] as (string | undefined)[] }));
vi.mock("../../app/sign-out", async (original) => ({
  ...await original<typeof import("../../app/sign-out")>(),
  signOutAndSettle: async (owner?: string) => {
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
  it("reads who is signed in and signs out that account without reading its subscription", async () => {
    function Account() {
      return (
        <AccountPane
          body="pane"
          model={useAccount(useAccountDoor(notAsked))}
          password={usePassword(usePasswordDoor())}
          factor={() => null}
        />
      );
    }
    const visit = await walk(<Account />);

    expect(visit.asked).toEqual([`${SESSION} {}`, `${LOGOUT} {}`]);
    expect(visit.handed).toEqual(["account-under-test"]);
    expect(visit.loads).toEqual(["/"]);
  });
});
