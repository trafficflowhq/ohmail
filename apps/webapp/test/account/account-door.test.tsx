/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOwner, rememberOwner } from "@ohmail/app-logic/storage/owner-cookie";
import type { FactorSlot } from "@ohmail/app/account";
import {
  catchConsole,
  catchLoads,
  en,
  json,
  refusal,
  serve,
  session,
  settle,
  Words,
  type Server,
} from "./account-harness";
import { AccountPane, useAccount, usePassword } from "../../../../packages/app/src/account/account/index.js";
import { ApiError, auth, bindApiOwner } from "../../app/api-client";
import { accountDoor, useAccountDoor } from "../../app/(product)/mailbox/account-door";
import { usePasswordDoor } from "../../app/(product)/mailbox/password-door";

/**
 * SETTINGS › ACCOUNT OVER THE WEB'S REAL FILLING and a server that records what it is asked. Sign-out is one press
 * with no factor before it; it leaves by a full load, and does not leave while this browser still holds the mail.
 * Nothing in the pane erases: its one verb about erasure leaves for the delete page.
 *
 * The one sign-out function is stood in for (its own cases walk the wipe): the stand-in asks the server's sign-out
 * door, records the account it was handed, and answers what a case says this browser still holds.
 */
const wipe = vi.hoisted(() => ({
  handed: [] as (string | undefined)[],
  held: { cleared: true, remaining: [] as string[], inventoryComplete: true, serverRefused: null as string | null },
}));
vi.mock("../../app/sign-out", async (original) => ({
  ...await original<typeof import("../../app/sign-out")>(),
  signOut: async (owner?: string) => {
    wipe.handed.push(owner);
    try {
      const answer = await fetch("/auth/refresh/logout", { method: "POST" });
      if (!answer.ok) wipe.held.serverRefused = `refused ${answer.status}`;
    } catch {
      wipe.held.serverRefused = "unreachable";
    }
    return { ...wipe.held };
  },
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
}));

const SESSION = "GET /api/auth/session";
const LOGOUT = "POST /auth/refresh/logout";
const ERASE = "DELETE /api/account";
const ACCOUNT = "account-under-test";
const ADDRESS = "mila@lichtgrat.example";

let server: Server;
let tab: ReturnType<typeof catchLoads>;
let written: ReturnType<typeof catchConsole>;
const factor: FactorSlot = vi.fn(() => <p>the factor is asked</p>);
/** The shell's way back to a live session, stood in for: the door is handed it and names no way of its own. */
const toSignIn = vi.fn();

beforeEach(() => {
  wipe.handed = [];
  rememberOwner(ACCOUNT);
  document.cookie = "tf_family=fixture-family; Path=/";
  wipe.held = { cleared: true, remaining: [], inventoryComplete: true, serverRefused: null };
  written = catchConsole();
  tab = catchLoads();
  server = serve({
    [SESSION]: () => json(session()),
    [LOGOUT]: () => new Response(null, { status: 204 }),
  });
});
afterEach(() => {
  cleanup();
  bindApiOwner(null);
  forgetOwner();
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  server.restore();
  tab.restore();
  written.restore();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function Pane() {
  // A new function at every draw, as a shell's registration hands it: the door must stay one door.
  return (
    <AccountPane
      body="pane"
      model={useAccount(useAccountDoor(() => toSignIn()))}
      password={usePassword(usePasswordDoor())}
      factor={factor}
    />
  );
}
function Alone() {
  return <AccountPane body="signOutOnly" model={useAccount(useAccountDoor(toSignIn), "signOutOnly")} />;
}
async function opened(alone = false) {
  const view = render(<Words>{alone ? <Alone /> : <Pane />}</Words>);
  await settle();
  return view;
}
const said = (sentence: string): boolean => (document.body.textContent ?? "").includes(sentence);
const press = async (name: string, inside: HTMLElement = document.body) => {
  await act(async () => {
    fireEvent.click(within(inside).getByRole("button", { name }));
  });
  await settle();
};

describe("who is signed in, as the door answers it", () => {
  const say = (): string => "said by the renderer";

  it("a full session names its address, and nothing else of the account leaves the door", async () => {
    expect(await accountDoor(say, toSignIn).who()).toEqual({ ok: true, value: { address: ADDRESS } });
  });

  it("an enrolment still open, or a session that names no account, is nobody signed in", async () => {
    server.answer(SESSION, json({ ...session(), scope: "enrollment" }), json(session({ accountId: "" })));
    const door = accountDoor(say, toSignIn);
    expect(await door.who()).toEqual({ ok: false, word: "signed_out" });
    expect(await door.who()).toEqual({ ok: false, word: "signed_out" });
  });

  it("a 401 or a 403 is nobody signed in; anything else is a read that failed, said with no remedy", async () => {
    const door = accountDoor(say, toSignIn);
    for (const status of [401, 403]) {
      vi.spyOn(auth, "session").mockRejectedValueOnce(new ApiError(status, "unauthorized", "x"));
      expect(await door.who(), String(status)).toEqual({ ok: false, word: "signed_out" });
    }
    for (const failed of [new ApiError(503, "internal", "x"), new ApiError(0, "network_unreachable", "x"), new Error("x")]) {
      vi.spyOn(auth, "session").mockRejectedValueOnce(failed);
      expect(await door.who()).toEqual({ ok: false, word: "said", said: "said by the renderer" });
    }
  });
});

describe("opening the pane", () => {
  it("asks who is signed in, once, and nothing else", async () => {
    await opened();
    expect(server.asked()).toEqual([`${SESSION} {}`]);
    expect(screen.getByRole("heading", { name: ADDRESS })).toBeTruthy();
  });

  it("nobody signed in: says so, and the way to sign in is the shell's own, taken once", async () => {
    vi.spyOn(auth, "session").mockRejectedValueOnce(new ApiError(401, "unauthorized", "x"));
    await opened();
    expect(said(en.account.signedOutBody)).toBe(true);
    expect(screen.queryByRole("button", { name: en.account.signOut })).toBeNull();
    await press(en.account.signIn);
    expect(toSignIn).toHaveBeenCalledTimes(1);
    expect(tab.loads).toEqual([]);
  });

  it("a read that failed: its reason, no remedy, no sign-out and no way to erase", async () => {
    vi.spyOn(auth, "session").mockRejectedValueOnce(new ApiError(503, "internal", "the server is down"));
    await opened();
    for (const name of [en.account.signIn, en.account.signOut, en.account.begin])
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    expect(tab.loads).toEqual([]);
  });
});

describe("signing this browser out", () => {
  it("is one press: the server's door is asked once for the account the session named, and no factor is asked", async () => {
    await opened();
    server.forget();
    await press(en.account.signOut);
    expect(server.asked()).toEqual([`${LOGOUT} {}`]);
    expect(wipe.handed).toEqual([ACCOUNT]);
    expect(factor).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves by a full load of the front door, never by a move inside the page", async () => {
    const moved = [vi.spyOn(window.history, "pushState"), vi.spyOn(window.history, "replaceState")];
    await opened();
    await press(en.account.signOut);
    expect(tab.loads).toEqual(["/"]);
    for (const move of moved) expect(move).not.toHaveBeenCalled();
  });

  it("does not leave while this browser still holds the mail, and says so", async () => {
    wipe.held = { cleared: false, remaining: ["a mirror another tab holds"], inventoryComplete: true, serverRefused: null };
    await opened();
    await press(en.account.signOut);
    expect(tab.loads).toEqual([]);
    expect(said(en.account.signOutBlocked)).toBe(true);
    expect(screen.getByRole("button", { name: en.account.signOut })).toBeTruthy();
  });

  it("does not leave where this browser will not say what it holds, and says that first", async () => {
    wipe.held = { cleared: false, remaining: ["a mirror"], inventoryComplete: false, serverRefused: null };
    await opened();
    await press(en.account.signOut);
    expect(tab.loads).toEqual([]);
    expect(said(en.account.signOutUnverified)).toBe(true);
    expect(said(en.account.signOutBlocked)).toBe(false);
  });

  it("a server that refuses, even for a factor, asks no factor: the wiped browser leaves for the front door", async () => {
    server.answer(LOGOUT, refusal(403, "step_up_required"));
    await opened();
    await press(en.account.signOut);
    expect(factor).not.toHaveBeenCalled();
    expect(server.on(LOGOUT)).toHaveLength(1);
    expect(tab.loads).toEqual(["/"]);
  });
});

describe("the erase is not in the pane", () => {
  it("the one verb about it leaves for the delete page by a full load, and asks the server nothing", async () => {
    await opened();
    server.forget();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    await press(en.account.begin);
    expect(tab.loads).toEqual(["/account/delete"]);
    expect(server.asked()).toEqual([]);
  });

  it("through every state of the pane, the server is never asked to erase", async () => {
    wipe.held = { cleared: false, remaining: ["a mirror"], inventoryComplete: true, serverRefused: null };
    await opened();
    await press(en.account.signOut);
    await press(en.passwordChange.submit);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en.passwordChange.currentLabel), { target: { value: "x" } });
    });
    await press(en.passwordChange.submit);
    await press(en.account.begin);
    cleanup();
    vi.spyOn(auth, "session").mockRejectedValueOnce(new ApiError(401, "unauthorized", "x"));
    await opened();
    cleanup();
    bindApiOwner(ACCOUNT, "fixture-family");
    await opened(true);
    expect(server.on(ERASE)).toEqual([]);
    expect(server.sent.filter((s) => s.line.startsWith("DELETE"))).toEqual([]);
  });
});

describe("the sign-out alone", () => {
  it("asks the server nothing as it opens, asks the person first, and signs out only from the question's Confirm", async () => {
    bindApiOwner(ACCOUNT, "fixture-family");
    await opened(true);
    expect(server.asked()).toEqual([]);
    await press(en.pairLanding.signOut);
    expect(server.asked()).toEqual([]);
    const question = screen.getByRole("dialog");
    expect(question.textContent).toContain(en.pairLanding.signOutConfirm);
    await press(en.pairLanding.signOutCancel, question);
    expect(server.asked()).toEqual([]);
    await press(en.pairLanding.signOut);
    await press(en.pairLanding.signOut, screen.getByRole("dialog"));
    expect(server.asked()).toEqual([`${LOGOUT} {}`]);
    expect(tab.loads).toEqual(["/"]);
  });
});
