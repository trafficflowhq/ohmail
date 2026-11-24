/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import {
  DeleteAccountPage,
  deleteAccountStateOf,
  type DeleteAccountDoor,
  type DeleteAccountService,
  type DeleteAccountState,
} from "../../src/doors/delete-account/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };
import { drawIn, factorSpies, stop, waitingStepUp } from "./desktop-support.js";

/**
 * THE ACCOUNT, DELETED IN FULL, over a fake door: both lists stand before anything is typed; the press is off until
 * the session's own address is typed back (trimmed, in any case); the press asks the second factor over the page and
 * the dialog's line names the act and the address; every outcome is said; a self-hosted server keeps its own row
 * and offers no policy of ours.
 */
const W = en.deleteAccount;
const EMAIL = "person@example.test";
const form = (o: Partial<Extract<DeleteAccountState, { at: "form" }>> = {}): DeleteAccountState => ({
  at: "form",
  email: EMAIL,
  subscription: false,
  typed: "",
  busy: false,
  refusal: null,
  cancelled: false,
  factor: false,
  ...o,
});

function draw(
  state: DeleteAccountState,
  service: DeleteAccountService = "managed",
  words: Record<string, unknown> = en,
  locale: "en" | "de" = "en",
) {
  const door: DeleteAccountDoor = {
    state,
    service,
    type: vi.fn(),
    begin: vi.fn(),
    back: vi.fn(),
    home: vi.fn(),
    signIn: vi.fn(),
    privacy: vi.fn(),
    stepUp: waitingStepUp,
    factor: factorSpies(),
  };
  const view = drawIn(<DeleteAccountPage door={door} />, words, locale);
  return { view, door };
}
const page = () => document.body.textContent ?? "";
const begin = () => screen.getByRole("button", { name: W.begin }) as HTMLButtonElement;

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("what is erased and what is kept", () => {
  it("both lists stand before anything is typed, and the press is off", () => {
    draw(form());
    /* The page's sentence holds the blank the address is typed into; it is the page's line, not a heading. */
    expect(page()).toContain(W.of.replace("<blank></blank>.", ""));
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([W.goneTitle, W.keptTitle]);
    for (const said of [W.gone1, W.gone2, W.gone3, W.gone4, W.goneWhen, W.kept1, W.kept2, W.kept3, W.backups])
      expect(page()).toContain(said);
    expect(page()).toContain(W.lead);
    expect(page()).toContain(W.mail);
    expect(begin().disabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the blank is named by the session's own address, and carries nothing the address bar said", () => {
    draw(form());
    const blank = screen.getByRole("textbox", {
      name: W.typeLabel.replace("{email}", EMAIL),
    }) as HTMLInputElement;
    expect(blank.value).toBe("");
    expect(blank.getAttribute("autocomplete")).toBe("off");
  });

  it("a subscription to speak of is in what is kept; none, no line", () => {
    draw(form({ subscription: true }));
    expect(page()).toContain(W.keptSub);
    cleanup();
    draw(form());
    expect(page()).not.toContain(W.keptSub);
  });

  it("on a server you host: its own row, and no policy of ours", () => {
    const { door } = draw(form(), "self");
    expect(page()).toContain(W.keptSelfHost);
    expect(page()).not.toContain(W.kept1);
    expect(screen.queryByRole("button", { name: W.backupsLink })).toBeNull();
    expect(deleteAccountStateOf(door)).toBe("own");
  });

  it("on the hosted service the policy is the door's", () => {
    const { door } = draw(form());
    fireEvent.click(screen.getByRole("button", { name: W.backupsLink }));
    expect(door.privacy).toHaveBeenCalledTimes(1);
  });
});

describe("the address typed back, then the second factor", () => {
  it("typing is the door's", () => {
    const { door } = draw(form());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "p" } });
    expect(door.type).toHaveBeenCalledWith("p");
  });

  it("the press is on only for the session's own address, trimmed and in any case", () => {
    for (const [typed, on] of [
      [EMAIL, true],
      [`  ${EMAIL.toUpperCase()} `, true],
      ["person@example.tes", false],
      ["someone@example.test", false],
    ] as const) {
      const { door } = draw(form({ typed }));
      expect(begin().disabled, typed).toBe(!on);
      fireEvent.click(begin());
      expect(door.begin, typed).toHaveBeenCalledTimes(on ? 1 : 0);
      cleanup();
    }
  });

  it("Enter in the blank begins only for the right address", () => {
    const { door } = draw(form({ typed: "nobody@example.test" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(door.begin).not.toHaveBeenCalled();
    cleanup();
    const right = draw(form({ typed: EMAIL }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(right.door.begin).toHaveBeenCalledTimes(1);
    cleanup();
    /* Not while the erase runs. */
    const running = draw(form({ typed: EMAIL, busy: true }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(running.door.begin).not.toHaveBeenCalled();
  });

  it("the factor is asked over the page; its line names the act and the address; its answers are the door's", () => {
    const { door } = draw(form({ typed: EMAIL, factor: true }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(W.factorBody.replace("{email}", EMAIL));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.stepUp.cancel) }));
    expect(door.factor.onCancel).toHaveBeenCalledTimes(1);
    expect(door.begin).not.toHaveBeenCalled();
    expect(deleteAccountStateOf(door)).toBe("factor");
  });

  it("while the erase runs the press says so and is off", () => {
    const { door } = draw(form({ typed: EMAIL, busy: true }));
    expect((screen.getByRole("button", { name: W.erasing }) as HTMLButtonElement).disabled).toBe(true);
    expect(deleteAccountStateOf(door)).toBe("erasing");
  });

  it("a refusal, and a factor cancelled before it landed, are each said; the address stays typed", () => {
    const { door } = draw(
      form({ typed: EMAIL, refusal: "Your account was not deleted and nothing was removed." }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Your account was not deleted and nothing was removed.",
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(EMAIL);
    expect(deleteAccountStateOf(door)).toBe("refused");
    cleanup();
    const cancelled = draw(form({ typed: EMAIL, cancelled: true }));
    expect(screen.getByRole("alert").textContent).toContain(W.cancelledNothingErased);
    expect(deleteAccountStateOf(cancelled.door)).toBe("cancelled");
  });

  it("Back is the door's", () => {
    const { door } = draw(form());
    fireEvent.click(screen.getByRole("button", { name: W.back }));
    expect(door.back).toHaveBeenCalledTimes(1);
  });
});

describe("the outcome", () => {
  it("erased, the subscription cancelled: said; the way on is the door's", () => {
    const { door } = draw({ at: "done", subscription: "cancelled", unclean: false });
    expect(page()).toContain(stop(W.doneTitle));
    expect(page()).toContain(W.doneBody);
    expect(page()).toContain(W.doneNote);
    expect(page()).toContain(W.doneSubCancelled);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: W.doneHome }));
    expect(door.home).toHaveBeenCalledTimes(1);
    expect(deleteAccountStateOf(door)).toBe("done");
  });

  it("erased, the subscription not cancelled: said as a warning", () => {
    const { door } = draw({ at: "done", subscription: "cancel_failed", unclean: false });
    expect(screen.getByRole("alert").textContent).toContain(stop(W.doneSubFailed));
    expect(deleteAccountStateOf(door)).toBe("donepay");
  });

  it("erased, another tab holds this browser's copy: the receipt and the warning", () => {
    const { door } = draw({ at: "done", subscription: "none", unclean: true });
    expect(page()).toContain(W.doneBody);
    expect(screen.getByRole("alert").textContent).toContain(W.erasedMirrorBlocked);
    expect(deleteAccountStateOf(door)).toBe("donetab");
  });

  it("a server you host says Done", () => {
    draw({ at: "done", subscription: "none", unclean: false }, "self");
    expect(screen.getByRole("button", { name: W.doneHomeSelfHost })).toBeTruthy();
  });
});

describe("before the form", () => {
  it("no live session: said, with the way to sign in", () => {
    const { door } = draw({ at: "signedout" });
    expect(page()).toContain(W.signedOutBody);
    fireEvent.click(screen.getByRole("button", { name: W.signIn }));
    expect(door.signIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  const said: [DeleteAccountState, string][] = [
    [{ at: "checking" }, W.loading],
    [{ at: "unchecked" }, en.approve.signInUnchecked],
    [
      { at: "refused", said: "This window is for a different account." },
      "This window is for a different account.",
    ],
  ];
  for (const [state, sentence] of said) {
    it(`${state.at}: says it, and offers nothing to press or type`, () => {
      draw(state);
      expect(page()).toContain(sentence);
      expect(screen.queryAllByRole("button")).toEqual([]);
      expect(screen.queryByRole("textbox")).toBeNull();
    });
  }

  it("a build with no server says so", () => {
    drawIn(<DeleteAccountPage door={NONE} />, en);
    expect(page()).toContain(W.unavailableBody);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("waits without a word until its words have arrived", () => {
    const { deleteAccount: _gone, ...without } = en;
    draw(form(), "managed", without);
    expect(page()).toBe("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("speaks German where the catalogue is German", () => {
    draw(form({ typed: EMAIL }), "managed", de, "de");
    expect(screen.getByRole("button", { name: de.deleteAccount.begin })).toBeTruthy();
    expect(page()).toContain(de.deleteAccount.gone1);
  });
});
