/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SignOutOutcome } from "../../../src/account/contract.js";
import type { AccountBody, AccountDoor } from "../../../src/account/account/model.js";
import { useAccount } from "../../../src/account/account/use-account.js";
import {
  fakeAccountDoor,
  held,
  NOT_HANDED,
  SIGNED_OUT,
  signedIn,
  THROWS,
  unread,
  type WhoAnswer,
} from "./fake-door.js";

afterEach(cleanup);

const ADDRESS = "mila@lichtgrat.example";

function mounted(door: AccountDoor, body: AccountBody = "pane", strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useAccount(door, body), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
  });
/** The pane opened and its read answered. */
async function opened(door: AccountDoor, body: AccountBody = "pane", strict = false) {
  const hook = mounted(door, body, strict);
  await settled(() => {});
  return hook;
}

describe("who is signed in, asked as the pane opens", () => {
  it("asks once, and claims nothing before the answer", async () => {
    const who = held<WhoAnswer>();
    const door = fakeAccountDoor({ who: [who.promise] });
    const { result } = mounted(door);
    expect(result.current.who).toEqual({ at: "loading" });
    await settled(() => who.settle(signedIn(ADDRESS)));
    expect(result.current.who).toEqual({ at: "signedIn", address: ADDRESS });
    expect(door.calls()).toEqual(["who"]);
  });

  it("still reads where the tree is mounted twice over", async () => {
    const door = fakeAccountDoor({ who: [signedIn(ADDRESS), signedIn(ADDRESS)] });
    const { result } = await opened(door, "pane", true);
    expect(result.current.who).toEqual({ at: "signedIn", address: ADDRESS });
  });

  it("tells nobody signed in from a read that failed", async () => {
    const out = await opened(fakeAccountDoor({ who: [SIGNED_OUT] }));
    expect(out.result.current.who).toEqual({ at: "signedOut" });
    const failed = await opened(fakeAccountDoor({ who: [unread("The server could not be reached.")] }));
    expect(failed.result.current.who).toEqual({ at: "failed", said: "The server could not be reached." });
    const broken = await opened(fakeAccountDoor({ who: [THROWS] }));
    expect(broken.result.current.who).toEqual({ at: "failed", said: "" });
    const unhanded = await opened(fakeAccountDoor());
    expect(unhanded.result.current.who).toEqual({ at: "failed", said: NOT_HANDED });
  });

  it("a read refused as a way back in is nobody signed in", async () => {
    const { result } = await opened(fakeAccountDoor({ who: [{ ok: false, word: "sign_in" }] }));
    expect(result.current.who).toEqual({ at: "signedOut" });
  });
});

describe("signing this browser out", () => {
  const signedInDoor = (signOuts: Parameters<typeof fakeAccountDoor>[0] = {}) =>
    fakeAccountDoor({ who: [signedIn(ADDRESS)], ...signOuts });

  it("is one press that reaches the door at once: nothing is asked before it", async () => {
    const door = signedInDoor({ signOuts: ["left"] });
    const { result } = await opened(door);
    await settled(() => result.current.signOut());
    expect(door.calls()).toEqual(["who", "signOut"]);
    expect(result.current.asked).toBe(false);
  });

  it("a sign-out that left stays on its way until the page is gone", async () => {
    const { result } = await opened(signedInDoor({ signOuts: ["left"] }));
    await settled(() => result.current.signOut());
    expect(result.current.signingOut).toBe(true);
    expect(result.current.stayed).toBeNull();
  });

  for (const outcome of ["blocked", "unverified"] as const) {
    it(`stays and says why when the door answers ${outcome}`, async () => {
      const { result } = await opened(signedInDoor({ signOuts: [outcome] }));
      await settled(() => result.current.signOut());
      expect(result.current.signingOut).toBe(false);
      expect(result.current.stayed).toBe(outcome);
    });
  }

  it("one at a time, and the next press starts clean", async () => {
    const first = held<SignOutOutcome>();
    const door = signedInDoor({ signOuts: [first.promise, "left"] });
    const { result } = await opened(door);
    await settled(() => result.current.signOut());
    await settled(() => result.current.signOut());
    expect(door.calls()).toEqual(["who", "signOut"]);
    await settled(() => first.settle("blocked"));
    expect(result.current.stayed).toBe("blocked");
    await settled(() => result.current.signOut());
    expect(result.current.stayed).toBeNull();
    expect(door.calls()).toEqual(["who", "signOut", "signOut"]);
  });

  it("a door that gave no answer stays, and says the copy could not be confirmed gone", async () => {
    const { result } = await opened(signedInDoor({ signOuts: [THROWS] }));
    await settled(() => result.current.signOut());
    expect(result.current.signingOut).toBe(false);
    expect(result.current.stayed).toBe("unverified");
  });

  it("an answer that lands after the pane was left changes nothing", async () => {
    const leaving = held<SignOutOutcome>();
    const { result, unmount } = await opened(signedInDoor({ signOuts: [leaving.promise] }));
    await settled(() => result.current.signOut());
    unmount();
    await settled(() => leaving.settle("blocked"));
    expect(result.current.stayed).toBeNull();
  });
});

describe("the way to the page that deletes the account", () => {
  it("is one press that leaves, and asks the server nothing", async () => {
    const door = fakeAccountDoor({ who: [signedIn(ADDRESS)] });
    const { result } = await opened(door);
    await settled(() => result.current.toErase());
    expect(door.calls()).toEqual(["who", "toErase"]);
  });
});

describe("the sign-out that stands alone", () => {
  it("asks nobody who is signed in", async () => {
    const door = fakeAccountDoor({ who: [signedIn(ADDRESS)] });
    const { result } = await opened(door, "signOutOnly");
    expect(result.current.who).toEqual({ at: "unasked" });
    expect(door.calls()).toEqual([]);
  });

  it("is asked for first: only the question's own Confirm reaches the door", async () => {
    const door = fakeAccountDoor({ signOuts: ["left"] });
    const { result } = await opened(door, "signOutOnly");
    await settled(() => result.current.confirmSignOut());
    expect(door.calls()).toEqual([]);
    await settled(() => result.current.signOut());
    expect(result.current.asked).toBe(true);
    expect(door.calls()).toEqual([]);
    await settled(() => result.current.cancelSignOut());
    expect(result.current.asked).toBe(false);
    await settled(() => result.current.confirmSignOut());
    expect(door.calls()).toEqual([]);
    await settled(() => result.current.signOut());
    await settled(() => result.current.confirmSignOut());
    expect(door.calls()).toEqual(["signOut"]);
    expect(result.current.asked).toBe(false);
    expect(result.current.signingOut).toBe(true);
  });
});
