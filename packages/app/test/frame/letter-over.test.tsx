/** @vitest-environment jsdom */
/**
 * THE LETTER OVER THE LIST. Where one column stands, a letter that is open stands over its list: the innermost open
 * thing of the place. Escape closes it by taking the letter out of the address, as the reading column's way back
 * does, before any key of the place below it. Where two columns stand the letter is beside the list and Escape is
 * not the frame's.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyBindings, useKeymap } from "@ohmail/app-logic/keys";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ran: string[] = [];
let table: string[] = [];

/** A list with a key of its own on Escape, as a list with rows picked has. */
function List(_: PaneProps) {
  useKeyBindings([
    { chord: "Escape", group: "message", label: "Clear the selection", run: () => ran.push("cleared") },
  ]);
  table = useKeymap()
    .bindings.filter((b) => !b.disabled)
    .map((b) => `${b.chord}|${b.label}`);
  return <p>the list</p>;
}
function Reading(_: PaneProps) {
  return <input aria-label="A field of the letter" />;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "columns", List, Reading },
};
/** A place of one wide pane: nothing of it stands over a list. */
const settings: PlaceEntry = {
  id: "settings",
  body: "settings",
  rail: null,
  panes: { kind: "wide", Wide: List },
};

function mount(room: keyof typeof ROOMS, first: string) {
  const address = fakeAddress(first);
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow(room),
    address,
    places: { ohbox, settings },
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return address;
}
const escape = (on: Element = document.body) => fireEvent.keyDown(on, { key: "Escape" });

beforeEach(() => {
  ran.length = 0;
});
afterEach(cleanup);

describe("the letter over the list", () => {
  it("on one column Escape takes the open letter out of the address, before the list's own Escape", () => {
    const address = mount("phone", "#/ohbox/m/a1");
    escape();
    expect(address.read(), "the letter left the address").toBe("#/ohbox");
    expect(ran, "the list's own Escape did not run for that press").toEqual([]);
    escape();
    expect(ran, "the next press is the list's").toEqual(["cleared"]);
  });

  it("closes it from inside a field of the letter too", () => {
    const address = mount("phone", "#/ohbox/m/a1");
    const field = screen.getByRole("textbox", { name: "A field of the letter" });
    field.focus();
    escape(field);
    expect(address.read()).toBe("#/ohbox");
  });

  it("is listed among the keys only while a letter stands over the list", () => {
    mount("phone", "#/ohbox/m/a1");
    expect(table).toContain("Escape|Close what is open");
    cleanup();
    mount("phone", "#/ohbox");
    expect(table).not.toContain("Escape|Close what is open");
  });

  it("where two columns stand the letter is beside the list: Escape is the place's own and the letter stays", () => {
    const address = mount("desktop", "#/ohbox/m/a1");
    escape();
    expect(address.read(), "the letter stays in the address").toBe("#/ohbox/m/a1");
    expect(ran).toEqual(["cleared"]);
  });

  it("a place of one wide pane has no letter over a list, whatever its address names", () => {
    const address = mount("phone", "#/settings/m/a1");
    escape();
    expect(address.read()).toBe("#/settings/m/a1");
    expect(ran).toEqual(["cleared"]);
  });
});
