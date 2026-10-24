import { describe, expect, it } from "vitest";
import { PANE_IDS } from "../app/shell/routing.js";
import { settingsPanes, type WiredPanes } from "../app/views/settings-panes.js";

/**
 * ONE tab list for the settings nav and the ⌘K palette. The census runs both ways,
 * because a census that cannot say what it did not cover covers nothing: with everything wired
 * the emitted ids equal the router's own `PANE_IDS` (every routable pane has an entry, every
 * entry is routable), and with nothing wired only the panes every surface has remain. The
 * `WiredPanes` record is total by type, so a new pane cannot compile past its callers unanswered.
 */

const t = (key: string): string => `L:${key}`;

const ALL: WiredPanes = {
  mailboxes: true, screener: true, ai: true, away: true, rules: true, folders: true,
  signatures: true, desktop: "This computer", devices: true, billing: true, invites: true,
  security: true, account: true, about: true, help: true,
};

const NONE: WiredPanes = {
  mailboxes: false, screener: false, ai: false, away: false, rules: false, folders: false,
  signatures: false, desktop: null, devices: false, billing: false, invites: false,
  security: false, account: false, about: false, help: false,
};

describe("the settings tab list", () => {
  it("everything wired — the set equals the router's PANE_IDS, both ways", () => {
    const ids = settingsPanes(ALL, t).map(([id]) => id);
    expect([...ids].sort()).toEqual([...PANE_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the nav's reading order — client basics, mail plumbing, account administration, facts", () => {
    expect(settingsPanes(ALL, t).map(([id]) => id)).toEqual([
      "general", "notifications", "mailboxes", "screener", "ai", "away", "rules", "tags",
      "folders", "signatures", "desktop", "devices", "billing", "invites", "security",
      "account", "about", "help",
    ]);
  });

  it("nothing wired — only the panes every surface has", () => {
    expect(settingsPanes(NONE, t).map(([id]) => id)).toEqual(["general", "notifications", "tags"]);
  });

  it("an unwired pane is absent, not relabelled — one flag, one entry", () => {
    const ids = settingsPanes({ ...ALL, billing: false, devices: false }, t).map(([id]) => id);
    expect(ids).not.toContain("billing");
    expect(ids).not.toContain("devices");
    expect(ids).toContain("security");
  });

  it("the desktop pane wears the host's own label; every other label is the catalogue's", () => {
    const byId = new Map(settingsPanes(ALL, t));
    expect(byId.get("desktop")).toBe("This computer");
    expect(byId.get("general")).toBe("L:general");
    expect(byId.get("folders")).toBe("L:folders.nav");
    expect(byId.get("signatures")).toBe("L:signatures.nav");
    expect(byId.get("help")).toBe("L:help");
  });
});
