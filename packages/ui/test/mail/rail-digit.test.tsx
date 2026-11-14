/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RailEntry } from "../../src/mail/index.js";

/**
 * A RAIL ENTRY's DIGIT (the switch's point 65): drawn whenever it is handed, beside the entry's own key; the rail's sheet
 * shows it, in the key's place, only while the keys are within the rail, so nothing is drawn again when they move in
 * or out. It is said to a screen reader as a key that goes there, beside the entry's shortcut.
 */
afterEach(cleanup);

describe("RailEntry's digit", () => {
  it("is drawn beside the entry's own key, and said with its shortcut", () => {
    render(
      <RailEntry kind="place" keyHint="g i" keyStands shortcut="g i" digit="1" label="Ohbox">
        Ohbox
      </RailEntry>,
    );
    const entry = screen.getByRole("button", { name: "Ohbox" });
    expect(entry.getAttribute("aria-keyshortcuts")).toBe("g i 1");
    expect([...entry.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["1", "g i"]);
  });

  it("without a digit, the entry draws its key alone", () => {
    render(
      <RailEntry kind="place" keyHint="g i" keyStands label="Ohbox">
        Ohbox
      </RailEntry>,
    );
    expect(
      [...screen.getByRole("button", { name: "Ohbox" }).querySelectorAll("kbd")].map((k) => k.textContent),
    ).toEqual(["g i"]);
  });
});
