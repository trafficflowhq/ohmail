/** @vitest-environment jsdom */
/**
 * WHAT THE LETTER's HEAD SAYS BEYOND WHAT IT DRAWS (the switch's point 65; today's head said each): the stamp carries
 * the letter's instant as a machine date; a sender with no name is printed once; every name says it opens a card and
 * whether that card stands open, and a second press on the name whose card is open closes it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { letter, mountReader } from "./support/mail.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

/** The letter's own head: the header inside its article (the sheet's reading head stands above the letters). */
const head = (): HTMLElement => screen.getAllByRole("article")[0]!.querySelector<HTMLElement>("header")!;
const card = (who: string): HTMLElement | null =>
  screen.queryByRole("dialog", { name: `Options for ${who}` });

describe("the letter's head", () => {
  it("puts the letter's instant behind its printed stamp", () => {
    mountReader({ letters: [letter("m1", { date: "2026-08-05T14:32:00.000Z" })], open: "m1" });
    const when = head().querySelector("time");
    expect(when?.getAttribute("datetime")).toBe("2026-08-05T14:32:00.000Z");
  });

  it("prints a sender with no name once", () => {
    mountReader({
      letters: [letter("m1", { from: { name: null, address: "verify@atlas.invalid" } })],
      open: "m1",
    });
    expect((head().textContent ?? "").split("verify@atlas.invalid").length - 1).toBe(1);
  });

  it("a name says its card is open while it stands, and a second press on it closes the card", () => {
    mountReader({
      letters: [letter("m1", { cc: [{ name: "Ada", address: "ada@kiln.example" }] })],
      open: "m1",
    });
    const ada = screen.getByRole("button", { name: "Ada" });
    expect([ada.getAttribute("aria-haspopup"), ada.getAttribute("aria-expanded")]).toEqual([
      "dialog",
      "false",
    ]);
    act(() => {
      fireEvent.click(ada);
    });
    expect(card("Ada")).not.toBeNull();
    expect(ada.getAttribute("aria-expanded")).toBe("true");
    const sender = screen.getByRole("button", { name: /Ben Kiln/ });
    expect(sender.getAttribute("aria-expanded"), "only the name whose card is open says so").toBe("false");
    act(() => {
      fireEvent.click(ada);
    });
    expect(card("Ada")).toBeNull();
    expect(ada.getAttribute("aria-expanded")).toBe("false");
  });
});
