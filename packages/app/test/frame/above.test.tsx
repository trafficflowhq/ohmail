/** @vitest-environment jsdom */
/**
 * WHAT STANDS ABOVE THE PANES. A host may stand one component above every pane (`features.above`): it is mounted
 * once per mounted frame, under the scope, and no walk between places mounts it again. A wide body is mounted with its
 * place and unmounted when the place is left. A place of two columns may stand a component of its own above both of
 * them, and nothing else.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
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

function Today({ route, keysHere }: PaneProps) {
  useCounted("today");
  return (
    <p>
      today at {route.place}, under {useContext(FromAbove)}, keys {keysHere ? "here" : "away"}
    </p>
  );
}
const today = (id: PlaceEntry["id"]): PlaceEntry => ({
  id,
  body: "today",
  rail: null,
  panes: { kind: "wide", Wide: Today },
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

beforeEach(() => {
  for (const part of Object.keys(mounts)) delete mounts[part];
  for (const part of Object.keys(live)) delete live[part];
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("what a host stands above every pane", () => {
  const places = { ohbox: ohbox(false), news: today("news"), search: elsewhere };

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

describe("a wide body", () => {
  const places = { ohbox: ohbox(false), news: today("news"), search: elsewhere };

  it("unmounts when its place is left, as before", () => {
    const address = fakeAddress("#/search");
    render(frameOf({ places, address }));
    expect(counted("elsewhere")).toEqual({ mounts: 1, live: 1 });
    visit(address, "#/ohbox");
    expect(counted("elsewhere")).toEqual({ mounts: 1, live: 0 });
    expect(screen.queryByText("a wide place of another body")).toBeNull();

    cleanup();
    const second = fakeAddress("#/reads");
    render(frameOf({ places, address: second }));
    visit(second, "#/ohbox");
    expect(screen.queryByText(/today at/), "a body of a place left stayed mounted").toBeNull();
  });
});

describe("what a place stands above its two columns", () => {
  const places = { ohbox: ohbox(true), news: today("news"), search: elsewhere };

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

/**
 * THE SLOT'S REACH. What a host stands above every pane stands around everything the frame's root holds, not around
 * the columns alone: a registered place's count, drawn by the rail at the side and by the whole rail More opens over
 * the app, and a stage's body, drawn over the app, each read it. The reader is strict, as the mail ground's are: it
 * throws where what stands above does not reach.
 */
const Ground = createContext<string | null>(null);
function GroundAbove({ children }: { children: ReactNode }) {
  return <Ground.Provider value="7">{children}</Ground.Provider>;
}
function useGround(): string {
  const ground = useContext(Ground);
  if (ground === null) throw new Error("a reader of the ground was drawn outside it");
  return ground;
}
function useGroundCount() {
  return { count: useGround(), hot: false };
}
const counting: PlaceEntry = {
  ...ohbox(false),
  rail: { group: "main", icon: "ohbox", label: "title", useCount: useGroundCount },
};
function StageBody(_: PaneProps) {
  return <p>the stage, with {useGround()} from above</p>;
}

describe("what a host stands above reaches everything the root holds", () => {
  const places = { ohbox: counting, search: elsewhere };

  it("a registered place's count is drawn in the rail at the side", () => {
    render(frameOf({ places, above: GroundAbove, address: fakeAddress("#/ohbox") }));
    expect(within(rail()).getByRole("button", { name: "Ohbox 7" })).toBeTruthy();
  });

  it("the dock draws and names the registered place's count", () => {
    render(
      frameOf({ places, above: GroundAbove, address: fakeAddress("#/ohbox"), window: fakeWindow("phone") }),
    );
    const ohbox = within(rail()).getByRole("button", { name: "Ohbox, 7" });
    expect(within(ohbox).getByText("7")).toBeTruthy();
  });

  it("and in the whole rail that More opens over a dock at the foot", () => {
    render(
      frameOf({ places, above: GroundAbove, address: fakeAddress("#/ohbox"), window: fakeWindow("phone") }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(within(sheet).getByRole("button", { name: "Ohbox 7" })).toBeTruthy();
  });

  it("a stage's body, over the app, reads it too", () => {
    render(
      frameOf({
        places,
        stages: { firstRun: { id: "firstRun", Body: StageBody } },
        above: GroundAbove,
        address: fakeAddress("#/first-run"),
      }),
    );
    const stage = screen.getByRole("dialog", { name: "ohmail" });
    expect(within(stage).getByText("the stage, with 7 from above")).toBeTruthy();
  });
});
