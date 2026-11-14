import { describe, expect, it } from "vitest";
import { PANES } from "../../../packages/app/src/frame/route.js";
import { PANE_IDS, type SettingsPane, type SettingsPanes } from "../../../packages/app/src/settings/contract.js";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import { menuOf } from "../../../packages/app/src/settings/menu.js";
import { hostOf } from "../../../packages/app/test/settings/frame/hosts.js";
import menuEn from "../../../packages/app/messages/settings-menu.en.json" with { type: "json" };

/**
 * ONE tab list for the settings nav and the ⌘K palette. The census runs both ways,
 * because a census that cannot say what it did not cover covers nothing: with everything wired
 * the emitted ids equal the router's own `PANE_IDS` (every routable pane has an entry, every
 * entry is routable), and with nothing wired only the panes every surface has remain. The
 * `WiredPanes` record is total by type, so a new pane cannot compile past its callers unanswered.
 *
 * RE-POINTED (the switch's older tests, sorted once): today's tab list (`settingsPanes` over a `WiredPanes` record)
 * leaves with the switch. Settings is the new frame's place: its menu is `menuOf(host, panes)` over the registration
 * contract, whose record of panes is total by type; "wired" is a section the host's answers list, "everything wired"
 * a registration that every host answer lists, "nothing wired" a host that hands no feature, no wire and no
 * capability; the router is the frame's route and the Settings sections it knows (`PANES`). A section's name is its
 * catalogue key; the desktop's section is named by the menu's own sentence, which says what the desktop said for it
 * ("Desktop"), since the host no longer hands the word. RETIRED HERE: "an unwired pane is absent, not relabelled —
 * one flag, one entry", held by the menu's own case (`packages/app/test/settings/frame/menu.test.ts`, "a conditional
 * cell turned the other way withdraws its section": each host answer turned off withdraws its one section and
 * leaves the rest of the menu as it stood). The panes every surface has gain Rules, as the host contract lists it on
 * every setting (every shell handed today's rules). Every other expectation as it stood.
 */

const Body = () => null;
const EVERY_ANSWER_LISTS = Object.fromEntries(
  PANE_IDS.map((id): [string, SettingsPane] => [id, { ...paneOf(id, { Body }), listed: () => true }]),
) as SettingsPanes;
const REGISTERED = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body })])) as SettingsPanes;
const NOTHING = hostOf({ features: [], wires: [], capabilities: { service: "managed" } });
const ALL_IDS = () => menuOf(NOTHING, EVERY_ANSWER_LISTS).map((pane) => pane.id);

describe("the settings tab list", () => {
  it("everything wired — the set equals the router's PANE_IDS, both ways", () => {
    const ids = ALL_IDS();
    expect([...ids].sort()).toEqual([...PANES].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the nav's reading order — client basics, mail plumbing, account administration, facts", () => {
    expect(ALL_IDS()).toEqual([
      "general", "notifications", "mailboxes", "screener", "ai", "away", "rules", "tags",
      "folders", "signatures", "desktop", "devices", "billing", "storage", "invites", "security",
      "account", "about", "help",
    ]);
  });

  it("nothing wired — only the panes every surface has", () => {
    // Rules is one of them now: every shell handed today's rules (the host contract's panes, row `rules`: yes on
    // every setting), so the contract lists it from no answer of the host's.
    expect(menuOf(NOTHING, REGISTERED).map((pane) => pane.id)).toEqual(["general", "notifications", "rules", "tags"]);
  });

  it("the desktop pane wears the host's own label; every other label is the catalogue's", () => {
    const byId = new Map(menuOf(NOTHING, EVERY_ANSWER_LISTS).map((pane) => [pane.id, pane.label]));
    expect(byId.get("desktop")).toEqual({ namespace: "settingsMenu", key: "desktop" });
    expect(menuEn.settingsMenu.desktop).toBe("Desktop");
    expect(byId.get("general")).toEqual({ namespace: "settings", key: "general" });
    expect(byId.get("folders")).toEqual({ namespace: "settings", key: "folders.nav" });
    expect(byId.get("signatures")).toEqual({ namespace: "settings", key: "signatures.nav" });
    expect(byId.get("help")).toEqual({ namespace: "settings", key: "help" });
  });
});
