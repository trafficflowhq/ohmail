import { describe, expect, it } from "vitest";
import { NONE, type HostContract } from "../../../src/host/index.js";
import { PANE_IDS, type PaneId, type SettingsPanes } from "../../../src/settings/contract.js";
import { paneOf } from "../../../src/settings/facts.js";
import { groupsOf, menuOf, shownOf } from "../../../src/settings/menu.js";
import { hostOf, MENUS, SETTINGS, type Setting } from "./hosts.js";

const Body = () => null;
const ALL: SettingsPanes = Object.fromEntries(
  PANE_IDS.map((id) => [id, paneOf(id, { Body })]),
) as SettingsPanes;
const ids = (host: HostContract, panes: SettingsPanes = ALL) => menuOf(host, panes).map((pane) => pane.id);
const turned = (name: string, change: (setting: Setting) => Setting) => hostOf(change(SETTINGS[name]!));
const without = (list: readonly string[], ...gone: string[]) => list.filter((id) => !gone.includes(id));

describe("the Settings menu of each setting", () => {
  for (const [name, menu] of Object.entries(MENUS)) {
    it(`${name} lists the host contract's sections, in the menu's order`, () => {
      expect(ids(hostOf(SETTINGS[name]!))).toEqual(menu);
    });
  }

  it("a conditional cell turned the other way withdraws its section", () => {
    const off = (name: string, change: (s: Setting) => Setting, gone: string) =>
      expect(ids(turned(name, change)), `${name} without ${gone}`).toEqual(without(MENUS[name]!, gone));
    off("W-m", (s) => ({ ...s, capabilities: { ...s.capabilities, foldersStorable: false } }), "folders");
    off(
      "W-m",
      (s) => ({ ...s, features: without(s.features, "subscription") as Setting["features"] }),
      "billing",
    );
    off("W-s", (s) => ({ ...s, features: without(s.features, "storage") as Setting["features"] }), "storage");
    off("W-s", (s) => ({ ...s, features: without(s.features, "invites") as Setting["features"] }), "invites");
    off(
      "H",
      (s) => ({ ...s, features: without(s.features, "mailboxes") as Setting["features"] }),
      "mailboxes",
    );
    off("D-p", (s) => ({ ...s, wires: without(s.wires, "away") as Setting["wires"] }), "away");
  });

  it("Away is never listed where its wire stands but no place sends the replies", () => {
    const host = turned("W-m", (s) => ({ ...s, capabilities: { ...s.capabilities, awayRunsOn: NONE } }));
    expect(ids(host)).toEqual(without(MENUS["W-m"]!, "away"));
  });

  it("Signatures and Folders go with the consent wire, and the Screener with its last wire", () => {
    const host = turned("W-m", (s) => ({ ...s, wires: ["away"] }));
    expect(ids(host)).toEqual(without(MENUS["W-m"]!, "screener", "folders", "signatures"));
  });

  it("a section nothing registers is not listed, even where its host would list it", () => {
    const panes = { ...ALL, ai: NONE } as SettingsPanes;
    expect(ids(hostOf(SETTINGS["W-m"]!), panes)).toEqual(without(MENUS["W-m"]!, "ai"));
  });

  it("groups the menu into Mail, Account and About, leaving an empty group out", () => {
    const groups = (name: string) =>
      groupsOf(menuOf(hostOf(SETTINGS[name]!), ALL)).map(({ group, panes }) => [
        group,
        panes.map((p) => p.id),
      ]);
    expect(groups("W-d")).toEqual([
      ["mail", ["general", "notifications", "rules", "tags"]],
      ["about", ["about"]],
    ]);
    expect(groups("D-l").map(([group]) => group)).toEqual(["mail", "account", "about"]);
  });
});

describe("the section that stands", () => {
  const menu = menuOf(hostOf(SETTINGS["W-d"]!), ALL);
  const shown = (sub: string | null, columns: 1 | 2, startAt: PaneId | null = null) =>
    shownOf(sub, menu, columns, startAt)?.id ?? null;

  it("is the listed section the route names, on one column and on two", () => {
    expect(shown("rules", 1)).toBe("rules");
    expect(shown("rules", 2)).toBe("rules");
  });

  it("for an unknown or unlisted section is General on two columns and the menu on one", () => {
    for (const sub of ["nowhere", "away", null]) {
      expect(shown(sub, 2), String(sub)).toBe("general");
      expect(shown(sub, 1), String(sub)).toBe(null);
    }
  });

  it("is a link's section on two columns where it is listed", () => {
    expect(shown(null, 2, "about")).toBe("about");
    expect(shown(null, 2, "ai")).toBe("general");
    expect(shown(null, 1, "about")).toBe(null);
  });
});
