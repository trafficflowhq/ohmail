/** @vitest-environment jsdom */
/**
 * A MODIFIED ENTER OR TAB IN A PEOPLE LINE MAKES NO PERSON (the switch's point 66): Mod+Enter is Send's
 * chord, and the words typed in To are left as they are for it, never turned first into a person the letter is then
 * refused for. Plain Enter and Tab still make one.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recipients } from "../../src/mail/index.js";

afterEach(cleanup);

const typedIn = (onCommit: (line: string, value: string) => void) =>
  render(<Recipients lines={[{ id: "to", label: "To", people: [], typed: "le" }]} onCommit={onCommit} />);

describe("the people line's keys", () => {
  it("Mod+Enter, Ctrl+Enter, Alt+Enter and a modified Tab over typed words make no person", () => {
    const onCommit = vi.fn();
    typedIn(onCommit);
    const to = screen.getByRole("textbox", { name: "To" });
    fireEvent.keyDown(to, { key: "Enter", metaKey: true });
    fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(to, { key: "Enter", altKey: true });
    fireEvent.keyDown(to, { key: "Tab", ctrlKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("plain Enter and Tab still make the typed words a person", () => {
    const onCommit = vi.fn();
    typedIn(onCommit);
    const to = screen.getByRole("textbox", { name: "To" });
    fireEvent.keyDown(to, { key: "Enter" });
    fireEvent.keyDown(to, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenCalledWith("to", "le");
  });
});
