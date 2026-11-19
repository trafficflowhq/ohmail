/** @vitest-environment jsdom */
/**
 * THE CONVERSATION's SQUARES TAKE THE KEYBOARD: where a press on a square opens
 * the conversation on that letter and each square is named, the squares are one roving set: one tab stop, on the
 * square the reader is on; the arrows, Home and End walk them and say where the keys went (so a square beyond the run
 * can be pulled over); Enter or Space opens that letter. Where no jump or no names are handed they stay a picture.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadSquares } from "../../src/mail/index.js";

afterEach(cleanup);

const NAMES = ["Anna, Mon 08:00", "Ben, Mon 09:12", "Anna, Tue 10:30", "You, Tue 11:02"];

const walked = (here = 1) => {
  const onJump = vi.fn();
  const onFocusSquare = vi.fn();
  render(
    <ReadSquares
      squares={["seen", "seen", "unseen", "own"]}
      here={here}
      axis="row"
      label="4 messages, 1 unread"
      names={NAMES}
      onJump={onJump}
      onFocusSquare={onFocusSquare}
    />,
  );
  return { onJump, onFocusSquare };
};
const square = (name: string) => screen.getByRole("button", { name });
const stops = () => screen.getAllByRole("button").filter((b) => b.tabIndex === 0);

describe("the squares, from the keyboard", () => {
  it("are named buttons with one tab stop, on the square the reader is on", () => {
    walked(1);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(NAMES);
    expect(stops()).toEqual([square("Ben, Mon 09:12")]);
  });

  it("the arrows, Home and End walk them, the stop follows, and each move says where the keys went", () => {
    const { onFocusSquare } = walked(1);
    square("Ben, Mon 09:12").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(square("Anna, Tue 10:30"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(square("You, Tue 11:02"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(square("Anna, Mon 08:00"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement, "the first stays the first").toBe(square("Anna, Mon 08:00"));
    expect(onFocusSquare.mock.calls.map(([i]) => i)).toEqual([2, 3, 0]);
    expect(stops()).toEqual([square("Anna, Mon 08:00")]);
  });

  it("Enter or Space opens the conversation on that letter", () => {
    const { onJump } = walked(1);
    fireEvent.keyDown(square("Anna, Tue 10:30"), { key: "Enter" });
    fireEvent.keyDown(square("You, Tue 11:02"), { key: " " });
    expect(onJump.mock.calls.map(([i]) => i)).toEqual([2, 3]);
  });

  it("without names they stay a picture: no control the keyboard stops on", () => {
    render(
      <ReadSquares squares={["seen", "unseen"]} here={0} axis="row" label="2 messages" onJump={() => {}} />,
    );
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
