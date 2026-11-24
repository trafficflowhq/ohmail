/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import {
  AuthorizeDesktopPage,
  type AuthorizeDesktopDoor,
  type AuthorizeDesktopState,
} from "../../src/doors/authorize-desktop/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };
import { drawIn, factorSpies, stop, waitingStepUp } from "./desktop-support.js";

/**
 * AN APP ASKS TO BE SIGNED IN, over a fake door: the app by its name, the masked account, what it may do, the
 * server's countdown and the one press; signing in first where this browser has no session; a stale factor over the
 * page; a request that is over is one sentence and the way to start again.
 */
const W = en.authorizeDesktop;
const ask = (o: Partial<Extract<AuthorizeDesktopState, { at: "ask" }>> = {}): AuthorizeDesktopState => ({
  at: "ask",
  client: "tf-macos",
  address: "a•••@example.test",
  remaining: 112,
  busy: false,
  refusal: null,
  factor: false,
  ...o,
});

function draw(state: AuthorizeDesktopState, words: Record<string, unknown> = en, locale: "en" | "de" = "en") {
  const door: AuthorizeDesktopDoor = {
    state,
    confirm: vi.fn(),
    signIn: vi.fn(),
    stepUp: waitingStepUp,
    factor: factorSpies(),
  };
  drawIn(<AuthorizeDesktopPage door={door} />, words, locale);
  return door;
}
const page = () => document.body.textContent ?? "";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("an app asks to be signed in", () => {
  const titled = (app: string, address: string): string =>
    W.titleAs.replace("{app}", app).replace("<a>{address}</a>.", address);

  it("names a known app in this deployment's words and the masked account in its sentence; what it may do, the countdown", () => {
    draw(ask());
    expect(page()).toContain(titled(W.client["tf-macos"], "a•••@example.test"));
    /* The page's sentence is its line, as the design draws it, not a heading. */
    expect(screen.queryByRole("heading")).toBeNull();
    for (const said of [W.grantsMail, W.grantsLong, W.grantsRevoke, W.footer, W.safety])
      expect(page()).toContain(said);
    expect(page()).toContain(en.approve.left.replace("{time}", "1:52"));
  });

  it("names an app it has no words for as the app said it, as text", () => {
    draw(ask({ client: "<b>evil</b>" }));
    expect(page()).toContain(titled("<b>evil</b>", "a•••@example.test"));
    expect(document.querySelector("b")).toBeNull();
  });

  it("the one press is the door's, and while it works it says so", () => {
    const door = draw(ask());
    fireEvent.click(screen.getByRole("button", { name: W.confirm }));
    expect(door.confirm).toHaveBeenCalledTimes(1);
    cleanup();
    draw(ask({ busy: true }));
    expect((screen.getByRole("button", { name: W.working }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refusal stands under the sentence; a stale factor is asked over the page", () => {
    draw(ask({ refusal: en.stepUp.expired }));
    expect(screen.getByRole("alert").textContent).toContain(en.stepUp.expired);
    cleanup();
    const door = draw(ask({ factor: true }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(door.factor.onCancel).toHaveBeenCalledTimes(1);
  });

  it("with no session here: the request is over, and Sign in is the door's", () => {
    const door = draw({ at: "signin" });
    expect(page()).toContain(W.expiredTitle);
    expect(screen.getByRole("alert").textContent).toContain(en.linkDesktop.signInFirst);
    fireEvent.click(screen.getByRole("button", { name: en.login.title }));
    expect(door.signIn).toHaveBeenCalledTimes(1);
  });

  const cases: [AuthorizeDesktopState, string][] = [
    [{ at: "checking" }, W.working],
    [{ at: "unchecked" }, en.approve.signInUnchecked],
    [
      { at: "refused", said: "This window is for a different account." },
      "This window is for a different account.",
    ],
    [{ at: "over", said: null }, W.overWhy],
    [{ at: "done" }, W.doneBody],
  ];
  for (const [state, said] of cases) {
    it(`${state.at}: says it, and offers no press`, () => {
      draw(state);
      expect(page()).toContain(said);
      expect(screen.queryAllByRole("button")).toEqual([]);
    });
  }

  it("a request that is over says how to start again and why it may be over; the shell's own sentence stands above", () => {
    draw({ at: "over", said: null });
    expect(page()).toContain(W.expiredHint);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    /* The generic sentence is not said twice: its reasons are the page's note. */
    draw({ at: "over", said: W.expired });
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    draw({ at: "over", said: "The server refused the request." });
    expect(screen.getByRole("alert").textContent).toContain("The server refused the request.");
    cleanup();
    draw({ at: "done" });
    expect(page()).toContain(stop(W.doneTitle));
  });

  it("a build with no server says so; German where the catalogue is German", () => {
    drawIn(<AuthorizeDesktopPage door={NONE} />, en);
    expect(page()).toContain(W.unavailableBody);
    cleanup();
    draw(ask(), de, "de");
    expect(screen.getByRole("button", { name: de.authorizeDesktop.confirm })).toBeTruthy();
    expect(page()).toContain(de.authorizeDesktop.grantsMail);
  });
});
