/** @vitest-environment jsdom */
/**
 * THE MAIL'S OWN KEYS ON THE GROUND (`MailKeys`). From every place `c` writes a new letter and `/` goes to Search,
 * each only where the host hands the place it leads to: a key to a place that is not handed would throw the person
 * to the Ohbox. While a person types, the letters are letters. Undo's `z` is the room's own and is bound once.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeymap } from "@ohmail/app-logic/keys";
import { useModalGate } from "@ohmail/app-logic/session/modal-gate";
import type { FramePlaces, FrameStages, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { calendar } from "../../src/calendar/entry.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import searchEn from "../../messages/search.en.json" with { type: "json" };
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";

let table: string[] = [];
/** The key table's rows as the `?` sheet is drawn from them: chord, label, and whether the binding runs now. */
let rows: string[] = [];
let helpOnly: string[] = [];
/** A wide pane with a field in it, which also says what the key table holds. */
function Pane({ name }: { readonly name: string }) {
  const bindings = useKeymap().bindings;
  table = bindings.map((b) => b.chord);
  helpOnly = bindings.filter((b) => b.helpOnly).map((b) => b.chord);
  rows = bindings.map((b) => `${b.chord}|${b.label}|${b.disabled ? "off" : "on"}`);
  return (
    <div>
      <p>{name}</p>
      <input aria-label={`A field of ${name}`} />
    </div>
  );
}
const wide = (id: PlaceEntry["id"], name: string): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes: { kind: "wide", Wide: () => <Pane name={name} /> },
});
const BASE: Partial<FramePlaces> = { ohbox: wide("ohbox", "the Ohbox"), news: wide("news", "News") };
const ALL: Partial<FramePlaces> = {
  ...BASE,
  search: wide("search", "the search page"),
  write: wide("write", "the writing page"),
};

/** A stage that keeps the keys, as the first run does. */
function Setup() {
  useModalGate(true);
  return <p>setup</p>;
}
const STAGES: FrameStages = { firstRun: { id: "firstRun", Body: Setup } };

function mount(address: FakeAddress, places: Partial<FramePlaces>, withCalendar = false) {
  const { host } = fakeHost({
    engine: fakeMail([letter("m1")]).engine,
    service: "self",
    scope: "acct-1",
    places,
    stages: STAGES,
    ...(withCalendar
      ? {
          products: "both" as const,
          calendar: {
            ...calendar,
            Rail: () => null,
            places: { ...calendar.places, week: wide("week", "the week") },
          },
        }
      : {}),
    above: MailGround,
    address,
  });
  render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
}
const press = (key: string, on: Element = document.body) => fireEvent.keyDown(on, { key });

beforeEach(() => {
  table = [];
  helpOnly = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the mail's own keys on the ground", () => {
  it("c writes a new letter and / goes to Search, from a place that is neither", () => {
    const address = fakeAddress("#/reads");
    mount(address, ALL);
    press("c");
    expect(address.read()).toBe("#/compose");
    expect(screen.getByText("the writing page")).toBeTruthy();
    press("/");
    expect(address.read()).toBe("#/search");
    expect(screen.getByText("the search page")).toBeTruthy();
  });

  it("while a person types in a field, the letters are letters", () => {
    const address = fakeAddress("#/reads");
    mount(address, ALL);
    const field = screen.getByRole("textbox", { name: "A field of News" });
    field.focus();
    press("c", field);
    press("/", field);
    expect(address.read()).toBe("#/reads");
  });

  it("a host that hands no place that writes and no Search binds neither key: the person stays where they are", () => {
    const address = fakeAddress("#/reads");
    mount(address, BASE);
    press("c");
    press("/");
    expect(address.read()).toBe("#/reads");
    expect(address.writes).toEqual([]);
    expect(table).not.toContain("c");
    expect(table).not.toContain("/");
  });

  it("each key is bound once, and Undo's z is the room's own, once", () => {
    mount(fakeAddress("#/reads"), ALL);
    for (const chord of ["c", "/", "z"])
      expect(
        table.filter((bound) => bound === chord),
        chord,
      ).toHaveLength(1);
  });

  it("Send + Done's key stands in the table as the shipped row, once, and rests while no reply is open", () => {
    mount(fakeAddress("#/reads"), ALL);
    expect(rows.filter((row) => row.startsWith("mod+shift+Enter|"))).toEqual([
      `mod+shift+Enter|${searchEn.shortcuts.sendReplyAndDone}|off`,
    ]);
  });

  it("keeps mail shortcuts with Mail as a person switches into and out of Calendar", () => {
    const address = fakeAddress("#/cal/week");
    mount(address, ALL, true);
    expect(screen.getByText("the week")).toBeTruthy();
    press("c");
    expect(address.read()).toBe("#/cal/week");
    expect(rows.filter((row) => row.includes(searchEn.shortcuts.sendReplyAndDone))).toEqual([
      `mod+shift+Enter|${searchEn.shortcuts.sendReplyAndDone}|off`,
    ]);
    expect(helpOnly).toContain("mod+shift+Enter");
    press("g");
    press("m");
    expect(address.read()).toBe("#/ohbox");
    expect(helpOnly).not.toContain("mod+shift+Enter");
    press("c");
    expect(address.read()).toBe("#/compose");
  });

  it("under a stage that keeps the keys, neither key of the app behind runs", () => {
    const address = fakeAddress("#/first-run");
    mount(address, ALL);
    expect(screen.getByText("setup")).toBeTruthy();
    press("c");
    press("/");
    expect(address.read()).toBe("#/first-run");
  });
});
