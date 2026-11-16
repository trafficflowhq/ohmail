/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import {
  LinkDesktopPage,
  type LinkDesktopDoor,
  type LinkDesktopPress,
  type LinkDesktopState,
} from "../../src/doors/link-desktop/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };
import { drawIn, factorSpies, stop, waitingStepUp } from "./desktop-support.js";

/**
 * THE APP NEEDS A CODE, over a fake door: the press makes one, the code stands in the page's text and nowhere else,
 * the way back to the app only for a code the app bound, the steps to type it in always; a busy server is a wait with
 * the button live; a factor cancelled, or signing in, is said.
 */
const W = en.linkDesktop;
const CODE = ["K7", "QM-42XD"].join("");
const press = (o: Partial<LinkDesktopPress> = {}): LinkDesktopPress => ({
  busy: false,
  retryIn: null,
  refusal: null,
  discarded: false,
  signIn: false,
  factor: false,
  ...o,
});

function draw(state: LinkDesktopState, words: Record<string, unknown> = en, locale: "en" | "de" = "en") {
  const door: LinkDesktopDoor = {
    state,
    press: vi.fn(),
    openApp: vi.fn(),
    signIn: vi.fn(),
    stepUp: waitingStepUp,
    factor: factorSpies(),
  };
  drawIn(<LinkDesktopPage door={door} />, words, locale);
  return door;
}
const page = () => document.body.textContent ?? "";
const code = (o: Partial<LinkDesktopPress> = {}, bound = true): LinkDesktopState => ({
  at: "code",
  code: CODE,
  remaining: 108,
  bound,
  ...press(o),
});

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the app needs a code", () => {
  it("start: says what the code is for, and the press is the door's", () => {
    const door = draw({ at: "start", ...press() });
    expect(page()).toContain(stop(W.title));
    expect(page()).toContain(W.typeIt);
    expect(page()).toContain(W.safety);
    fireEvent.click(screen.getByRole("button", { name: W.mint }));
    expect(door.press).toHaveBeenCalledTimes(1);
  });

  it("a bound code: said in the sentence, works once, counted down, handed back to the app by the door", () => {
    const door = draw(code());
    expect(page()).toContain(W.codeIs.replace("<c>{code}</c>.", CODE));
    expect(page()).toContain(W.once);
    expect(page()).toContain(en.approve.left.replace("{time}", "1:48"));
    expect(page()).toContain(W.fallback);
    fireEvent.click(screen.getByRole("button", { name: W.openApp }));
    expect(door.openApp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: W.again }));
    expect(door.press).toHaveBeenCalledTimes(1);
  });

  it("a code the app did not bind is never handed back over the app's address", () => {
    draw(code({}, false));
    expect(page()).toContain(CODE);
    expect(screen.queryByRole("button", { name: W.openApp })).toBeNull();
    expect(page()).not.toContain(W.fallback);
    expect(page()).toContain(W.typeIt);
  });

  it("the code stands in the page's text and in no attribute", () => {
    draw(code());
    const attributes = [...document.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((a) => a.value),
    );
    expect(attributes.some((v) => v.includes(CODE))).toBe(false);
    expect(document.title).not.toContain(CODE);
  });

  it("a busy server is a wait with the button live; a press in flight is not", () => {
    draw({ at: "start", ...press({ busy: true, retryIn: 8 }) });
    // It stands among the line's facts, and is announced as it counts, as the shipped page did.
    const waiting = W.busyRetrying.replace("{seconds}", "8");
    expect(screen.getByRole("status").textContent).toBe(waiting);
    expect(page()).toContain(waiting.replace(/\.$/, ""));
    expect((screen.getByRole("button", { name: W.mint }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    draw({ at: "start", ...press({ busy: true }) });
    expect((screen.getByRole("button", { name: W.working }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a factor cancelled: nothing was made, and it is said; still busy: said", () => {
    draw({ at: "start", ...press({ discarded: true }) });
    expect(screen.getByRole("alert").textContent).toContain(W.cancelledNothingMinted);
    cleanup();
    draw({ at: "start", ...press({ refusal: W.busyGaveUp }) });
    expect(screen.getByRole("alert").textContent).toContain(W.busyGaveUp);
  });

  it("signing in is the way on: said, and Sign in is the door's", () => {
    const door = draw({ at: "start", ...press({ signIn: true }) });
    expect(screen.getByRole("alert").textContent).toContain(W.signInFirst);
    fireEvent.click(screen.getByRole("button", { name: en.login.title }));
    expect(door.signIn).toHaveBeenCalledTimes(1);
    cleanup();
    const first = draw({ at: "signin" });
    fireEvent.click(screen.getByRole("button", { name: en.login.title }));
    expect(first.signIn).toHaveBeenCalledTimes(1);
  });

  it("a stale factor is asked over the page, and no code is shown under it until it verifies", () => {
    const door = draw({ at: "start", ...press({ factor: true }) });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(door.factor.onCancel).toHaveBeenCalledTimes(1);
    expect(page()).not.toContain(CODE);
  });

  const cases: [LinkDesktopState, string][] = [
    [{ at: "checking" }, W.working],
    [{ at: "unchecked" }, en.approve.signInUnchecked],
    [
      { at: "refused", said: "This window is for a different account." },
      "This window is for a different account.",
    ],
  ];
  for (const [state, said] of cases) {
    it(`${state.at}: says it, and offers no press`, () => {
      draw(state);
      expect(page()).toContain(said);
      expect(screen.queryAllByRole("button")).toEqual([]);
    });
  }

  it("a build with no server says so; German where the catalogue is German", () => {
    drawIn(<LinkDesktopPage door={NONE} />, en);
    expect(page()).toContain(W.unavailableBody);
    cleanup();
    draw({ at: "start", ...press() }, de, "de");
    expect(screen.getByRole("button", { name: de.linkDesktop.mint })).toBeTruthy();
  });
});
