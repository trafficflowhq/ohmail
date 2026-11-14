/** @vitest-environment jsdom */
/**
 * THE OPEN LETTER, KEPT OVER A WALK AWAY AND BACK. A place of two columns may say `keepsOpen`: the frame then
 * remembers the letter that was open there and opens it again when a person comes back by a way that names none (the
 * rail, a key, a command), at two columns only. Closing the letter forgets it, whichever way it was closed; a place
 * that does not say so opens none; the memory is the frame's own, for its life and its scope, and is stored nowhere.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame } from "../../src/frame/commands.js";
import type { FrameCommands, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress, type FakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List({ route }: PaneProps) {
  const { commands } = useFrame();
  return (
    <div>
      <p>the list of {route.place}</p>
      <button type="button" onClick={() => commands.open("a1")}>
        Open a1
      </button>
      <button type="button" onClick={() => commands.open(null)}>
        Close
      </button>
    </div>
  );
}
function Reading({ route }: PaneProps) {
  return <p>reading {route.open ?? "nothing"}</p>;
}
const columns = (id: PlaceEntry["id"], keepsOpen: boolean): PlaceEntry => ({
  id,
  body: id,
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: keepsOpen ? { kind: "columns", List, Reading, keepsOpen: true } : { kind: "columns", List, Reading },
});
const PLACES = { ohbox: columns("ohbox", true), news: columns("news", false), tags: columns("tags", true) };
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), title: "Ohbox" },
  news: { title: "News" },
  tags: { title: "Tags" },
};

/** The frame's commands, as a part above the panes holds them: a walk that names no letter. */
let commands: FrameCommands;
function Above({ children }: { children: ReactNode }) {
  commands = useFrame().commands;
  return children;
}

function frameOf(scope: string, address: FakeAddress, window: FakeWindow) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope,
    window,
    address,
    places: PLACES,
    above: Above,
  });
  return (
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  );
}
function mount(at = "#/ohbox", room: "desktop" | "phone" = "desktop") {
  const address = fakeAddress(at);
  const window = fakeWindow(room);
  const view = render(frameOf("acct-1", address, window));
  return { address, window, view };
}
const rail = (name: string) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name }));
const go = (to: Parameters<FrameCommands["go"]>[0]) => act(() => commands.go(to));

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("a place that keeps its open letter", () => {
  it("at two columns opens it again after a walk to another place and back by the rail, and the address names it", () => {
    const { address } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    rail("News");
    expect(screen.getByText("the list of news")).toBeTruthy();
    rail("Ohbox");
    expect(address.read()).toBe("#/ohbox/m/a1");
    expect(screen.getByText("reading a1")).toBeTruthy();
    /* Three walks, three writes: the frame wrote the address once for each, and never to mend one. */
    expect(address.writes).toEqual([
      { next: "#/ohbox/m/a1", how: "push" },
      { next: "#/reads", how: "push" },
      { next: "#/ohbox/m/a1", how: "push" },
    ]);
  });

  it("keeps a letter by the place's own word: one open under a tag is opened under that tag alone", () => {
    const { address } = mount("#/tag/t1/m/a1");
    go({ place: "news" });
    go({ place: "tags", sub: "t2" });
    expect(address.read()).toBe("#/tag/t2");
    go({ place: "tags", sub: "t1" });
    expect(address.read()).toBe("#/tag/t1/m/a1");
  });

  it("forgets a letter that was closed", () => {
    const { address } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rail("News");
    rail("Ohbox");
    expect(address.read()).toBe("#/ohbox");
    expect(screen.getByText("reading nothing")).toBeTruthy();
  });

  it("Back walks out of the letter: the frame does not open it again, then or on the way back", () => {
    const { address } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    act(() => address.visit("#/ohbox"));
    expect(screen.getByText("reading nothing")).toBeTruthy();
    expect(address.writes).toEqual([{ next: "#/ohbox/m/a1", how: "push" }]);
    rail("News");
    rail("Ohbox");
    expect(address.read()).toBe("#/ohbox");
  });

  it("on one column comes back to the list alone", () => {
    const { address } = mount("#/ohbox", "phone");
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    go({ place: "news" });
    go({ place: "ohbox" });
    expect(address.read()).toBe("#/ohbox");
  });

  it("obeys a way back that names its letter, or says none", () => {
    const { address } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    go({ place: "news" });
    go({ place: "ohbox", open: "b2" });
    expect(address.read()).toBe("#/ohbox/m/b2");
    go({ place: "news" });
    go({ place: "ohbox", open: null });
    expect(address.read()).toBe("#/ohbox");
  });

  it("a place that does not say so comes back with none", () => {
    const { address } = mount("#/reads/m/n1");
    expect(screen.getByText("reading n1")).toBeTruthy();
    rail("Ohbox");
    rail("News");
    expect(address.read()).toBe("#/reads");
  });

  it("a reload stands on the address: the letter it names is open, with nothing remembered", () => {
    mount("#/ohbox/m/a1");
    expect(screen.getByText("reading a1")).toBeTruthy();
  });

  it("carries nothing into another scope", () => {
    const { address, window, view } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a1" }));
    rail("News");
    view.rerender(frameOf("acct-2", address, window));
    rail("Ohbox");
    expect(address.read()).toBe("#/ohbox");
    expect(screen.getByText("reading nothing")).toBeTruthy();
  });
});
