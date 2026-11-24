/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_SCROLL_STEP } from "@ohmail/app-logic/keys";
import { Frame } from "../../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../../src/frame/contract.js";
import { NONE } from "../../../src/host/index.js";
import {
  PANE_IDS,
  type PaneId,
  type SettingsBeside,
  type SettingsPanes,
} from "../../../src/settings/contract.js";
import { paneOf } from "../../../src/settings/facts.js";
import { settingsPlace } from "../../../src/settings/place.js";
import { TextProvider, type Messages } from "../../../src/text/index.js";
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
import menuEn from "../../../messages/settings-menu.en.json" with { type: "json" };
import { FRAME_WORDS } from "../../support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../support/fake-window.js";
import { madeOf, SETTINGS } from "./hosts.js";

const WORDS: Messages = {
  ...FRAME_WORDS.en,
  settings: settingsEn.settings,
  ...menuEn,
  ohbox: { title: "Ohbox" },
};
const mounted: PaneId[] = [];
const bodyOf = (id: PaneId) =>
  function Body() {
    useEffect(() => {
      mounted.push(id);
    }, []);
    return (
      <>
        <p>the {id} pane</p>
        {id === "general" ? (
          <label>
            Display name
            <input />
          </label>
        ) : null}
      </>
    );
  };
const ALL = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body: bodyOf(id) })])) as SettingsPanes;
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "wide", Wide: ({ route }: PaneProps) => <p>at {route.place}</p> },
};

/** The shell's way between sections, as the web's runs: through a leave hold a pane may set. */
function shellBeside(address: { visit(next: string): void }, startAt: PaneId | null = null) {
  const said = { asked: 0, hold: null as null | ((leave: () => void) => void) };
  const beside: SettingsBeside = {
    startAt,
    go(pane) {
      const leave = () => address.visit(pane === null ? "#/settings" : `#/settings/${pane}`);
      if (said.hold) {
        said.asked += 1;
        said.hold(leave);
      } else leave();
    },
  };
  /** A pane's leave hold, as its shell hook sets it. */
  const hold = (ask: (leave: () => void) => void) => {
    said.hold = ask;
    return () => {
      said.hold = null;
    };
  };
  return { said, beside, hold };
}

function mount(
  at: string,
  room: "desktop" | "phone" = "desktop",
  setting = "W-d",
  panes: SettingsPanes = ALL,
) {
  const address = fakeAddress(at);
  const shell = shellBeside(address);
  const settings: PlaceEntry = {
    ...settingsPlace(panes, () => shell.beside),
    rail: { group: "more", icon: "settings", label: "title" },
  };
  const made = madeOf(SETTINGS[setting]!, { address, window: fakeWindow(room), places: { ohbox, settings } });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return { address, ...shell };
}
const menu = () => within(screen.getByRole("navigation", { name: settingsEn.settings.navAria }));
const entry = (name: string) => menu().getByRole("button", { name });
const section = (name: string) => screen.getByRole("region", { name });
const settingsRail = () =>
  within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Settings" });
const key = (key: string): boolean => fireEvent.keyDown(document.activeElement ?? document.body, { key });

beforeEach(() => {
  mounted.length = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("walking Settings with the keyboard", () => {
  it("enters on General and walks the menu without going past either end", () => {
    mount("#/settings");
    const items = menu().getAllByRole("button");
    expect(items.length).toBeGreaterThan(2);
    expect(items[0]).toBe(entry("General"));
    expect(items[0]?.getAttribute("aria-current")).toBe("page");

    key("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items[0]);
    for (const _item of items) key("ArrowDown");
    expect(document.activeElement).toBe(items.at(-1));
    key("ArrowDown");
    expect(document.activeElement).toBe(items.at(-1));
  });

  it("can move right from the rail through the current entry to a named, scrollable section", () => {
    mount("#/settings/rules");
    settingsRail().focus();
    key("ArrowRight");
    expect(document.activeElement).toBe(entry("Rules"));
    const rules = section("Rules");
    const reveal = vi.fn();
    rules.scrollIntoView = reveal;
    key("ArrowRight");
    expect(document.activeElement).toBe(rules);
    expect(rules.tabIndex).toBe(-1);
    expect(reveal).toHaveBeenCalledWith({ block: "nearest" });
    expect(rules.scrollTop).toBe(0);
    key("ArrowDown");
    expect(rules.scrollTop).toBe(READER_SCROLL_STEP);
    key("ArrowUp");
    expect(rules.scrollTop).toBe(0);
  });

  it("Escape and Left come back to the active menu row and then reach the rail", () => {
    mount("#/settings");
    key("ArrowDown");
    key("ArrowRight");
    expect(document.activeElement).toBe(section("General"));
    key("Escape");
    expect(document.activeElement).toBe(entry("General"));
    key("Escape");
    expect(document.activeElement).toBe(settingsRail());

    key("ArrowRight");
    expect(document.activeElement).toBe(entry("General"));
    key("ArrowRight");
    expect(document.activeElement).toBe(section("General"));
    key("ArrowLeft");
    expect(document.activeElement).toBe(entry("General"));
    key("ArrowLeft");
    expect(document.activeElement).toBe(settingsRail());
  });

  it("leaves the arrows with an input in the open section", () => {
    mount("#/settings");
    const input = screen.getByRole("textbox", { name: "Display name" });
    const general = section("General");
    input.focus();
    for (const arrow of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(key(arrow)).toBe(true);
      expect(document.activeElement).toBe(input);
    }
    expect(general.scrollTop).toBe(0);
  });

  it("opens the focused menu entry and returns to it on one column through the existing leave hold", () => {
    const { address, hold, said } = mount("#/settings", "phone");
    key("ArrowDown");
    expect(document.activeElement).toBe(entry("General"));
    key("ArrowDown");
    expect(document.activeElement).toBe(entry("Notifications"));
    key("ArrowRight");
    expect(address.read()).toBe("#/settings/notifications");
    expect(document.activeElement).toBe(section("Notifications"));

    let leave: (() => void) | undefined;
    const release = hold((go) => {
      leave = go;
    });
    key("Escape");
    expect(said.asked).toBe(1);
    expect(address.read()).toBe("#/settings/notifications");
    expect(document.activeElement).toBe(section("Notifications"));
    act(() => leave?.());
    expect(address.read()).toBe("#/settings");
    expect(document.activeElement).toBe(entry("Notifications"));

    release();
    key("Enter");
    expect(document.activeElement).toBe(section("Notifications"));
    key("ArrowLeft");
    expect(address.read()).toBe("#/settings");
    expect(document.activeElement).toBe(entry("Notifications"));
  });
});

describe("Settings as a place, over the fake host", () => {
  it("on two columns draws the menu beside the section the route names, that entry the current page", () => {
    mount("#/settings/rules");
    expect(screen.getByText("the rules pane")).toBeTruthy();
    expect(entry("Rules").getAttribute("aria-current")).toBe("page");
    expect(entry("General").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { name: "Rules" })).toBeTruthy();
  });

  it("lists the setting's sections in their groups, and nothing a host withholds", () => {
    mount("#/settings");
    const names = menu()
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["General", "Notifications", "Rules", "Tags", "About ohmail"]);
    expect(
      menu()
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Settings", "Mail", "About"]);
  });

  it("an unknown or unlisted section shows General on two columns and the menu on one", () => {
    for (const at of ["#/settings/nowhere", "#/settings/screener"]) {
      mount(at);
      expect(screen.getByText("the general pane"), at).toBeTruthy();
      cleanup();
      mount(at, "phone");
      expect(menu().getAllByRole("button").length, at).toBe(5);
      expect(screen.queryByText(/ pane$/), at).toBeNull();
      cleanup();
    }
  });

  it("a section whose wires are all none is never mounted, whatever the address says", () => {
    mount("#/settings/screener");
    expect(mounted).toEqual(["general"]);
    expect(menu().queryByRole("button", { name: "Screener" })).toBeNull();
  });

  it("on a phone a section stands over the menu with the way back, and the dock gives way to it", () => {
    const { address } = mount("#/settings/tags", "phone");
    expect(screen.getByText("the tags pane")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: settingsEn.settings.navAria })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Places" }),
      "the dock stands under the section",
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: settingsEn.settings.back }));
    expect(address.read()).toBe("#/settings");
    expect(menu().getAllByRole("button").length).toBe(5);
    expect(
      screen.getByRole("navigation", { name: "Places" }),
      "the dock at rest under the menu",
    ).toBeTruthy();
  });

  it("a section holding unsaved words asks before a menu press leaves it, and leaves once the ask says so", () => {
    const { said, hold, address } = mount("#/settings/rules");
    let leave: (() => void) | null = null;
    const release = hold((go) => {
      leave = go;
    });
    fireEvent.click(entry("Tags"));
    expect(said.asked).toBe(1);
    expect(screen.getByText("the rules pane")).toBeTruthy();
    act(() => leave!());
    expect(address.read()).toBe("#/settings/tags");
    expect(screen.getByText("the tags pane")).toBeTruthy();
    release();
  });

  it("the way back on a phone goes through the same hold", () => {
    const { said, hold } = mount("#/settings/rules", "phone");
    hold(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: settingsEn.settings.back }));
    expect(said.asked).toBe(1);
    expect(screen.getByText("the rules pane")).toBeTruthy();
  });

  it("mounts one body per section: the one that stands", () => {
    mount("#/settings/about", "desktop", "W-m");
    expect(mounted).toEqual(["about"]);
  });

  it("a section nothing registers is neither listed nor drawn", () => {
    mount("#/settings/about", "desktop", "W-d", { ...ALL, about: NONE } as SettingsPanes);
    expect(menu().queryByRole("button", { name: "About ohmail" })).toBeNull();
    expect(screen.getByText("the general pane")).toBeTruthy();
  });
});
