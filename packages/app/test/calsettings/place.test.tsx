/** @vitest-environment jsdom */
/**
 * THE CALENDAR'S SETTINGS PLACE IS THE ONE SETTINGS: under the calendar's address it draws settings' own menu as the
 * host registers it, and where the host mounts no Settings it says so in one line and draws no menu of its own.
 */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendar } from "../../src/calendar/entry.js";
import { calsettingsPlace } from "../../src/calsettings/index.js";
import { PANE_IDS, type SettingsBeside, type SettingsPanes } from "../../src/settings/contract.js";
import { paneOf } from "../../src/settings/facts.js";
import { settingsPlace } from "../../src/settings/place.js";
import type { Messages } from "../../src/text/index.js";
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import menuEn from "../../messages/settings-menu.en.json" with { type: "json" };
import { mirror, mountFrame, NONE } from "../calsetup/world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const WORDS = { settings: settingsEn.settings, ...menuEn } as unknown as Messages;
const ALL = Object.fromEntries(
  PANE_IDS.map((id) => [id, paneOf(id, { Body: () => <p>the {id} pane</p> })]),
) as SettingsPanes;
const beside: SettingsBeside = { go: () => undefined, startAt: null };
const entry = { places: { ...calendar.places, calsettings: calsettingsPlace } };

describe("the calendar's Settings", () => {
  it("draws settings' own menu under the calendar's address", async () => {
    mountFrame("#/cal/calendars", mirror(), NONE, {
      entry,
      places: { settings: settingsPlace(ALL, () => beside) },
      words: WORDS,
    });
    await act(async () => undefined);
    const general = settingsEn.settings.general as unknown as string;
    expect(screen.getAllByRole("button", { name: new RegExp(general) }).length).toBeGreaterThan(0);
  });

  it("says in one line that Settings is not here where the host mounts none", async () => {
    mountFrame("#/cal/calendars", mirror(), NONE, { entry, words: WORDS });
    await act(async () => undefined);
    expect(document.body.textContent).toContain("Settings is not here on this device");
    expect(screen.queryByRole("button", { name: /General/ })).toBeNull();
  });
});
