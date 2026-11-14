/** @vitest-environment jsdom */
/**
 * A PASTED COLUMN OF ADDRESSES IS HANDED WHOLE: the place to type a person is
 * one line of text, so a paste that holds line breaks (a column out of a sheet or a letter) would run its addresses
 * together. A paste that holds a break, a tab, a comma or a semicolon is handed to the app as it was copied,
 * for it to make every whole address a person; a paste of one address is typed as ever.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recipients } from "../../src/mail/index.js";

afterEach(cleanup);

const pasted = (onPaste: ((line: string, text: string) => void) | undefined, text: string) => {
  render(<Recipients lines={[{ id: "to", label: "To", people: [], typed: "" }]} onPaste={onPaste} />);
  const to = screen.getByRole("textbox", { name: "To" });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: { getData: (kind: string) => (kind === "text" ? text : "") } });
  fireEvent(to, event);
  return event;
};

describe("a paste into a people line", () => {
  it.each([
    ["line breaks", "c@z.invalid\nd@w.invalid"],
    ["tabs", "c@z.invalid\td@w.invalid"],
    ["commas", "c@z.invalid, d@w.invalid"],
    ["semicolons", "c@z.invalid; d@w.invalid"],
  ])("of several addresses apart by %s is handed whole to the app, not typed", (_, text) => {
    const onPaste = vi.fn();
    const event = pasted(onPaste, text);
    expect(onPaste).toHaveBeenCalledWith("to", text);
    expect(event.defaultPrevented, "the browser's own paste would drop the breaks").toBe(true);
  });

  it("of one address is typed as ever", () => {
    const onPaste = vi.fn();
    const event = pasted(onPaste, "c@z.invalid");
    expect(onPaste).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("where the app takes no paste, the browser's own paste stands", () => {
    expect(pasted(undefined, "c@z.invalid\nd@w.invalid").defaultPrevented).toBe(false);
  });
});
