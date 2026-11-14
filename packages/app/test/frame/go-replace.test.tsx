/** @vitest-environment jsdom */
/**
 * `commands.go(to, { replace: true })` (the switch's point 63 (b)): the address is REPLACED, not pushed, so Back does
 * not come back to the replaced address (today's shell replaced a dead tag's or folder's address with the Ohbox's, in
 * place). A plain `go` still pushes. Over the browser's own fragment and history, as a browser host hands them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFrame } from "../../src/frame/commands.js";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry, PlaceRail } from "../../src/frame/contract.js";
import { fragmentAddress } from "../../src/host/browser/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function Wide({ route }: PaneProps) {
  const { commands } = useFrame();
  return (
    <div>
      <p>at {route.sub === null ? route.place : `${route.place} ${route.sub}`}</p>
      <button type="button" onClick={() => commands.go({ place: "tags", sub: "gone" })}>
        To a tag
      </button>
      <button type="button" onClick={() => commands.go({ place: "ohbox" }, { replace: true })}>
        Home in place
      </button>
      <button type="button" onClick={() => commands.go({ place: "ohbox" })}>
        Home
      </button>
    </div>
  );
}
const rail = (group: PlaceRail["group"]): PlaceRail => ({ group, icon: "ohbox", label: "title" });
const place = (id: PlaceEntry["id"], r: PlaceRail | null): PlaceEntry => ({
  id,
  body: id,
  rail: r,
  panes: { kind: "wide", Wide },
});
const PLACES = {
  ohbox: place("ohbox", rail("main")),
  history: place("history", rail("more")),
  tags: place("tags", null),
};
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), title: "Ohbox" },
  history: { title: "History" },
};

/** The browser's own fragment and history, in the shape the test host takes. */
function browserFragment(): FakeAddress {
  return {
    ...fragmentAddress(window),
    writes: [],
    visit: (f: string) => (window.location.hash = f),
  } as FakeAddress;
}
function mount(address: FakeAddress) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address,
    places: PLACES,
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
}
const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const back = async (): Promise<void> => {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 50));
  });
};
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "#/history");
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#");
});

describe("go with replace", () => {
  it("corrects an unknown address without adding a Back step", async () => {
    mount(browserFragment());
    const before = window.history.length;
    window.location.hash = "#/bogus";
    await waitFor(() => expect(window.location.hash).toBe("#/ohbox"));
    expect(screen.getByText("at ohbox")).toBeTruthy();
    expect(window.history.length).toBe(before + 1);
    await back();
    expect(window.location.hash).toBe("#/history");
    expect(screen.getByText("at history")).toBeTruthy();
  });

  it("replaces the address in place: Back does not come back to the address it replaced", async () => {
    mount(browserFragment());
    press("To a tag");
    await tick();
    expect(window.location.hash).toBe("#/tag/gone");
    press("Home in place");
    await tick();
    expect(window.location.hash).toBe("#/ohbox");
    await back();
    expect(window.location.hash).toBe("#/history");
  });

  it("CONTROL: a plain go pushes, and Back comes back to where it was", async () => {
    mount(browserFragment());
    press("To a tag");
    await tick();
    press("Home");
    await tick();
    expect(window.location.hash).toBe("#/ohbox");
    await back();
    expect(window.location.hash).toBe("#/tag/gone");
  });

  it("writes the address once, as a replace, and nothing else of the way there changes", () => {
    const address = fakeAddress("#/tag/gone");
    mount(address);
    press("Home in place");
    expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
    press("To a tag");
    expect(address.writes.at(-1)).toEqual({ next: "#/tag/gone", how: "push" });
  });
});
