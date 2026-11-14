/** @vitest-environment jsdom */
/**
 * THE FRAME'S KEY REGISTRY. The frame mounts the one table of bindings and its one listener itself, under its scope,
 * with the zone the keys are in said on the document and the rule that lands the keyboard when a control is taken
 * away. A place declares its keys and needs nothing of a shell. Where a registry already stands above the frame, the
 * frame joins that one: two tables would answer one press twice.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContext, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KeymapContext,
  useKeyBindings,
  useKeymap,
  useKeymapStore,
  type KeymapStore,
} from "@ohmail/app-logic/keys";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ran: string[] = [];
const stores: (KeymapStore | null)[] = [];
let table: string[] = [];

/** A list that declares one key, and whose rows can be taken away while one of their controls has the keys. */
function List(_: PaneProps) {
  const [rows, setRows] = useState(["a", "b", "c"]);
  const store = useContext(KeymapContext);
  if (stores[stores.length - 1] !== store) stores.push(store);
  useKeyBindings([{ chord: "x", group: "message", label: "Pick the message", run: () => ran.push("pick") }]);
  table = useKeymap().bindings.map((b) => `${b.chord}|${b.label}`);
  return (
    <div role="list">
      {rows.map((id) => (
        <div key={id} role="listitem">
          <button type="button" onClick={() => setRows(rows.filter((row) => row !== id))}>
            Done {id}
          </button>
        </div>
      ))}
    </div>
  );
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "columns", List, Reading: () => <p>the letter</p> },
};

function frameOf(scope: string, address: FakeAddress) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope,
    window: fakeWindow("desktop"),
    address,
    places: { ohbox },
  });
  return (
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  );
}
const press = (key: string) => fireEvent.keyDown(document.body, { key });

beforeEach(() => {
  ran.length = 0;
  stores.length = 0;
  table = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the frame's key registry", () => {
  it("takes a place's keys with no registry of a shell above: the key runs, once", () => {
    render(frameOf("acct-1", fakeAddress()));
    expect(table).toEqual(["x|Pick the message"]);
    press("x");
    expect(ran).toEqual(["pick"]);
  });

  it("is mounted again with the scope: the table of one account is not the next one's", () => {
    const address = fakeAddress();
    const view = render(frameOf("acct-1", address));
    view.rerender(frameOf("acct-2", address));
    expect(stores.length).toBe(2);
    expect(stores[0]).not.toBeNull();
    expect(stores[1]).not.toBe(stores[0]);
    press("x");
    expect(ran).toEqual(["pick"]);
  });

  it("says the zone the keys are in on the document while it stands, and takes it back", () => {
    const view = render(frameOf("acct-1", fakeAddress()));
    expect(document.documentElement.getAttribute("data-zone")).toBe("list");
    view.unmount();
    expect(document.documentElement.hasAttribute("data-zone")).toBe(false);
  });

  it("lands the keyboard on the next row when the control that had it is taken away", async () => {
    render(frameOf("acct-1", fakeAddress()));
    const done = screen.getByRole("button", { name: "Done a" });
    act(() => done.focus());
    fireEvent.click(done);
    /* The removal is answered once the document says it happened. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done b" }));
  });

  it("joins a registry that stands above it: one table holds the keys declared beside the frame and inside it", () => {
    function Beside() {
      useKeyBindings(
        [{ chord: "?", group: "app", label: "Keyboard shortcuts", run: () => ran.push("sheet") }],
        "global",
      );
      return null;
    }
    function Shell() {
      return (
        <KeymapContext.Provider value={useKeymapStore()}>
          <Beside />
          {frameOf("acct-1", fakeAddress())}
        </KeymapContext.Provider>
      );
    }
    render(<Shell />);
    expect([...table].sort()).toEqual(["?|Keyboard shortcuts", "x|Pick the message"]);
    press("x");
    press("?");
    expect(ran).toEqual(["pick", "sheet"]);
  });
});
