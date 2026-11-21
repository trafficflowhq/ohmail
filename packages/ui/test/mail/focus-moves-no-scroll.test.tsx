/** @vitest-environment jsdom */
/**
 * NO FOCUS MOVE OF THE KIT's READING AND WRITING PARTS SCROLLS WHAT IT STANDS IN (the switch's point 66, PART B): the
 * reading column counts a scroll under a resting pointer as the person's reading, so a focus move that scrolled it
 * would mark the letters it passed read. Every move the parts make themselves (the people line's walk and removals,
 * the contact card's places, the conversation's squares) asks the browser not to scroll.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ContactCard, ReadSquares, Recipients } from "../../src/mail/index.js";

let focus: MockInstance<(options?: FocusOptions) => void>;
beforeEach(() => {
  focus = vi.spyOn(HTMLElement.prototype, "focus");
});
afterEach(() => {
  focus.mockRestore();
  cleanup();
});

/** Every focus move made since the last look: each must ask not to scroll. */
const scrolling = (): number =>
  focus.mock.calls.filter(([options]) => options?.preventScroll !== true).length;

describe("the kit's focus moves", () => {
  it("the people line: the arrows walk the people and the typed words, a removal hands the keys back to the line", () => {
    const people = [
      { id: "a", name: "Anna", remove: "Remove Anna" },
      { id: "b", name: "Ben", remove: "Remove Ben" },
    ];
    render(<Recipients lines={[{ id: "to", label: "To", people, typed: "" }]} onRemove={() => undefined} />);
    const to = screen.getByRole("textbox", { name: "To" });
    fireEvent.keyDown(to, { key: "ArrowLeft" });
    const ben = document.activeElement as HTMLElement;
    fireEvent.keyDown(ben, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Backspace" });
    expect(focus.mock.calls.length, "the walk made no focus move").toBeGreaterThan(3);
    expect(scrolling(), "a focus move of the people line may scroll the column").toBe(0);
  });

  it("the contact card: the arrows walk the places", () => {
    render(
      <ContactCard
        open
        onClose={() => undefined}
        label="Giulia"
        person={{ name: "Giulia", address: "giulia@example.invalid" }}
        goes={{
          label: "Goes to",
          value: "ohbox",
          onChange: () => undefined,
          places: [
            { value: "ohbox", label: "Ohbox" },
            { value: "news", label: "News" },
          ],
        }}
      />,
    );
    focus.mockClear();
    const places = screen.getByRole("radiogroup", { name: "Goes to" });
    fireEvent.keyDown(within(places).getByRole("radio", { name: "Ohbox" }), { key: "ArrowDown" });
    expect(focus.mock.calls.length).toBeGreaterThan(0);
    expect(scrolling(), "a focus move of the card may scroll the column").toBe(0);
  });

  it("the conversation's squares: the arrows walk them", () => {
    render(
      <ReadSquares
        squares={["seen", "unseen"]}
        here={0}
        axis="row"
        label="2 messages"
        names={["Anna, Mon", "Ben, Tue"]}
        onJump={() => undefined}
        onFocusSquare={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Anna, Mon" }), { key: "ArrowRight" });
    expect(focus.mock.calls.length).toBeGreaterThan(0);
    expect(scrolling(), "a focus move of the squares may scroll the column").toBe(0);
  });
});
