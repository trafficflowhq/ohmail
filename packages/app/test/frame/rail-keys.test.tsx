/** @vitest-environment jsdom */
/**
 * THE RAIL AND THE KEYS. The zone walk (`h` and ← toward the rail, Escape back) reads where the frame's rail stands.
 * Where the rail stands at the side, `h` from the list puts the keys on the rail's entry for the place on screen.
 * Where it does not, `h` puts the whole rail up over the app. A rail put up and left up while the window was
 * widened is taken down by Escape, and the keys leave the rail with it: on the list's row, never on the page.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useZoneNav } from "@ohmail/app-logic/keys";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** A list whose row is where the walk back to the list lands, as a place's list says it. */
function List(_: PaneProps) {
  useZoneNav((key) => key, { listFocusSelector: "[data-the-row]" });
  return (
    <button type="button" data-the-row="" aria-label="The row">
      the row
    </button>
  );
}
function Reading(_: PaneProps) {
  return <p>the letter</p>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};

function mount(window: FakeWindow) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window,
    address: fakeAddress("#/ohbox"),
    places: { ohbox },
  });
  render(
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
      timeZone="Europe/Zurich"
    >
      <Frame host={host} />
    </TextProvider>,
  );
}
const theRow = () => screen.getByRole("button", { name: "The row" });
const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key });
const sheet = () => screen.queryByRole("dialog", { name: "More" });
const tick = () => act(async () => new Promise((done) => setTimeout(done, 40)));

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the rail and the keys", () => {
  it("where the rail stands at the side, h from the list puts the keys on its entry for the place on screen", async () => {
    mount(fakeWindow("desktop"));
    act(() => theRow().focus());
    press("h");
    await tick();
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(rail.contains(document.activeElement), "the keys are in the rail").toBe(true);
    expect(document.activeElement?.getAttribute("aria-current"), "on the entry of the place on screen").toBe(
      "page",
    );
    expect(sheet(), "nothing was put up over the app").toBeNull();
  });

  it("where no rail stands at the side, h from the list puts the whole rail up over the app", async () => {
    mount(fakeWindow("fold"));
    act(() => theRow().focus());
    press("h");
    await tick();
    expect(sheet(), "the whole rail stands over the app").not.toBeNull();
  });

  it("a rail put up, the window widened: Escape in the rail takes it down and the keys go to the list's row", async () => {
    const window = fakeWindow("fold");
    mount(window);
    act(() => theRow().focus());
    press("h");
    await tick();
    expect(sheet()).not.toBeNull();
    act(() => window.resize(1440, 900, "fine"));
    await tick();
    expect(sheet(), "the rail stands at the side once the window is wide").toBeNull();
    act(() => theRow().focus());
    press("h");
    await tick();
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(rail.contains(document.activeElement), "h walked into the rail").toBe(true);
    press("Escape");
    await tick();
    expect(document.activeElement, "the keys are on the list's row").toBe(theRow());
  });
});
