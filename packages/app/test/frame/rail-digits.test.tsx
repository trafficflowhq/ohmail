/** @vitest-environment jsdom */
/**
 * THE DIGITS (the switch's point 62, by RULING-JOIN J-1): `1` to `7` go to the places the rail lists first, in the
 * order it draws them, as today's shell bound them: always, outside a text field, whatever is open and wherever the
 * keys are, at every width. Only the places a person flicks between are numbered (the Ohbox, the streams, the
 * Screener, the three piles): Settings, Search, History and the tags have keys of their own. The frame binds them;
 * no place does. The key sheet lists each under Navigate with the sentence its `g` chord has, so the two fold into
 * one row. The digit is drawn always and SHOWN by the rail's sheet only while the keys are in the rail.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeymap } from "@ohmail/app-logic/keys";
import { Frame } from "../../src/frame/Frame.js";
import type { FramePlaces, PaneProps, PlaceEntry, PlaceRail } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function Wide({ route }: PaneProps) {
  return (
    <div>
      <p>at {route.place}</p>
      {route.open ? <p>letter {route.open}</p> : null}
      <input aria-label="A field" />
    </div>
  );
}
const place = (id: PlaceEntry["id"], rail: PlaceRail): PlaceEntry => ({
  id,
  body: id,
  rail,
  panes: { kind: "wide", Wide },
});
const entry = (group: PlaceRail["group"], more: Partial<PlaceRail> = {}): PlaceRail => ({
  group,
  icon: "ohbox",
  label: "title",
  ...more,
});

/* Named against the rail's order on purpose: the numbers are the rail's, never the record's. */
const ALL: Partial<FramePlaces> = {
  settings: place("settings", entry("more", { keyHint: "g ,", keyLabel: "goSettings" })),
  history: place("history", entry("more", { keyHint: "g h" })),
  resurface: place("resurface", entry("later", { keyHint: "g b", keyLabel: "goResurface" })),
  parked: place("parked", entry("later", { keyHint: "g p", keyLabel: "goParked" })),
  later: place("later", entry("later", { keyHint: "g l", keyLabel: "goLater" })),
  screener: place("screener", entry("main", { keyHint: "g s", keyLabel: "goScreener" })),
  receipts: place("receipts", entry("main", { keyHint: "g e", keyLabel: "goReceipts" })),
  news: place("news", entry("main", { keyHint: "g r", keyLabel: "goReads" })),
  ohbox: place("ohbox", entry("main", { keyHint: "g o", keyLabel: "goOhbox" })),
};
const title = (name: string) => ({ title: name });
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), ...title("Ohbox") },
  screener: { ...(FRAME_WORDS.en.screener as object), ...title("Screener") },
  news: title("News"),
  receipts: title("Receipts"),
  later: title("Answer Later"),
  parked: title("Parked"),
  resurface: title("Resurface"),
  history: title("History"),
  settings: title("Settings"),
};

let table: string[] = [];
function Above({ children }: { children: ReactNode }) {
  table = useKeymap().bindings.map((b) => `${b.chord}|${b.group}|${b.label}`);
  return <>{children}</>;
}

function mount(places: Partial<FramePlaces> = ALL, more: Partial<FakeHostInput> = {}) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/ohbox/m/a1"),
    places,
    above: Above,
    ...more,
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return made;
}
const rail = () => screen.getByRole("navigation", { name: "Places" });
const named = (name: string) => within(rail()).getByRole("button", { name: new RegExp(`^${name}`) });
const press = (key: string, on: Element = document.body, more: { repeat?: boolean } = {}) =>
  fireEvent.keyDown(on, { key, ...more });

beforeEach(() => {
  table = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the digits go to the rail's places", () => {
  it("with a letter open and the keys in the list, 2 goes to the rail's second place", () => {
    const { address } = mount();
    expect(screen.getByText("letter a1")).toBeTruthy();
    press("2");
    expect(address.read()).toBe("#/reads");
    press("4");
    expect(address.read()).toBe("#/screener");
    press("7");
    expect(address.read()).toBe("#/triage/resurface");
    press("1");
    expect(address.read()).toBe("#/ohbox");
  });

  it("numbers the places the rail draws first, whatever is mounted, and never Settings or History", () => {
    const { news: _news, receipts: _receipts, ...some } = ALL;
    const { address } = mount(some);
    press("2");
    expect(address.read()).toBe("#/screener");
    press("6");
    expect(address.read()).toBe("#/screener");
    press("5");
    expect(address.read()).toBe("#/triage/resurface");
  });

  it("goes at a phone's width too, while the keys are nowhere near the rail", () => {
    const { address } = mount(ALL, { window: fakeWindow("phone") });
    press("3");
    expect(address.read()).toBe("#/receipts");
  });

  it("types in a field and does nothing; a held digit goes once", () => {
    const { address } = mount();
    press("2", screen.getByRole("textbox", { name: "A field" }));
    expect(address.read()).toBe("#/ohbox/m/a1");
    press("3", document.body, { repeat: true });
    expect(address.read()).toBe("#/ohbox/m/a1");
  });

  it("lists each digit under Navigate with the sentence of the same place's `g` chord", () => {
    mount();
    const digits = table.filter((row) => /^[0-9]\|/.test(row)).sort();
    expect(digits).toEqual([
      "1|navigate|Go to the Ohbox",
      "2|navigate|Go to News",
      "3|navigate|Go to Receipts",
      "4|navigate|Go to the Screener",
      "5|navigate|Go to Answer Later",
      "6|navigate|Go to Parked",
      "7|navigate|Go to Resurface",
    ]);
  });

  it("draws the digit on its entry always and says it as a key that goes there; the sheet shows it only while the keys are in the rail", () => {
    mount();
    const shortcutOf = (name: string) => named(name).getAttribute("aria-keyshortcuts") ?? "";
    /* Shown only while the keys are within the rail: the rail's sheet (the switch's point 65), laid out in Chromium by
       rail-digits-in-a-browser. Drawn and said whatever has the keys: */
    expect(within(named("News")).getByText("2")).toBeTruthy();
    expect(shortcutOf("Screener").split(" ")).toContain("4");
    act(() => named("Ohbox").focus());
    expect(within(named("News")).getByText("2")).toBeTruthy();
    expect(shortcutOf("Settings").split(" ")).not.toContain("8");
    expect(within(named("Settings")).queryByText("8")).toBeNull();
  });
});
