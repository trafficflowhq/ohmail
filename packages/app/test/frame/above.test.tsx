/** @vitest-environment jsdom */
/**
 * WHAT STANDS ABOVE THE PANES, AND THE BODY THAT STAYS. A host may stand one component above every pane
 * (`features.above`): it is mounted once per mounted frame, under the scope, and no walk between places mounts it
 * again. A place may keep its wide body mounted while a place of another body is on screen, and a part of the shell
 * may ask for that body over whatever place the address names. A place of two columns may stand a component of its
 * own above both of them, and nothing else.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useKeptPane } from "../../src/frame/commands.js";
import type { FramePlaces, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** How often each part was mounted, and how many of each stand now. */
const mounts: Record<string, number> = {};
const live: Record<string, number> = {};
function useCounted(part: string): void {
  useEffect(() => {
    mounts[part] = (mounts[part] ?? 0) + 1;
    live[part] = (live[part] ?? 0) + 1;
    return () => {
      live[part] = (live[part] ?? 0) - 1;
    };
  }, [part]);
}
const counted = (part: string) => ({ mounts: mounts[part] ?? 0, live: live[part] ?? 0 });

/** What a shell stands above every pane: providers, and nothing drawn. */
const FromAbove = createContext("nothing above");
function Above({ children }: { children: ReactNode }) {
  useCounted("above");
  return <FromAbove.Provider value="the shell above">{children}</FromAbove.Provider>;
}

/** Whether a part of the shell asks for the kept body now: a test sets it. */
const asked = { set: (_: boolean): void => undefined };
function Today({ route, keysHere }: PaneProps) {
  useCounted("today");
  const [over, setOver] = useState(false);
  asked.set = setOver;
  useKeptPane(over);
  return (
    <p>
      today at {route.place}, under {useContext(FromAbove)}, keys {keysHere ? "here" : "away"}
    </p>
  );
}
const today = (id: PlaceEntry["id"], kept: boolean): PlaceEntry => ({
  id,
  body: "today",
  rail: null,
  panes: kept ? { kind: "wide", Wide: Today, kept: true } : { kind: "wide", Wide: Today },
});

function Elsewhere(_: PaneProps) {
  useCounted("elsewhere");
  return <p>a wide place of another body</p>;
}
const elsewhere: PlaceEntry = {
  id: "search",
  body: "search",
  rail: null,
  panes: { kind: "wide", Wide: Elsewhere },
};

/** A place of two columns that stands a provider of its own above both. */
const OfThePlace = createContext("no place above");
function PlaceAbove({ children }: { children: ReactNode }) {
  useCounted("placeAbove");
  return <OfThePlace.Provider value="the Ohbox's own">{children}</OfThePlace.Provider>;
}
function List(_: PaneProps) {
  useCounted("list");
  return <p>the list, under {useContext(OfThePlace)}</p>;
}
function Reading(_: PaneProps) {
  return <p>the reading column, under {useContext(OfThePlace)}</p>;
}
const ohbox = (above: boolean): PlaceEntry => ({
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: above ? { kind: "columns", List, Reading, Above: PlaceAbove } : { kind: "columns", List, Reading },
});

const WORDS = { ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } };
function frameOf(input: Partial<FakeHostInput> & { places: Partial<FramePlaces> }) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    ...input,
  });
  return (
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>
  );
}
const visit = (address: FakeAddress, to: string) => act(() => address.visit(to));
const rail = () => screen.getByRole("navigation", { name: "Places" });
const main = () => screen.getByRole("main");

beforeEach(() => {
  for (const part of Object.keys(mounts)) delete mounts[part];
  for (const part of Object.keys(live)) delete live[part];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("what a host stands above every pane", () => {
  const places = { ohbox: ohbox(false), news: today("news", true), search: elsewhere };

  it("is mounted once under the scope, and a walk over three places of three bodies mounts neither it nor the rail again", () => {
    const address = fakeAddress("#/ohbox");
    render(frameOf({ places, above: Above, address }));
    const railAtFirst = rail();
    expect(counted("above")).toEqual({ mounts: 1, live: 1 });
    visit(address, "#/reads");
    expect(screen.getByText(/today at news, under the shell above/)).toBeTruthy();
    visit(address, "#/search");
    expect(screen.getByText("a wide place of another body")).toBeTruthy();
    visit(address, "#/ohbox");
    expect(screen.getByText(/the list/)).toBeTruthy();
    expect(counted("above"), "a place change mounted it again").toEqual({ mounts: 1, live: 1 });
    expect(rail(), "the rail is another node").toBe(railAtFirst);
  });

  it("is mounted again by another scope, and never under a scope the frame refuses", () => {
    const address = fakeAddress("#/reads");
    const view = render(frameOf({ places, above: Above, address }));
    expect(counted("above")).toEqual({ mounts: 1, live: 1 });
    view.rerender(frameOf({ places, above: Above, address, scope: "acct-2" }));
    expect(counted("above"), "another scope is another mount").toEqual({ mounts: 2, live: 1 });
    for (const refused of [null, "", "local", "anon", "a:b"]) {
      view.rerender(frameOf({ places, above: Above, address, scope: refused }));
      expect(counted("above"), `under ${String(refused)}`).toEqual({ mounts: 2, live: 0 });
    }
  });

  it("draws nothing of its own: with none the frame draws the same nodes", () => {
    /* The markup, with the ids React numbers by render taken out: two renders never share those. */
    const drawn = (above: FakeHostInput["above"]) => {
      const view = render(frameOf({ places, above, address: fakeAddress("#/ohbox") }));
      const html = view.container.innerHTML.replace(/:r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_/g, "id");
      view.unmount();
      return html;
    };
    const Through = ({ children }: { children: ReactNode }) => <>{children}</>;
    expect(drawn(Through)).toBe(drawn(undefined));
  });
});

describe("the body a place keeps", () => {
  const places = {
    ohbox: ohbox(false),
    news: today("news", true),
    later: today("later", true),
    search: elsewhere,
  };
  /** The kept body's box: the wide pane that holds today's words. */
  const keptBox = () => screen.getByText(/today at/).parentElement!;

  it("has one mount over wide, columns and wide, hidden and inert while the columns show", () => {
    const address = fakeAddress("#/reads");
    render(frameOf({ places, address }));
    expect(counted("today")).toEqual({ mounts: 1, live: 1 });
    expect({ hidden: keptBox().hidden, inert: keptBox().hasAttribute("inert") }).toEqual({
      hidden: false,
      inert: false,
    });
    expect(screen.getByText(/keys here/)).toBeTruthy();

    visit(address, "#/ohbox");
    expect(within(main()).getByText(/the list/)).toBeTruthy();
    expect(counted("today"), "the kept body was unmounted").toEqual({ mounts: 1, live: 1 });
    expect({ hidden: keptBox().hidden, inert: keptBox().hasAttribute("inert") }).toEqual({
      hidden: true,
      inert: true,
    });
    expect(screen.getByText(/keys away/), "the hidden body was told the keys are here").toBeTruthy();

    visit(address, "#/triage");
    expect(screen.getByText(/today at later/)).toBeTruthy();
    expect(counted("today"), "the kept body was mounted again").toEqual({ mounts: 1, live: 1 });
    expect({ hidden: keptBox().hidden, inert: keptBox().hasAttribute("inert") }).toEqual({
      hidden: false,
      inert: false,
    });
    expect(counted("list"), "the columns stayed mounted under the wide pane").toEqual({ mounts: 1, live: 0 });
  });

  it("is the first node of the main landmark at every place, and stays that node", () => {
    const address = fakeAddress("#/reads");
    render(frameOf({ places, address }));
    const box = keptBox();
    for (const to of ["#/ohbox", "#/search", "#/triage", "#/ohbox"]) {
      visit(address, to);
      expect(keptBox(), `another node at ${to}`).toBe(box);
      expect(main().firstElementChild, `not first at ${to}`).toBe(box);
    }
  });

  it("a wide body that is not kept unmounts when its place is left, as before", () => {
    const address = fakeAddress("#/search");
    render(frameOf({ places, address }));
    expect(counted("elsewhere")).toEqual({ mounts: 1, live: 1 });
    visit(address, "#/ohbox");
    expect(counted("elsewhere")).toEqual({ mounts: 1, live: 0 });
    expect(screen.queryByText("a wide place of another body")).toBeNull();

    cleanup();
    const unkept = { ohbox: ohbox(false), news: today("news", false) };
    const second = fakeAddress("#/reads");
    render(frameOf({ places: unkept, address: second }));
    visit(second, "#/ohbox");
    expect(screen.queryByText(/today at/), "a body no entry keeps stayed mounted").toBeNull();
  });

  it("stands over a place of two columns while a part of the shell asks for it, and the place's list is not mounted", () => {
    const address = fakeAddress("#/ohbox");
    render(frameOf({ places, address }));
    expect(counted("list")).toEqual({ mounts: 1, live: 1 });
    expect(keptBox().hidden).toBe(true);

    act(() => asked.set(true));
    expect(keptBox().hidden, "the kept pane stayed hidden").toBe(false);
    expect(screen.getByText(/today at ohbox/)).toBeTruthy();
    expect(counted("list"), "the place's list is still mounted under it").toEqual({ mounts: 1, live: 0 });
    expect(screen.queryByText(/the reading column/)).toBeNull();
    expect(counted("today")).toEqual({ mounts: 1, live: 1 });

    act(() => asked.set(false));
    expect(keptBox().hidden).toBe(true);
    expect(counted("list"), "the columns did not come back").toEqual({ mounts: 2, live: 1 });
  });
});

describe("what a place stands above its two columns", () => {
  const places = { ohbox: ohbox(true), news: today("news", true), search: elsewhere };

  it("is mounted and unmounted with them, reaches both panes, and never mounts the rail again", () => {
    const address = fakeAddress("#/ohbox");
    render(frameOf({ places, address }));
    const railAtFirst = rail();
    expect(counted("placeAbove")).toEqual({ mounts: 1, live: 1 });
    expect(screen.getByText("the list, under the Ohbox's own")).toBeTruthy();
    expect(screen.getByText("the reading column, under the Ohbox's own")).toBeTruthy();

    visit(address, "#/reads");
    expect(counted("placeAbove"), "it outlived its columns").toEqual({ mounts: 1, live: 0 });
    expect(rail(), "leaving the place mounted the rail again").toBe(railAtFirst);

    visit(address, "#/ohbox");
    expect(counted("placeAbove")).toEqual({ mounts: 2, live: 1 });
    expect(counted("list")).toEqual({ mounts: 2, live: 1 });
    expect(rail(), "coming back mounted the rail again").toBe(railAtFirst);
  });
});
