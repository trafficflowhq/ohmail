/** @vitest-environment jsdom */
/**
 * A LETTER OPENED AS ENTERED. A place sends a person to a letter of another place with `commands.go(to, { entered:
 * true })` (a hit a person chose). The place that lists the letter reads that word once from its live record
 * (`args.entered`): its id while the address names it, gone once the place says it took it. Every other way in (a
 * link, a reload, Back, the place's own open) carries no such word: those are previews, and read nothing.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceLiveArgs } from "@ohmail/app-logic/lists";
import { useFrame } from "../../src/frame/commands.js";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { usePlaceLiveArgs } from "../../src/frame/place-live.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const Live = createContext<PlaceLiveArgs | null>(null);
/** The seat of the place that lists the letters: its live record, stood above its columns. */
function Seat({ children }: { children: ReactNode }) {
  return <Live.Provider value={usePlaceLiveArgs()}>{children}</Live.Provider>;
}
function List(_: PaneProps) {
  const args = useContext(Live)!;
  return (
    <div>
      <p>{`open ${args.route.open ?? "nothing"}, entered ${args.entered.letter ?? "nothing"}`}</p>
      <button type="button" onClick={args.entered.taken}>
        Took it
      </button>
      <button type="button" onClick={() => args.commands.open("b2")}>
        Open another
      </button>
    </div>
  );
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "columns", List, Reading: () => <p>the letter</p>, Above: Seat },
};
/** The place a person chooses a hit in. */
function Hits() {
  const { commands } = useFrame();
  return (
    <div>
      <button type="button" onClick={() => commands.go({ place: "ohbox", open: "a1" }, { entered: true })}>
        Open the hit
      </button>
      <button type="button" onClick={() => commands.go({ place: "ohbox", open: "a1" })}>
        Open by its address
      </button>
    </div>
  );
}
const search: PlaceEntry = { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: Hits } };

function Ground({ children }: { children: ReactNode }) {
  return children;
}
function mount(first = "#/search") {
  const address = fakeAddress(first);
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address,
    places: { ohbox, search },
    above: Ground,
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return address;
}
afterEach(cleanup);

describe("a letter opened as entered", () => {
  it("is handed once to the place that lists it, and is gone when the place took it", () => {
    const address = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    expect(address.read()).toBe("#/ohbox/m/a1");
    expect(screen.getByText("open a1, entered a1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Took it" }));
    expect(screen.getByText("open a1, entered nothing")).toBeTruthy();
  });

  it("a way in that says no such word is a preview: the address alone, a reload, Back", () => {
    const address = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open by its address" }));
    expect(screen.getByText("open a1, entered nothing")).toBeTruthy();
    cleanup();
    /* A reload at the letter's address: the word was never in the address. */
    mount("#/ohbox/m/a1");
    expect(screen.getByText("open a1, entered nothing")).toBeTruthy();
    void address;
  });

  it("names that letter alone: another letter opened in the place, or the address moved back onto it, enters nothing", () => {
    const address = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    expect(screen.getByText("open a1, entered a1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open another" }));
    expect(screen.getByText("open b2, entered nothing")).toBeTruthy();
    /* Back onto the hit's letter: the place's own open spent the word. */
    act(() => address.visit("#/ohbox/m/a1"));
    expect(screen.getByText("open a1, entered nothing")).toBeTruthy();
  });
});
