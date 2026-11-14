/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { postureWindow } from "../../src/host/browser/index.js";
import type { FoldReading } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, movable } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/*
 * A FOLD KEEPS THE OPEN LETTER AND A HALF-WRITTEN REPLY. The phone folded is one column with the letter over the list;
 * unfolded it is a book, two columns; folded again, one. Through all three the reading pane is the same node with the
 * same words in it, and the address still names the letter. (The reader's own reply takes this case over when it
 * lands; this pane stands in for it.)
 */

afterEach(cleanup);

function List() {
  return <p>the list</p>;
}
function Reading({ route }: PaneProps) {
  return (
    <div>
      <p>reading {route.open ?? "nothing"}</p>
      <textarea aria-label="Reply" />
    </div>
  );
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};

const FOLDED: FoldReading = { folds: [], hasFold: true };
const OPEN: FoldReading = {
  folds: [
    { bounds: { x: 375, y: 0, w: 0, h: 800 }, state: "flat", orientation: "vertical", occlusion: "none" },
  ],
  hasFold: true,
};

describe("folding the phone with a letter open", () => {
  it("keeps the letter and the words typed in its reply, folded, unfolded and folded again", () => {
    const win = fakeWindow("phone");
    const fold = movable(FOLDED);
    const address = fakeAddress("#/ohbox/m/a1");
    const { host } = fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      places: { ohbox },
      window: win,
      address,
    });
    render(
      <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }} timeZone="UTC">
        <Frame host={{ ...host, device: { ...host.device, window: postureWindow(win, fold) } }} />
      </TextProvider>,
    );
    const reply = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    fireEvent.change(reply, { target: { value: "Thanks, half a" } });
    const columns = () => document.querySelector(".fr-columns")?.getAttribute("data-columns");
    expect(columns()).toBe("1");

    act(() => {
      win.resize(750, 800);
      fold.set(OPEN);
    });
    expect(columns(), "unfolded, a book: two columns").toBe("2");
    expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);

    act(() => {
      fold.set(FOLDED);
      win.resize(390, 844);
    });
    expect(columns()).toBe("1");
    expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
    expect(reply.value).toBe("Thanks, half a");
    expect(screen.getByText("reading a1")).not.toBeNull();
    expect(address.read()).toBe("#/ohbox/m/a1");
  });
});
