/** @vitest-environment jsdom */
/**
 * A LETTER OVER THE LIST ON A PHONE IS A DIALOG (the switch's point 67; by RULING-JOIN J-1 what the act does is
 * today's). At one column the open letter covers the list it stands over; today's narrow sheet claimed `aria-modal`, so
 * a screen reader's walk stayed inside the letter instead of reading on into the hidden rows under it. At two columns
 * and wider the letter stands beside the list and is the region it is.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List(_: PaneProps) {
  return <p>the list</p>;
}
function Reading(_: PaneProps) {
  return <p>the letter</p>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "columns", List, Reading },
};

function mount(room: keyof typeof ROOMS, first: string): void {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow(room),
    address: fakeAddress(first),
    places: { ohbox },
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
}
/** The reading column's name, as the frame says it. */
const READING = "Reading";

afterEach(cleanup);

describe("the open letter's claim, by width", () => {
  it("on one column the letter over the list is a modal dialog, named as the reading column", () => {
    mount("phone", "#/ohbox/m/a1");
    const letter = screen.getByRole("dialog", { name: READING });
    expect(letter.getAttribute("aria-modal")).toBe("true");
    expect(letter.textContent).toContain("the letter");
  });

  it("at two columns the letter beside the list is the region it is, and no dialog", () => {
    mount("desktop", "#/ohbox/m/a1");
    expect(screen.queryByRole("dialog")).toBeNull();
    const region = screen.getByRole("region", { name: READING });
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(region.textContent).toContain("the letter");
  });
});
