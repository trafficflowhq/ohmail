/** @vitest-environment jsdom */
/**
 * A PLACE THAT THROWS WHILE IT DRAWS TAKES ONLY ITS PANE (the frame's boundary): the card stands in the pane with
 * today's sentences and the way to the Ohbox, the throw is reported, the rail still goes elsewhere, and coming back to
 * a place that failed draws it again. A list that throws beside its reading column takes the list alone.
 */
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrame } from "../../src/frame/commands.js";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry, PlaceRail } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };

const broken = { history: true, list: true };
function Ohbox() {
  return <p>the Ohbox drawn</p>;
}
function AddressPane() {
  throw new TypeError("a stored row missing a field");
}
function History() {
  if (broken.history) throw new TypeError("a stored row missing a field");
  return <p>History drawn</p>;
}
function TagsList() {
  if (broken.list) throw new RangeError("Maximum update depth exceeded");
  return <p>the tag's list drawn</p>;
}
function TagReading() {
  const { commands } = useFrame();
  return (
    <div>
      <p>the tag's reading column</p>
      <button type="button" onClick={() => commands.go({ place: "tags", sub: "home" })}>
        Another tag
      </button>
    </div>
  );
}
const rail = (group: PlaceRail["group"]): PlaceRail => ({ group, icon: "ohbox", label: "title" });
const wide = (id: PlaceEntry["id"], Wide: (p: PaneProps) => ReactNode, r: PlaceRail | null): PlaceEntry => ({
  id,
  body: id,
  rail: r,
  panes: { kind: "wide", Wide },
});
const PLACES = {
  ohbox: wide("ohbox", Ohbox, rail("main")),
  history: wide("history", History, rail("more")),
  address: wide("address", AddressPane, rail("main")),
  tags: {
    id: "tags",
    body: "tags",
    rail: null,
    panes: { kind: "columns", List: TagsList, Reading: TagReading, holds: "always" },
  } as PlaceEntry,
};
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), title: "Ohbox" },
  history: { title: "History" },
  viewError: frameEn.viewError,
};
const VIEW: Record<string, string> = frameEn.viewError;

function mount(at: string) {
  const address = fakeAddress(at);
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
  return address;
}
const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const card = (): HTMLElement | null => screen.queryByRole("region", { name: VIEW.title });

let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  broken.history = true;
  broken.list = true;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
  warns.mockRestore();
});

describe("a place that throws while it draws", () => {
  it("draws the card in its pane, reports the throw, and the rail still goes elsewhere", async () => {
    mount("#/history");
    await tick();
    expect(card(), "the card in the failed pane").not.toBeNull();
    expect(within(card()!).getByText(VIEW.body)).toBeTruthy();
    expect(
      errors.mock.calls.some((c: unknown[]) => c[0] === "[view] render failed" && c[1] === "history"),
      "the throw is reported as today's was",
    ).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Ohbox" }).find((b) => !card()!.contains(b))!);
    await tick();
    expect(screen.getByText("the Ohbox drawn")).toBeTruthy();
    expect(card()).toBeNull();
  });

  it("the report names only the place and the kind: no route part, exception, stack or address rides it", async () => {
    mount("#/address/someone@example.test");
    await tick();
    expect(card(), "the card in the failed address pane").not.toBeNull();
    const lines = errors.mock.calls.filter((c: unknown[]) => c[0] === "[view] render failed");
    expect(lines.length, "the throw is reported").toBeGreaterThan(0);
    for (const line of lines) {
      expect(line[1], "the place name, not the route key").toBe("address");
      expect(line[2], "the safe error kind").toBe("TypeError");
      expect(line.length, "nothing else rides the line").toBe(3);
    }
    const spoken = [...errors.mock.calls, ...warns.mock.calls]
      .filter((c: unknown[]) => c[0] === "[view] render failed")
      .map((c: unknown[]) => c.map(String).join(" "))
      .join(" ");
    expect(spoken, "no correspondent's address in the log").not.toContain("someone@example.test");
    expect(spoken, "no route subpart in the log").not.toContain("address/someone");
    expect(spoken, "no stack in the log").not.toContain("at ");
  });

  it("the card's way to the Ohbox goes there", async () => {
    mount("#/history");
    await tick();
    fireEvent.click(within(card()!).getByRole("button", { name: "Ohbox" }));
    await tick();
    expect(screen.getByText("the Ohbox drawn")).toBeTruthy();
  });

  it("a move to another place clears the failed pane: back at the place mended, it draws", async () => {
    const address = mount("#/history");
    await tick();
    expect(card()).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Ohbox" }).find((b) => !card()!.contains(b))!);
    await tick();
    broken.history = false;
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await tick();
    expect(screen.getByText("History drawn")).toBeTruthy();
    expect(address.writes.length).toBeGreaterThan(0);
  });

  it("a list that throws takes its pane alone: the reading column beside it still stands", async () => {
    mount("#/tag/work");
    await tick();
    expect(card(), "the card in the list's pane").not.toBeNull();
    expect(screen.getByText("the tag's reading column")).toBeTruthy();
  });

  it("a move to another part of the same place clears the failed pane, which stays mounted where it is", async () => {
    mount("#/tag/work");
    await tick();
    expect(card()).not.toBeNull();
    broken.list = false;
    fireEvent.click(screen.getByRole("button", { name: "Another tag" }));
    await tick();
    expect(card()).toBeNull();
    expect(screen.getByText("the tag's list drawn")).toBeTruthy();
  });
});
