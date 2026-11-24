/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { PANE_IDS, type SettingsPanes } from "../../../packages/app/src/settings/contract.js";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import settingsWords from "../../../packages/app/messages/settings.en.json";
import menuWords from "../../../packages/app/messages/settings-menu.en.json";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const panes = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body: () => null })])) as SettingsPanes;
const settings = settingsPlace(panes, () => ({ startAt: null, go: () => undefined }));

function navLabels(surface: "W-m" | "D-m") {
  const { host } = madeOf(SETTINGS[surface]!, {
    address: fakeAddress("#/settings"),
    window: fakeWindow("desktop"),
    places: { settings },
  });
  render(
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ...settingsWords, ...menuWords }} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  return within(screen.getByRole("navigation", { name: "Settings sections" }))
    .getAllByRole("button").map((button) => button.textContent?.trim());
}

describe("SET-P — the two surfaces offer the same panes", () => {
  it("…and adds exactly one the browser cannot have", () => {
    const web = navLabels("W-m");
    cleanup();
    const desktop = navLabels("D-m");
    expect(desktop.filter((label) => !web.includes(label))).toEqual(["Desktop"]);
    expect(web.filter((label) => !desktop.includes(label))).toEqual([]);
  });
});
