/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  SignedOutPage,
  SIGNED_OUT_STATES,
  signedOutStateOf,
  type SignedOutDoor,
  type SignedOutState,
} from "../../src/doors/signed-out/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE SIGNED-OUT PAGE says, for each state the splash and the cold cards reach, the sentence of that state and
 * offers exactly its ways on, each the door's act. Found by role and name; the words are the catalogue's.
 */
type Words = typeof en;
const noDot = (s: string): string => s.replace(/\.$/, "");

function doorOf(state: SignedOutState, demo = true) {
  const acts = { tryAgain: vi.fn(), signIn: vi.fn(), demo: vi.fn() };
  const door: SignedOutDoor = {
    state,
    tryAgain: acts.tryAgain,
    signIn: acts.signIn,
    demo: demo ? acts.demo : NONE,
  };
  return { door, acts };
}

function draw(door: SignedOutDoor | typeof NONE, words: Words = en, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC">
      <SignedOutPage door={door} />
    </TextProvider>,
  );
}

const buttons = (): string[] => screen.queryAllByRole("button").map((b) => b.textContent ?? "");

afterEach(cleanup);

describe("the signed-out page, state by state", () => {
  it("says nothing while the sign-in is renewed within the grace, and marks the page busy", () => {
    const { door } = doorOf({ at: "checking", slow: false });
    const view = draw(door);
    expect(view.container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(view.container.textContent).toBe("oh");
    expect(buttons()).toEqual([]);
  });

  it("says what it waits for once the wait outlasts the grace", () => {
    const { door } = doorOf({ at: "checking", slow: true });
    draw(door);
    expect(document.body.textContent).toContain(en.resume.workingBody.replace(/\.$/, ""));
    expect(buttons()).toEqual([]);
  });

  it("busy: the server could not be reached, nobody was signed out, and Try again asks again", () => {
    const { door, acts } = doorOf({ at: "busy" });
    const view = draw(door);
    expect(view.container.textContent).toContain(en.resume.busyTitle);
    expect(view.container.textContent).toContain(en.resume.busyBody);
    expect(buttons()).toEqual([en.resume.tryAgain]);
    fireEvent.click(screen.getByRole("button", { name: en.resume.tryAgain }));
    expect(acts.tryAgain).toHaveBeenCalledTimes(1);
    expect(acts.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked", en.resume.revokedBody],
    ["expired", en.resume.expiredBody],
    ["absent", en.resume.absentBody],
    ["pending", en.resume.pendingBody],
  ] as const)("%s: please sign in again, with its reason, and the one way on", (reason, said) => {
    const { door, acts } = doorOf({ at: "signedOut", reason });
    const view = draw(door);
    expect(view.container.textContent).toContain(en.resume.failedTitle);
    expect(view.container.textContent).toContain(said);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(buttons()).toEqual([en.resume.signIn]);
    fireEvent.click(screen.getByRole("button", { name: en.resume.signIn }));
    expect(acts.signIn).toHaveBeenCalledTimes(1);
  });

  it("reused: the sign-in used twice is said as a refusal, with Sign in", () => {
    const { door } = doorOf({ at: "signedOut", reason: "reused" });
    draw(door);
    expect(screen.getByRole("alert").textContent).toBe(en.resume.reusedBody);
    expect(en.resume.reusedBody).toBe(
      "This browser used a sign-in that had already been renewed, as a restored backup, a copied browser profile or a stolen sign-in would. ohmail ended it everywhere. If you did not restore or copy anything, change your password.",
    );
    expect(buttons()).toEqual([en.resume.signIn]);
  });

  it("out: nothing was loaded; Sign in, and the demo only where this build has one", () => {
    const { door, acts } = doorOf({ at: "out" });
    const view = draw(door);
    expect(view.container.textContent).toContain(noDot(en.session.endedTitle));
    /* The design's line, and why as its note. */
    expect(view.container.textContent).toContain("Sign in again and your mail is here.");
    expect(view.container.textContent).toContain(
      "This session could not be confirmed, so nothing has been loaded.",
    );
    expect(buttons()).toEqual([en.session.signIn, en.session.openDemo]);
    fireEvent.click(screen.getByRole("button", { name: en.session.openDemo }));
    expect(acts.demo).toHaveBeenCalledTimes(1);
    cleanup();
    draw(doorOf({ at: "out" }, false).door);
    expect(buttons()).toEqual([en.session.signIn]);
  });

  it.each([
    [false, en.session.unconfirmedLine],
    [true, en.session.unconfirmedBodyWarm],
  ] as const)("unchecked (warm %s): the check did not finish; Try again, then Sign in", (warm, said) => {
    const { door, acts } = doorOf({ at: "unchecked", warm });
    const view = draw(door);
    expect(view.container.textContent).toContain(noDot(en.session.unconfirmedTitle));
    expect(view.container.textContent).toContain(said);
    expect(buttons()).toEqual([en.session.tryAgain, en.session.signIn]);
    fireEvent.click(screen.getByRole("button", { name: en.session.tryAgain }));
    expect(acts.tryAgain).toHaveBeenCalledTimes(1);
  });

  it("a build with no server behind it says so, and offers nothing", () => {
    const view = draw(NONE);
    expect(view.container.textContent).toContain(noDot(en.gate.lede));
    expect(buttons()).toEqual([]);
  });

  it("names each state by the reference's address", () => {
    expect(signedOutStateOf({ at: "signedOut", reason: "reused" })).toBe("reused");
    expect(signedOutStateOf({ at: "checking", slow: true })).toBe("checking");
    expect([...SIGNED_OUT_STATES].sort()).toEqual([
      "absent",
      "busy",
      "checking",
      "expired",
      "out",
      "pending",
      "reused",
      "revoked",
      "unchecked",
    ]);
  });
});

describe("in German", () => {
  it("every state says the German catalogue's sentence, and no key reaches the page", () => {
    const states: SignedOutState[] = [
      { at: "busy" },
      { at: "out" },
      { at: "unchecked", warm: false },
      { at: "checking", slow: true },
      ...(["revoked", "reused", "expired", "absent", "pending"] as const).map(
        (reason) => ({ at: "signedOut", reason }) as const,
      ),
    ];
    for (const state of states) {
      const view = draw(doorOf(state).door, de as unknown as Words, "de");
      const text = view.container.textContent ?? "";
      expect(text, JSON.stringify(state)).not.toMatch(/\b(resume|session|gate)\.[a-zA-Z]+/);
      expect(text.length, JSON.stringify(state)).toBeGreaterThan(5);
      cleanup();
    }
    const view = draw(doorOf({ at: "busy" }).door, de as unknown as Words, "de");
    expect(view.container.textContent).toContain(de.resume.busyBody);
  });
});
