/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import {
  ApprovePage,
  type ApproveAsked,
  type ApproveDoor,
  type ApproveState,
} from "../../src/doors/approve/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };
import { drawIn, factorSpies, stop, waitingStepUp } from "./desktop-support.js";

/**
 * A COMPUTER ASKS TO BE SIGNED IN, over a fake door: the page names it in its own words (as text, whatever they are),
 * where it asked from and the account the confirm binds; Confirm and Not me are the door's; a stale factor is asked
 * over the page; every way the request cannot be confirmed is one sentence.
 */
const W = en.approve;
const ASKED: ApproveAsked = {
  label: "Kitchen laptop",
  platform: "Linux",
  minutes: 0,
  network: "a home network",
  otherNetwork: false,
  account: "a@example.test",
  remaining: 280,
};
const ask = (
  o: Partial<Extract<ApproveState, { at: "ask" }>> = {},
  asked: Partial<ApproveAsked> = {},
): ApproveState => ({
  at: "ask",
  asked: { ...ASKED, ...asked },
  busy: false,
  retryIn: null,
  refusal: null,
  factor: false,
  ...o,
});

function draw(state: ApproveState, words: Record<string, unknown> = en, locale: "en" | "de" = "en") {
  const door: ApproveDoor = {
    state,
    confirm: vi.fn(),
    deny: vi.fn(),
    stepUp: waitingStepUp,
    factor: factorSpies(),
  };
  const view = drawIn(<ApprovePage door={door} />, words, locale);
  return { view, door };
}
const page = () => document.body.textContent ?? "";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("a computer asks to be signed in", () => {
  it("names the computer in its sentence; its platform, when and from where it asked, the account and the time left are its facts", () => {
    draw(ask());
    expect(page()).toContain(W.titleOn.replace("<name>{computer}</name>.", "Kitchen laptop"));
    /* The page's sentence is its line, as the design draws it, not a heading. */
    expect(screen.queryByRole("heading")).toBeNull();
    for (const said of [
      "Linux",
      W.requestedJustNow.replace("{network}", "a home network").replace(/\.$/, ""),
      W.signsIn.replace("{email}", "a@example.test"),
      W.onlyYours,
      W.left.replace("{time}", "4:40"),
    ])
      expect(page()).toContain(said);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Confirm and Not me are the door's", () => {
    const { door } = draw(ask());
    fireEvent.click(screen.getByRole("button", { name: W.confirm }));
    fireEvent.click(screen.getByRole("button", { name: W.deny }));
    expect(door.confirm).toHaveBeenCalledTimes(1);
    expect(door.deny).toHaveBeenCalledTimes(1);
  });

  it("draws the computer's own words as text, and says so where it gave none", () => {
    draw(
      ask(
        {},
        { label: '<img src=x onerror="alert(1)">', platform: null, network: null, minutes: 3, account: null },
      ),
    );
    expect(page()).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector("img")).toBeNull();
    expect(page()).toContain(W.requestedMinutesAgoNoNetwork.replace("{minutes}", "3").replace(/\.$/, ""));
    expect(page()).not.toContain(W.signsIn.replace("{email}", ""));
    cleanup();
    /* A computer that gave no name is "this computer". */
    draw(ask({}, { label: null }));
    expect(page()).toContain(stop(W.title));
  });

  it("from another network: says so, as a refusal to read before the press", () => {
    draw(ask({}, { otherNetwork: true }));
    expect(screen.getByRole("alert").textContent).toContain(W.otherNetwork);
  });

  it("a busy server is a wait with Confirm still live; a press in flight is not", () => {
    draw(ask({ busy: true, retryIn: 8 }));
    // It stands where the time left stands, and is announced as it counts, as the shipped page did.
    const waiting = W.busyRetrying.replace("{seconds}", "8");
    expect(screen.getByRole("status").textContent).toBe(waiting);
    expect(page()).toContain(waiting.replace(/\.$/, ""));
    expect(page()).not.toContain(W.left.replace("{time}", "4:40"));
    expect((screen.getByRole("button", { name: W.confirm }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    draw(ask({ busy: true }));
    expect((screen.getByRole("button", { name: W.working }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: W.deny }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the shell's sentence for the last press stands under the page's sentence", () => {
    draw(ask({ refusal: W.busyGaveUp }));
    expect(screen.getByRole("alert").textContent).toContain(W.busyGaveUp);
  });

  it("a stale second factor is asked over the page, and its answers are the door's", () => {
    const { door } = draw(ask({ factor: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.stepUp.cancel) }));
    expect(door.factor.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("every other state is one sentence", () => {
  const cases: [ApproveState, string][] = [
    [{ at: "closed" }, W.notOffered],
    [{ at: "bare" }, W.missing],
    [{ at: "checking", retryIn: null }, W.working],
    [{ at: "checking", retryIn: 5 }, "retrying in 5 s"],
    [{ at: "unchecked" }, W.signInUnchecked],
    [
      { at: "refused", said: "This window is for a different account." },
      "This window is for a different account.",
    ],
    [{ at: "gone", said: null }, W.expired],
    [{ at: "gone", said: W.used }, W.used],
    [{ at: "done" }, W.doneBody],
    [{ at: "denied" }, W.deniedBody],
  ];
  for (const [state, said] of cases) {
    it(`${state.at}: says it, and offers no press`, () => {
      draw(state);
      expect(page()).toContain(said);
      expect(screen.queryAllByRole("button")).toEqual([]);
    });
  }

  it("done and denied say their own sentences", () => {
    draw({ at: "done" });
    expect(page()).toContain(stop(W.doneTitle));
    expect(page()).toContain(W.doneNote);
    cleanup();
    draw({ at: "denied" });
    expect(page()).toContain(W.deniedTitle);
  });

  it("a build with no server says so", () => {
    drawIn(<ApprovePage door={NONE} />, en);
    expect(page()).toContain(W.unavailableBody);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("speaks German where the catalogue is German", () => {
    draw(ask(), de, "de");
    expect(screen.getByRole("button", { name: de.approve.confirm })).toBeTruthy();
    expect(page()).toContain(de.approve.onlyYours);
    expect(page()).toContain(
      de.approve.titleOn.replace("<name>{computer}</name>", "Kitchen laptop").replace(/\.$/, ""),
    );
  });
});
