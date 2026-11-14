/** @vitest-environment jsdom */
/**
 * THE RAIL FROM THE REGISTRATIONS. With nothing of a shell fed, the frame draws the rail from what the host's places
 * register: their groups in the rail's own order and each place where the rail has it, a group a place draws itself
 * (the tags under their line), a key that stands at rest, and `g` with one more key bound to each place that prints them. The foot (who is
 * signed in, Pull new mail, the quiet tools) is no place's: it is fed apart, and the places stay the registrations'.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyBindings, useKeymap } from "@ohmail/app-logic/keys";
import { setComposeDoor } from "@ohmail/app-logic/writing/compose-door";
import { RailEntry } from "@ohmail/ui/mail";
import { Frame } from "../../src/frame/Frame.js";
import { placeChords } from "../../src/frame/chords.js";
import { useFrame, useRailFoot } from "../../src/frame/commands.js";
import {
  PLACE_IDS,
  type FramePlaces,
  type PaneProps,
  type PlaceEntry,
  type PlaceRail,
  type RailFootModel,
} from "../../src/frame/contract.js";
import { NONE } from "../../src/host/index.js";
import { mailPlaces } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE, NO_PLACES, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function Wide({ route }: PaneProps) {
  return (
    <div>
      <p>at {route.place}</p>
      <input aria-label="A field" />
    </div>
  );
}
const place = (
  id: PlaceEntry["id"],
  rail: PlaceEntry["rail"],
  railGroup?: PlaceEntry["railGroup"],
): PlaceEntry => ({
  id,
  body: id,
  rail,
  ...(railGroup ? { railGroup } : {}),
  panes: { kind: "wide", Wide },
});
const entry = (group: PlaceRail["group"], more: Partial<PlaceRail> = {}): PlaceRail => ({
  group,
  icon: "ohbox",
  label: "title",
  ...more,
});

/** The group the tags draw themselves: their line, and each tag under it. */
function TagsBody() {
  const { route, commands } = useFrame();
  const [open, setOpen] = useState(true);
  return (
    <>
      <RailEntry kind="fold" expanded={open} onPress={() => setOpen(!open)}>
        Tags
      </RailEntry>
      {open ? (
        <RailEntry
          kind="sub"
          hue={78}
          current={route.place === "tags" && route.sub === "pottery"}
          onPress={() => commands.go({ place: "tags", sub: "pottery" })}
        >
          Pottery
        </RailEntry>
      ) : null}
    </>
  );
}

/* Registered against the rail's order on purpose: the order drawn is the rail's, never the record's. */
const PLACES: Partial<FramePlaces> = {
  settings: place("settings", entry("more", { keyHint: "g ,", keyLabel: "goSettings" })),
  drafts: place("drafts", entry("more", { keyHint: "g d", keyLabel: "goDrafts" })),
  search: place("search", entry("more", { keyHint: "/", keyStands: true })),
  history: place("history", entry("more", { keyHint: "g h" })),
  tags: place("tags", null, { group: "tags", Body: TagsBody }),
  later: place("later", entry("later", { keyHint: "g l", keyLabel: "goLater" })),
  screener: place("screener", entry("screener", { keyHint: "g s", keyLabel: "goScreener" })),
  news: place("news", entry("main", { keyHint: "g r", keyLabel: "goReads" })),
  ohbox: place("ohbox", entry("main", { keyHint: "g o", keyLabel: "goOhbox" })),
};
const title = (name: string) => ({ title: name });
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), ...title("Ohbox") },
  screener: { ...(FRAME_WORDS.en.screener as object), ...title("Screener") },
  news: title("News"),
  later: title("Answer Later"),
  history: title("History"),
  search: title("Search"),
  drafts: title("Drafts"),
  settings: title("Settings"),
};

const FOOT: RailFootModel = {
  account: {
    name: "Mila Brunner",
    address: "mila@lichtgrat.example",
    note: "2 mailboxes",
    title: "Mailboxes",
    onPress: () => undefined,
  },
  pull: { label: "Pull new mail", busy: false, onPress: () => undefined },
  tools: [{ icon: "command", label: "Command palette · Ctrl K" }],
};

/** What stands above the panes in a case: the foot's feeder, a key somebody bound, a reader of the key table. */
let table: string[] = [];
const fed = { set: (_: RailFootModel | null): void => undefined };
const bound = { set: (_: boolean): void => undefined };
function Above({ children }: { children: ReactNode }) {
  const [foot, setFoot] = useState<RailFootModel | null>(null);
  const [slash, setSlash] = useState(false);
  fed.set = setFoot;
  bound.set = setSlash;
  return (
    <>
      <Foot foot={foot} />
      {slash ? <Slash /> : null}
      <Table />
      {children}
    </>
  );
}
function Foot({ foot }: { foot: RailFootModel | null }) {
  useRailFoot(foot);
  return null;
}
function Slash() {
  useKeyBindings([{ chord: "/", group: "navigate", label: "Search", run: () => undefined }], "global");
  return null;
}
function Table() {
  table = useKeymap().bindings.map((b) => `${b.chord}|${b.group}|${b.label}`);
  return null;
}

function mount(more: Partial<FakeHostInput> = {}) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/ohbox"),
    places: PLACES,
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
/** An entry by the name it starts with: a key that stands at rest is part of what it says. */
const named = (name: string, box: HTMLElement = rail()) =>
  within(box).getByRole("button", { name: new RegExp(`^${name}`) });
const absent = (name: string, box: HTMLElement = rail()) =>
  within(box).queryByRole("button", { name: new RegExp(`^${name}`) }) === null;
/** The groups as they are drawn: the entries that share one box under the box that holds every place. */
function groups(): string[][] {
  const drawn = [
    "Ohbox",
    "News",
    "Screener",
    "Answer Later",
    "Tags",
    "Pottery",
    "History",
    "Search",
    "Drafts",
    "Settings",
  ].map((name) => ({ name, at: named(name) }));
  const holds = (box: Element) => drawn.every((e) => box.contains(e.at));
  let all: Element = drawn[0]!.at;
  while (!holds(all)) all = all.parentElement!;
  return [...all.children]
    .map((group) => drawn.filter((e) => group.contains(e.at)).map((e) => e.name))
    .filter((group) => group.length > 0);
}
const press = (key: string, on: Element = document.body) => fireEvent.keyDown(on, { key });

beforeEach(() => {
  table = [];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the rail from the registrations", () => {
  it("draws the groups in the rail's own order, each place where the rail has it, the Screener in a group of its own, and the group a place draws itself", () => {
    mount();
    expect(groups()).toEqual([
      ["Ohbox", "News"],
      ["Screener"],
      ["Answer Later"],
      ["Tags", "Pottery"],
      ["History", "Search", "Drafts", "Settings"],
    ]);
  });

  it("a group a place draws itself is the place's own: it folds, it leads to its place, and it stands behind More, never in the dock", () => {
    const { address, window } = mount();
    fireEvent.click(named("Pottery"));
    expect(address.read()).toBe("#/tag/pottery");
    expect(named("Pottery").getAttribute("aria-current")).toBe("page");
    fireEvent.click(named("Tags"));
    expect(absent("Pottery")).toBe(true);

    act(() => window.resize(390, 844, "coarse"));
    const dock = rail();
    expect(absent("Tags", dock)).toBe(true);
    fireEvent.click(named("More", dock));
    expect(named("Tags", screen.getByRole("dialog", { name: "More" }))).toBeTruthy();
  });

  it("the foot is fed apart from the places: the account, Pull new mail and the tools, under the registered places", () => {
    mount();
    expect(absent("Mila Brunner")).toBe(true);
    act(() => fed.set(FOOT));
    expect(named("Mila Brunner").textContent).toContain("2 mailboxes");
    expect(named("Pull new mail")).toBeTruthy();
    expect(named("Command palette · Ctrl K")).toBeTruthy();
    /* Still the registrations' rail: the places are theirs, and so is the landmark's name. */
    expect(groups()[0]).toEqual(["Ohbox", "News"]);
    act(() => fed.set(null));
    expect(absent("Mila Brunner")).toBe(true);
    expect(absent("Pull new mail")).toBe(true);
  });

  it("a key that stands at rest is drawn on its entry, and said to a screen reader only while something binds it", () => {
    mount();
    const search = () => named("Search");
    expect(within(search()).getByText("/")).toBeTruthy();
    expect(within(named("History")).queryByText("g h")).toBeNull();
    expect(search().hasAttribute("aria-keyshortcuts")).toBe(false);
    act(() => bound.set(true));
    expect(search().getAttribute("aria-keyshortcuts")).toBe("/");
    act(() => bound.set(false));
    expect(search().hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("binds `g` and one more key to each place that prints them, and leaves a field's typing alone", () => {
    const { address } = mount();
    press("g");
    press("s");
    expect(address.read()).toBe("#/screener");
    press("g");
    press("r");
    expect(address.read()).toBe("#/reads");
    press("g");
    press(",");
    expect(address.read()).toBe("#/settings");
    press("g");
    press("h");
    expect(address.read()).toBe("#/history");
    const field = screen.getByRole("textbox", { name: "A field" });
    press("g", field);
    press("o", field);
    expect(address.read()).toBe("#/history");
    press("g");
    press("o");
    expect(address.read()).toBe("#/ohbox");
  });

  it("lists each chord under Navigate with the place's sentence, or the place's own name where it names none; a key that is no `g` chord is not the frame's to bind", () => {
    mount();
    expect([...table].sort()).toEqual(
      [
        "g o|navigate|Go to the Ohbox",
        "g r|navigate|Go to News",
        "g s|navigate|Go to the Screener",
        "g l|navigate|Go to Answer Later",
        "g h|navigate|History",
        "g d|navigate|Go to Drafts",
        "g ,|navigate|Go to Settings",
        /* And the digits the frame binds to the places it numbers, with the same sentences (the switch's point 62). */
        "1|navigate|Go to the Ohbox",
        "2|navigate|Go to News",
        "3|navigate|Go to the Screener",
        "4|navigate|Go to Answer Later",
        /* And the room's own key, which stands in the same table since the room binds it there, under the key
           sheet's own word for it (the shipped shell's table: `fixtures/keys-at-the-ohbox.base.json`). */
        "z|app|Undo last action",
      ].sort(),
    );
  });

  it("refuses two places that print one chord, by their names", () => {
    const twice: FramePlaces = {
      ...NO_PLACES,
      trash: place("trash", entry("more", { keyHint: "g t" })),
      tags: place("tags", entry("tags", { keyHint: "g t" })),
    };
    expect(() => placeChords(twice)).toThrow(/"g t".*tags.*trash|"g t".*trash.*tags/);
    expect(placeChords({ ...NO_PLACES, ...PLACES }).map((c) => c.chord)).toEqual([
      "g o",
      "g r",
      "g s",
      "g l",
      "g h",
      "g d",
      "g ,",
    ]);
  });

  it("the mail places print no chord twice", () => {
    const seated = mailPlaces();
    const all = Object.fromEntries(PLACE_IDS.map((id) => [id, seated[id] ?? NONE])) as FramePlaces;
    expect(() => placeChords(all)).not.toThrow();
  });
});

describe("the way to write passes the composer's door", () => {
  afterEach(() => setComposeDoor(null));

  it("where a composer stands its door is pressed, once, and the frame writes no address of its own", () => {
    const pressed: string[] = [];
    setComposeDoor(() => pressed.push("the composer's door"));
    const made = mount();
    const before = made.address.writes.length;
    fireEvent.click(within(rail()).getByRole("button", { name: /^Write/ }));
    expect(pressed, "the composer's door").toEqual(["the composer's door"]);
    expect(made.address.writes.slice(before), "an address the frame wrote over the door").toEqual([]);
  });

  it("where none stands the way goes straight to the place that writes", () => {
    const made = mount();
    const before = made.address.writes.length;
    fireEvent.click(within(rail()).getByRole("button", { name: /^Write/ }));
    expect(made.address.writes[before]?.next, "the first address written").toBe("#/compose");
  });
});
