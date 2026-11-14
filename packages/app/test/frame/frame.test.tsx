/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLUMNS_KEY } from "@ohmail/app-logic/lists/column-store";
import { EngineContext, useEngine } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { OhmailEngine } from "@ohmail/client-engine";
import { Frame } from "../../src/frame/Frame.js";
import {
  useConnectionFeed,
  useFrame,
  useNotice,
  useRailModel,
  useReport,
  useSelectionBar,
} from "../../src/frame/commands.js";
import type {
  CalendarEntry,
  FramePlaces,
  PaneProps,
  PlaceEntry,
  RailModel,
  StageEntry,
} from "../../src/frame/contract.js";
import { calendar as emptyCalendar } from "../../src/calendar/entry.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, movable } from "../support/fake-window.js";
import type { HostConnectionState } from "../../src/host/index.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const mounts = { today: 0 };
function Today({ route }: PaneProps) {
  useEffect(() => {
    mounts.today += 1;
  }, []);
  return <p>today at {route.place}</p>;
}
const today = (id: PlaceEntry["id"]): PlaceEntry => ({
  id,
  body: "today",
  rail: null,
  panes: { kind: "wide", Wide: Today },
});

function List({ route }: PaneProps) {
  useNotice({ kind: "trial", title: "Trial ends Wed 18 Nov" });
  const report = useReport();
  const { commands } = useFrame();
  return (
    <div>
      <p>the list of {route.place}</p>
      <button type="button" onClick={() => report("Parked", { action: "Undo", onAction: () => undefined })}>
        Park
      </button>
      <button type="button" onClick={() => commands.open("a1")}>
        Open
      </button>
    </div>
  );
}
function Reading({ route }: PaneProps) {
  return <p>reading {route.open ?? "nothing"}</p>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading },
};
const firstRun: StageEntry = { id: "firstRun", Body: () => <p>first run</p> };

function mount(
  more: Partial<FakeHostInput> = {},
  places: Partial<FramePlaces> = { ohbox, news: today("news"), later: today("later") },
) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places,
    stages: { firstRun },
    ...more,
  });
  const view = render(
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
      timeZone="Europe/Zurich"
    >
      <Frame host={made.host} />
    </TextProvider>,
  );
  return { ...made, view };
}

beforeEach(() => {
  mounts.today = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the frame", () => {
  it("draws a registered place's list and reading column, with its rail entry", () => {
    mount();
    expect(
      within(screen.getByRole("region", { name: "Messages" })).getByText("the list of ohbox"),
    ).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Reading" })).getByText("reading nothing")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ohbox" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("follows the address and writes it through the host's door alone", () => {
    const { address } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(address.writes).toEqual([{ next: "#/ohbox/m/a1", how: "push" }]);
    expect(screen.getByText("reading a1")).toBeTruthy();
    act(() => address.visit("#/reads"));
    expect(screen.getByText("today at news")).toBeTruthy();
  });

  it("keeps one mounted body for the places that share it", () => {
    const { address } = mount({ address: fakeAddress("#/reads") });
    act(() => address.visit("#/triage"));
    expect(screen.getByText("today at later")).toBeTruthy();
    expect(mounts.today).toBe(1);
  });

  it("shows a feature's notice in the rail's foot, and its report with Undo at the foot of the list", () => {
    mount();
    expect(screen.getByRole("status").textContent).toBe("Trial ends Wed 18 Nov");
    fireEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("lays out again from the window with no reload: the body stays mounted and the root says the new device", () => {
    const window = fakeWindow("desktop");
    mount({ window, address: fakeAddress("#/reads") });
    expect(document.documentElement.getAttribute("data-device")).toBe("desktop");
    act(() => window.resize(719, 781, "coarse"));
    expect(document.documentElement.getAttribute("data-device")).toBe("fold");
    expect(document.documentElement.getAttribute("data-touch")).toBe("1");
    act(() => window.resize(390, 844));
    expect(document.documentElement.getAttribute("data-device")).toBe("phone");
    expect(screen.getByRole("button", { name: "Write" })).toBeTruthy();
    expect(mounts.today).toBe(1);
  });

  it("on a phone's width shows the list alone, and the open letter over it", () => {
    const { address } = mount({ window: fakeWindow("phone") });
    expect(screen.queryByRole("region", { name: "Reading" })).toBeNull();
    act(() => address.visit("#/ohbox/m/a1"));
    expect(screen.getByRole("region", { name: "Reading" }).textContent).toBe("reading a1");
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
  });

  it("on a phone's width draws no dock while a letter is open, and draws it again when the letter closes", () => {
    const { address } = mount({ window: fakeWindow("phone") });
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
    act(() => address.visit("#/ohbox/m/a1"));
    expect(screen.getByRole("region", { name: "Reading" }).textContent).toBe("reading a1");
    expect(
      screen.queryByRole("navigation", { name: "Places" }),
      "the dock stands over the letter",
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Write" })).toBeNull();
    act(() => address.visit("#/ohbox"));
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write" })).toBeTruthy();
  });

  it("draws a place's held reading column with nothing open, gives it the keys, and draws no dock on a phone", () => {
    const seen: { list: boolean[]; reading: boolean[] } = { list: [], reading: [] };
    function KeyedList({ keysHere }: PaneProps) {
      seen.list.push(keysHere);
      return <p>the drafts</p>;
    }
    function Writing({ keysHere }: PaneProps) {
      seen.reading.push(keysHere);
      return <p>a letter being written</p>;
    }
    const write: PlaceEntry = {
      id: "write",
      body: "drafts",
      rail: null,
      panes: { kind: "columns", List: KeyedList, Reading: Writing, holds: "always" },
    };
    for (const room of ["phone", "desktop"] as const) {
      seen.list.length = 0;
      seen.reading.length = 0;
      mount({ window: fakeWindow(room), address: fakeAddress("#/compose") }, { ohbox, write });
      expect(screen.getByRole("region", { name: "Reading" }).textContent, room).toBe(
        "a letter being written",
      );
      expect(seen.reading.at(-1), room).toBe(true);
      expect(seen.list.at(-1) ?? false, room).toBe(false);
      if (room === "phone")
        expect(
          screen.queryByRole("navigation", { name: "Places" }),
          "the dock stands over the letter",
        ).toBeNull();
      cleanup();
    }
  });

  it("on a phone's width draws no dock while a wide place's address carries an open letter (today's views)", () => {
    const { address } = mount({ window: fakeWindow("phone"), address: fakeAddress("#/reads/m/r1") });
    expect(screen.getByText("today at news")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();
    act(() => address.visit("#/reads"));
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
    expect(mounts.today).toBe(1);
  });

  it("on a phone's width draws no dock while a list's selection bar stands where it stood", () => {
    function Picking(pane: PaneProps) {
      const [picked, pick] = useState(false);
      useSelectionBar(picked);
      return (
        <div>
          <List {...pane} />
          <button type="button" onClick={() => pick(!picked)}>
            {picked ? "Clear" : "Select"}
          </button>
        </div>
      );
    }
    const places = { ohbox: { ...ohbox, panes: { kind: "columns", List: Picking, Reading } } } as const;
    const window = fakeWindow("phone");
    mount({ window }, places);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(
      screen.queryByRole("navigation", { name: "Places" }),
      "the dock stands over the selection's bar",
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
    /* Beside the columns the rail stands whatever is selected: the bar has its own place there. */
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    act(() => window.resize(719, 781, "coarse"));
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
  });

  it("keeps the upright dock and the rail at the side while a letter is open", () => {
    for (const room of ["fold", "land", "desktop"] as const) {
      mount({ window: fakeWindow(room), address: fakeAddress("#/ohbox/m/a1") });
      expect(screen.getByText("reading a1")).toBeTruthy();
      expect(screen.getByRole("navigation", { name: "Places" }), room).toBeTruthy();
      cleanup();
    }
  });

  it("hands a place the host's engine where no shell's provider stands, and the shell's where one does", () => {
    const hostEngine = { name: "the host's" } as unknown as OhmailEngine;
    const shellEngine = { name: "the shell's" } as unknown as OhmailEngine;
    function Reads() {
      return <p>engine: {(useEngine() as unknown as { name: string }).name}</p>;
    }
    const places = {
      ohbox: { ...ohbox, panes: { kind: "wide", Wide: Reads } },
    } satisfies Partial<FramePlaces>;
    mount({ engine: hostEngine }, places);
    expect(screen.getByText("engine: the host's")).toBeTruthy();
    cleanup();
    const made = fakeHost({ engine: hostEngine, service: "self", scope: "acct-1", places });
    render(
      <EngineContext.Provider
        value={{ engine: shellEngine, demo: false, serverDemo: false, sync: SYNC_SETTLED }}
      >
        <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
          <Frame host={made.host} />
        </TextProvider>
      </EngineContext.Provider>,
    );
    expect(screen.getByText("engine: the shell's")).toBeTruthy();
  });

  it("lays the list on one sheet of its own beside a rail, the notice on it beside an upright dock, and on the ground on a phone", () => {
    const window = fakeWindow("desktop");
    mount({ window });
    const sheet = () =>
      screen.getByRole("region", { name: "Messages" }).querySelector(".oh-sheet[data-kind='list']");
    expect(sheet()?.textContent).toContain("the list of ohbox");
    expect(sheet()?.querySelector("[role='status']")).toBeNull();
    act(() => window.resize(719, 781, "coarse"));
    expect(sheet()?.querySelector("[role='status']")?.getAttribute("data-place")).toBe("bar");
    expect(sheet()?.textContent).toContain("the list of ohbox");
    act(() => window.resize(390, 844));
    expect(sheet()).toBeNull();
    expect(screen.getByText("the list of ohbox")).toBeTruthy();
  });

  it("puts the notice in a bar over the list where no rail stands, and More opens the whole rail", () => {
    mount({ window: fakeWindow("phone") });
    expect(screen.getByRole("status").getAttribute("data-place")).toBe("bar");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("navigation", { name: "Places" })).toHaveLength(2);
  });

  for (const [width, height] of [
    [390, 844],
    [719, 900],
  ] as const) {
    it(`at ${width} the More sheet is modal: the keys go in and stay, what is behind is inert, and closing hands them back to More`, () => {
      const window = fakeWindow("desktop");
      mount({ window });
      act(() => window.resize(width, height));
      const more = screen.getByRole("button", { name: "More" });
      /* More opens a dialog, which says itself: More says only where the app stands (the reference's More). */
      expect(more.getAttribute("aria-expanded")).toBeNull();
      act(() => more.focus());
      fireEvent.click(more);
      const sheet = screen.getByRole("dialog", { name: "More" });
      expect(sheet.getAttribute("aria-modal")).toBe("true");
      expect(sheet.contains(document.activeElement), "the keys stayed on More beneath the sheet").toBe(true);
      expect(more.getAttribute("aria-expanded")).toBeNull();
      expect(more.closest("[inert]"), "the dock behind the sheet takes the keys").not.toBeNull();
      expect(
        screen.getByRole("main", { hidden: true }).closest("[inert]"),
        "the list behind the sheet takes the keys",
      ).not.toBeNull();
      const stops = within(sheet).getAllByRole("button").length;
      for (const shiftKey of [false, true]) {
        for (let i = 0; i < stops + 2; i += 1) {
          fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey });
          expect(
            sheet.contains(document.activeElement),
            `${shiftKey ? "Shift+Tab" : "Tab"} ${i + 1} left the sheet`,
          ).toBe(true);
        }
      }
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement, "Escape left the keys nowhere").toBe(more);
      expect(more.closest("[inert]")).toBeNull();
      expect(more.getAttribute("aria-expanded")).toBeNull();
      fireEvent.click(more);
      /* A press beside the sheet, on what it stands on. */
      fireEvent.pointerDown(document.querySelector("[data-scrim]")!);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement, "a press beside the sheet left the keys nowhere").toBe(more);
    });
  }

  it("opens a registered stage over the app and holds the frame behind it inert", () => {
    mount({ address: fakeAddress("#/first-run") });
    expect(within(screen.getByRole("dialog")).getByText("first run")).toBeTruthy();
    expect(screen.getByRole("main", { hidden: true }).closest("[inert]")).not.toBeNull();
  });

  it("stamps the root's attributes and takes back only what it wrote", () => {
    document.documentElement.setAttribute("data-face", "ohmarchy");
    const { view } = mount();
    expect(document.documentElement.getAttribute("data-product")).toBe("mail");
    expect(document.documentElement.getAttribute("data-scheme")).toBe("light");
    view.unmount();
    expect(document.documentElement.getAttribute("data-face")).toBe("ohmarchy");
    expect(document.documentElement.hasAttribute("data-product")).toBe(false);
    document.documentElement.removeAttribute("data-face");
  });

  it("stamps the root of the document it is drawn in, and leaves another document's alone", () => {
    const second = document.implementation.createHTMLDocument("second");
    const container = second.body.appendChild(second.createElement("div"));
    const made = fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      places: { ohbox },
      stages: { firstRun },
    });
    const view = render(
      <TextProvider
        locale="en"
        messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
        timeZone="Europe/Zurich"
      >
        <Frame host={made.host} />
      </TextProvider>,
      { container },
    );
    expect(second.documentElement.getAttribute("data-product")).toBe("mail");
    expect(second.documentElement.getAttribute("data-face")).toBe("paper");
    expect(document.documentElement.hasAttribute("data-product")).toBe(false);
    expect(document.documentElement.hasAttribute("data-face")).toBe(false);
    view.unmount();
    expect(second.documentElement.hasAttribute("data-product")).toBe(false);
  });

  it("keeps a width set on the desktop's handle once the drag rests, in the store every reader shares", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Sidebar width" }), { key: "ArrowRight" });
    expect(document.documentElement.style.getPropertyValue("--rail-w")).toBe("240px");
    act(() => vi.advanceTimersByTime(300));
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null")).toEqual({ v: 1, rail: 240 });
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Sidebar width" }));
    act(() => vi.advanceTimersByTime(0));
    expect(localStorage.getItem(COLUMNS_KEY)).toBeNull();
  });

  it("draws no handle where a finger is used", () => {
    mount({ window: fakeWindow("land") });
    expect(screen.queryAllByRole("separator")).toEqual([]);
  });

  it("draws today's rail from the model it is fed", () => {
    const go = vi.fn();
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: [{ id: "reads", kind: "place", label: "News", icon: "news", count: "5", onPress: go }],
        },
      ],
      write: { label: "Compose", onPress: () => undefined },
      account: {
        name: "Lena",
        address: "lena@example.com",
        note: "1 mailbox",
        title: "Account",
        onPress: () => undefined,
      },
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    mount(
      { address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    fireEvent.click(screen.getByRole("button", { name: "News 5" }));
    expect(go).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Compose/ })).toBeTruthy();
    // While today's rail is fed, its landmark keeps today's name: what a screen reader and the journeys find it by.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("says the keys a fed rail names for writing and for an entry to a screen reader, and only while it names them", () => {
    const fed = movable<RailModel>({
      groups: [
        {
          id: "main",
          entries: [
            {
              id: "search",
              kind: "place",
              label: "Search",
              icon: "search",
              shortcut: "/",
              onPress: () => undefined,
            },
            { id: "history", kind: "place", label: "History", icon: "history", onPress: () => undefined },
          ],
        },
      ],
      write: { label: "Compose", shortcut: "c", onPress: () => undefined },
      account: null,
      pull: null,
    });
    function Fed(pane: PaneProps) {
      useRailModel(useSyncExternalStore(fed.subscribe, fed.read));
      return <Today {...pane} />;
    }
    mount(
      { address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    const keys = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-keyshortcuts");
    expect(keys(/Compose/)).toBe("c");
    expect(keys(/^Search/)).toBe("/");
    expect(keys(/^History/)).toBeNull();
    act(() => fed.set({ ...fed.read(), write: { label: "Compose", onPress: () => undefined } }));
    expect(keys(/Compose/)).toBeNull();
  });

  it("says a fed rail's keys on the dock's Write and Search too, upright beside the columns and at the foot", () => {
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: [
            { id: "ohbox", kind: "place", label: "Ohbox", icon: "ohbox", onPress: () => undefined },
            {
              id: "search",
              kind: "place",
              label: "Search",
              icon: "search",
              shortcut: "/",
              onPress: () => undefined,
            },
          ],
        },
      ],
      write: { label: "Compose", shortcut: "c", onPress: () => undefined },
      account: null,
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    for (const room of ["fold", "phone"] as const) {
      mount(
        { window: fakeWindow(room), address: fakeAddress("#/reads") },
        { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
      );
      const dock = within(screen.getByRole("navigation", { name: "Places" }));
      expect(dock.getByRole("button", { name: "Write" }).getAttribute("aria-keyshortcuts"), room).toBe("c");
      expect(dock.getByRole("button", { name: "Search" }).getAttribute("aria-keyshortcuts"), room).toBe("/");
      expect(dock.getByRole("button", { name: "More" }).getAttribute("aria-keyshortcuts"), room).toBeNull();
      cleanup();
    }
  });

  it("draws the rail again when only its feed changes, and leaves the wide pane and what stands in it alone", () => {
    const renders = { pane: 0 };
    /* Today's rail feeder: a part of its own in the pane, whose fold's flag is its own state, its model made once a flag. */
    function Feeder() {
      const [open, setOpen] = useState(true);
      const model = useMemo(
        (): RailModel => ({
          groups: [
            {
              id: "tags",
              entries: [
                { id: "tags", kind: "fold", label: "Tags", expanded: open, onPress: () => setOpen(!open) },
                ...(open
                  ? [
                      {
                        id: "t-1",
                        kind: "sub" as const,
                        label: "Receipts",
                        hue: 40,
                        onPress: () => undefined,
                      },
                    ]
                  : []),
              ],
            },
          ],
          write: null,
          account: null,
          pull: null,
        }),
        [open],
      );
      useRailModel(model);
      return null;
    }
    function Pane(pane: PaneProps) {
      renders.pane += 1;
      return (
        <>
          <Today {...pane} />
          <Feeder />
        </>
      );
    }
    mount(
      { address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Pane } } },
    );
    const before = renders.pane;
    for (const shown of [false, true, false]) {
      fireEvent.click(screen.getByRole("button", { name: "Tags" }));
      expect(screen.queryByRole("button", { name: "Receipts" }) !== null).toBe(shown);
    }
    expect(renders.pane - before, "a press in the rail drew the wide pane again").toBe(0);
  });

  it("puts a fed entry among the dock's tabs by the place it names, whatever its own id", () => {
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: [
            { id: "ohbox", kind: "place", label: "Ohbox", icon: "ohbox", onPress: () => undefined },
            {
              id: "reads",
              place: "news",
              kind: "place",
              label: "News",
              icon: "news",
              onPress: () => undefined,
            },
            { id: "triage-aside", kind: "place", label: "Parked", icon: "parked", onPress: () => undefined },
          ],
        },
      ],
      write: null,
      account: null,
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    mount(
      { window: fakeWindow("phone"), address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    const dock = screen.getByRole("navigation", { name: "Places" });
    expect(within(dock).getByRole("button", { name: "News" })).toBeTruthy();
    expect(within(dock).queryByRole("button", { name: "Parked" })).toBeNull();
  });

  it("stands the fed rail in a box that carries the shell's key mark and draws nothing, at the side and over the app", () => {
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: [{ id: "ohbox", kind: "place", label: "Ohbox", icon: "ohbox", onPress: () => undefined }],
        },
      ],
      write: null,
      account: null,
      pull: null,
      mark: "keys-here open",
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    const window = fakeWindow("desktop");
    mount(
      { window, address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    const rail = screen.getByRole("navigation", { name: "Main" });
    expect(rail.parentElement?.classList.contains("keys-here")).toBe(true);
    act(() => window.resize(390, 844));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("navigation", { name: "Main" }).closest(".keys-here.open")).not.toBeNull();
  });

  it("marks a registered place's entry as a drop target by the place's id, as a fed one is", () => {
    mount();
    expect(
      screen.getByRole("button", { name: "Ohbox" }).closest<HTMLElement>("[data-rail-id]")?.dataset.railId,
    ).toBe("ohbox");
  });

  it("keeps today's drop targets on the rail it is fed: a pile by its id, a tag by its own", () => {
    const model: RailModel = {
      groups: [
        {
          id: "later",
          entries: [
            {
              id: "triage-aside",
              kind: "place",
              label: "Parked",
              icon: "parked",
              count: "2",
              onPress: () => undefined,
            },
          ],
        },
        {
          id: "tags",
          entries: [
            { id: "tags", kind: "fold", label: "Tags", expanded: true, onPress: () => undefined },
            { id: "t-7", kind: "sub", label: "Receipts 2026", hue: 36, onPress: () => undefined },
          ],
        },
      ],
      write: null,
      account: {
        name: "Lena",
        address: "lena@example.com",
        note: "",
        title: "Mailboxes",
        onPress: () => undefined,
      },
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    mount(
      { address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    // The row a drag ends over finds its target with `closest`, as `drag-file.ts` does.
    const parked = screen.getByRole("button", { name: "Parked 2" });
    expect(parked.closest<HTMLElement>("[data-rail-id],[data-rail-tag-id]")?.dataset).toMatchObject({
      railId: "triage-aside",
    });
    const tag = screen.getByRole("button", { name: "Receipts 2026" });
    expect(tag.closest<HTMLElement>("[data-rail-id],[data-rail-tag-id]")?.dataset).toMatchObject({
      railTagId: "t-7",
    });
    expect(screen.getByRole("button", { name: "Tags" }).closest("[data-rail-tag-id]")).toBeNull();
  });

  it("at a phone's foot docks the app's four tabs, and leaves the other places behind More", () => {
    const place = (id: string, label: string) => ({
      id,
      kind: "place" as const,
      label,
      icon: "news" as const,
      onPress: () => undefined,
    });
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: [
            place("ohbox", "Ohbox"),
            place("news", "News"),
            place("receipts", "Receipts"),
            place("screener", "Screener"),
            place("history", "History"),
            place("search", "Search"),
          ],
        },
      ],
      write: null,
      account: {
        name: "Lena",
        address: "lena@example.com",
        note: "1 mailbox",
        title: "Account",
        onPress: () => undefined,
      },
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    mount(
      { window: fakeWindow("phone"), address: fakeAddress("#/reads") },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } },
    );
    const dock = screen.getByRole("navigation", { name: "Places" });
    expect(
      within(dock)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Ohbox", "Screener", "News", "Receipts", "More", "Search", "Write"]);
  });

  it("marks More current where the app stands on a place the dock does not show, and no fed entry is marked", () => {
    const model: RailModel = {
      groups: [
        {
          id: "main",
          entries: ["ohbox", "news", "receipts", "screener"].map((id) => ({
            id,
            kind: "place" as const,
            label: id,
            icon: "news" as const,
            onPress: () => undefined,
          })),
        },
      ],
      write: null,
      account: null,
      pull: null,
    };
    function Fed(pane: PaneProps) {
      useRailModel(model);
      return <Today {...pane} />;
    }
    const fed = { id: "trash", body: "today", rail: null, panes: { kind: "wide", Wide: Fed } } as const;
    const { address } = mount(
      { window: fakeWindow("phone"), address: fakeAddress("#/trash") },
      { trash: fed, news: { ...fed, id: "news" } },
    );
    const more = () => screen.getByRole("button", { name: "More" });
    expect(more().getAttribute("aria-current")).toBe("page");
    act(() => address.visit("#/reads"));
    expect(more().getAttribute("aria-current")).toBeNull();
  });

  it("says the connection today's views feed it", () => {
    function Feeding(pane: PaneProps) {
      useConnectionFeed({ mail: null, online: true, setupHref: null, follow: () => undefined });
      return <Today {...pane} />;
    }
    const quiet = movable<HostConnectionState | null>({
      state: "stale",
      words: { title: "Computer quiet", detail: "Waiting.", link: null },
    });
    mount(
      { address: fakeAddress("#/reads"), hostConnection: quiet },
      { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Feeding } } },
    );
    expect(screen.getByRole("status").textContent).toBe("Computer quiet Waiting.");
    act(() => quiet.set(null));
    expect(screen.queryAllByRole("status")).toEqual([]);
  });
  it("keeps what was typed in a pane while the window crosses 840 and 600 and back", () => {
    function Letter(pane: PaneProps) {
      return (
        <label>
          {`Letter at ${pane.route.place}`}
          <textarea />
        </label>
      );
    }
    const letterPlaces = {
      news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Letter } },
    } as const;
    const made = mount({ address: fakeAddress("#/reads") }, letterPlaces);
    const box = () => screen.getByRole("textbox", { name: "Letter at news" }) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: "half a letter" } });
    for (const [width, pointer] of [
      [841, "coarse"],
      [719, "coarse"],
      [390, "coarse"],
      [719, "coarse"],
      [1440, "fine"],
    ] as const) {
      act(() => made.window.resize(width, undefined, pointer));
      expect(box().value).toBe("half a letter");
    }
  });
});

/** A calendar entry whose week and day are one body that says where it stands, and opens an event. */
function CalendarHere({ route }: PaneProps) {
  const { commands, product } = useFrame();
  return (
    <div>
      <p>{`calendar ${product} at ${route.place} ${route.sub ?? "today"} open ${route.open ?? "nothing"}`}</p>
      <button
        type="button"
        onClick={() => commands.event({ event: "ev-1", occurrence: null, day: "2026-11-18" })}
      >
        Open event
      </button>
      <button type="button" onClick={() => commands.event(null)}>
        Close event
      </button>
    </div>
  );
}
const calendarPlace = (id: "week" | "day"): PlaceEntry => ({
  id,
  body: "calendar",
  rail: null,
  panes: { kind: "wide", Wide: CalendarHere },
});
const someCalendar: CalendarEntry = {
  ...emptyCalendar,
  places: { ...emptyCalendar.places, week: calendarPlace("week"), day: calendarPlace("day") },
};
function OpensFromMail() {
  const { commands, product } = useFrame();
  return (
    <div>
      <p>{`mail ${product}`}</p>
      <button
        type="button"
        onClick={() => commands.event({ event: "ev-9", occurrence: "20261120T090000", day: "2026-11-20" })}
      >
        Open the meeting
      </button>
    </div>
  );
}
const mailThatOpens: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "wide", Wide: OpensFromMail },
};

describe("the calendar's places in the frame", () => {
  it("folds a calendar address back to mail's home where the host offers no calendar, never a blank frame", () => {
    for (const absent of [{ products: "both" as const }, { calendar: someCalendar }, {}]) {
      const { address } = mount(
        { address: fakeAddress("#/cal/week/2026-11-16"), ...absent },
        { ohbox: mailThatOpens },
      );
      expect(screen.getByText("mail mail")).toBeTruthy();
      expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
      cleanup();
    }
  });

  it("folds the calendar's setup back too where no calendar is offered", () => {
    const { address } = mount({ address: fakeAddress("#/cal/cal-setup") }, { ohbox: mailThatOpens });
    expect(address.writes).toEqual([{ next: "#/ohbox", how: "replace" }]);
  });

  it("draws the calendar's registered place where the host offers both products", () => {
    const { address } = mount(
      { address: fakeAddress("#/cal/week/2026-11-16"), calendar: someCalendar, products: "both" },
      { ohbox: mailThatOpens },
    );
    expect(screen.getByText("calendar cal at week 2026-11-16 open nothing")).toBeTruthy();
    expect(address.writes).toEqual([]);
  });

  it("opens and closes an event in the place it stands in", () => {
    const { address } = mount(
      { address: fakeAddress("#/cal/week/2026-11-16"), calendar: someCalendar, products: "both" },
      { ohbox: mailThatOpens },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open event" }));
    expect(address.writes.at(-1)).toEqual({ next: "#/cal/week/2026-11-16/e/ev-1", how: "push" });
    expect(screen.getByText("calendar cal at week 2026-11-16 open ev-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close event" }));
    expect(address.writes.at(-1)).toEqual({ next: "#/cal/week/2026-11-16", how: "push" });
  });

  it("opens an event from mail in the calendar's last place, at the event's day", () => {
    const { address } = mount(
      { address: fakeAddress("#/cal/day/2026-11-16"), calendar: someCalendar, products: "both" },
      { ohbox: mailThatOpens },
    );
    act(() => address.visit("#/ohbox"));
    fireEvent.click(screen.getByRole("button", { name: "Open the meeting" }));
    expect(address.writes.at(-1)).toEqual({
      next: "#/cal/day/2026-11-20/e/ev-9%4020261120T090000",
      how: "push",
    });
    expect(screen.getByText("calendar cal at day 2026-11-20 open ev-9@20261120T090000")).toBeTruthy();
  });

  it("opens an event from mail in the week where the calendar was never visited", () => {
    const { address } = mount({ calendar: someCalendar, products: "both" }, { ohbox: mailThatOpens });
    fireEvent.click(screen.getByRole("button", { name: "Open the meeting" }));
    expect(address.writes.at(-1)?.next).toBe("#/cal/week/2026-11-20/e/ev-9%4020261120T090000");
  });

  it("does nothing on an event where the host offers no calendar", () => {
    const { address } = mount({ calendar: someCalendar }, { ohbox: mailThatOpens });
    fireEvent.click(screen.getByRole("button", { name: "Open the meeting" }));
    expect(address.writes).toEqual([]);
  });
});
