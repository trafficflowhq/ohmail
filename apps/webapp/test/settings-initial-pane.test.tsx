/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import { PANE_IDS, type PaneId, type SettingsPanes } from "../../../packages/app/src/settings/contract.js";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import settingsEn from "../../../packages/app/messages/settings.en.json" with { type: "json" };
import menuEn from "../../../packages/app/messages/settings-menu.en.json" with { type: "json" };
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";

/**
 * WHICH SETTINGS PANE A LINK LANDS ON.
 *
 * The Screener's AI-credit line offers "start a plan", and the offer is a promise about a
 * specific pane: the one with the plan cards on it. Landing on General instead is the shape of
 * broken promise nobody files a bug about — they just do not find the thing and stop looking.
 *
 * Two things are checked, and the second is the one a plausible implementation gets wrong:
 *
 *  1. a caller that names a pane opens on it;
 *  2. naming a pane does not PIN it. The prop is read once, as initial state, exactly as the
 *     `?settings=` deep link is — so the nav still works afterwards. A watched prop would drag
 *     the person back to Subscription every time they clicked away.
 *
 * RE-POINTED (the switch's older tests, sorted once): today's Settings view leaves with the switch. Settings is the
 * new frame's place (`settingsPlace`, as `mail/panes.ts` hands it), drawn here by the place's own test door (the
 * frame over a fake host of the web's managed setting, `packages/app/test/settings/frame/hosts.ts`), a sentinel body
 * for every section; a caller that names a section is the shell's `startAt`, which is read as the bare address's
 * section and never pins it; the General entry is the menu's button by its name. RETIRED HERE: "the URL deep link is
 * unchanged and still answers `general` for anything unknown" (today's `initialPaneFromUrl`): a Settings address
 * that names nothing, or a section that is not listed, stands on General, held by the menu's own case
 * (`packages/app/test/settings/frame/menu.test.ts`, "for an unknown or unlisted section is General on two columns and
 * the menu on one"). Every other expectation as it stood.
 */

const WORDS: Messages = {
  ...FRAME_WORDS.en,
  settings: settingsEn.settings,
  ...menuEn,
  ohbox: { title: "Ohbox" },
};
const bodyOf = (id: PaneId) =>
  function Body() {
    return <p>{id === "billing" ? "SUBSCRIPTION PANE" : `the ${id} pane`}</p>;
  };
const ALL = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body: bodyOf(id) })])) as SettingsPanes;
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "wide", Wide: ({ route }: PaneProps) => <p>at {route.place}</p> },
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

async function render2(initialPane?: "billing" | "general"): Promise<HTMLElement> {
  const address = fakeAddress("#/settings");
  // The Subscription section is the managed service's: a sentinel body is what the section draws.
  const settings = settingsPlace(ALL, () => ({
    startAt: initialPane ?? null,
    go: (pane) => address.visit(pane === null ? "#/settings" : `#/settings/${pane}`),
  }));
  const made = madeOf(SETTINGS["W-m"]!, { address, window: fakeWindow("desktop"), places: { ohbox, settings } });
  return render(
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Frame host={made.host} />
    </TextProvider>,
  ).container;
}

describe("SettingsView's initial pane", () => {
  it("opens on GENERAL when nobody says otherwise", async () => {
    const el = await render2();
    expect(el.textContent).not.toContain("SUBSCRIPTION PANE");
  });

  it("opens on the pane the CALLER named — the Screener's offer keeps its promise", async () => {
    const el = await render2("billing");
    expect(el.textContent).toContain("SUBSCRIPTION PANE");
  });

  it("does not PIN it — the nav still moves off the named pane", async () => {
    const el = await render2("billing");
    expect(el.textContent).toContain("SUBSCRIPTION PANE");
    // Click the General entry. Read off the rendered nav rather than a test id: the label is the
    // thing a person clicks, and a nav that stopped rendering it would fail here rather than pass
    // against a hook nobody can see.
    const nav = within(screen.getByRole("navigation", { name: settingsEn.settings.navAria }));
    const general = nav.queryByRole("button", { name: settingsEn.settings.general });
    expect(general, "the General nav entry is not rendered").toBeTruthy();
    fireEvent.click(general!);
    expect(el.textContent).not.toContain("SUBSCRIPTION PANE");
  });
});
