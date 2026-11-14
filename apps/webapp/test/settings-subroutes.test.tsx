/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import { useFrame } from "../../../packages/app/src/frame/index.js";
import { fragmentOf, routeOf } from "../../../packages/app/src/frame/route.js";
import {
  PANE_IDS,
  type PaneId,
  type SettingsBeside,
  type SettingsPanes,
} from "../../../packages/app/src/settings/contract.js";
import { paneOf } from "../../../packages/app/src/settings/facts.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import settingsEn from "../../../packages/app/messages/settings.en.json" with { type: "json" };
import menuEn from "../../../packages/app/messages/settings-menu.en.json" with { type: "json" };
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";

/**
 * SETTINGS SECTIONS ARE PLACES — `#/settings/<pane>` resolves, deep-links and walks with
 * Back/Forward.
 *
 * `#/settings` used to be the deepest thing the URL could say: which section was open lived in
 * view-local state, so a link could not name one, a reload forgot one, and Back left Settings
 * instead of leaving the section. The router now carries the pane the way it carries a screener
 * segment or a triage pile:
 *
 *   · `#/settings/devices` loads DIRECTLY onto Devices;
 *   · selecting a section WRITES the hash (`goSettings`, always the named form), so each
 *     section lands in history and Back/Forward walk them;
 *   · the BARE `#/settings` stays a real spelling — `settingsPane: null` — reserved for the
 *     view's own deep-link logic (`?settings=<pane>`, the consent ceremony's return), which an
 *     explicit segment outranks;
 *   · an unknown sub-path falls back to bare, and `normalizedHash` rewrites the bar to match —
 *     the same posture as `#/screener/bogus` and `#/triage/bogus`.
 *
 * RE-POINTED (the switch's older tests, sorted once): today's router (`parseHash`, `normalizedHash`,
 * `canonicalHash`, `goSettings`) and today's Settings view leave with the switch. The route is the frame's
 * (`routeOf`, `fragmentOf`: the place and its section, where today's said the view and its pane); the address bar is
 * the host's address door, which the frame corrects; Settings is the new frame's place, drawn here by the place's own
 * test door (the frame over a fake host of the web's managed setting, `packages/app/test/settings/frame/hosts.ts`),
 * a sentinel body for every section, its way between sections the frame's own command as the mail's Settings hands it
 * (`commands.go`, `packages/app/src/mail/panes.ts`); a press is a menu entry by its name; Back is the browser's own
 * move of the address. RETIRED HERE, each to a case of the new parts seen green:
 *  - "direct-loading #/settings/devices lands ON Devices — no clicking around": the place's "on two columns draws the
 *    menu beside the section the route names, that entry the current page" (`packages/app/test/settings/frame/
 *    place.test.tsx`);
 *  - "the bare hash leaves the ?settings= deep link in charge — the ceremony's return still lands": nothing reads that
 *    query now; the section is the address's fragment alone, which the consent return sets itself
 *    (`oauth-return-landing.test.tsx`, "completes the ceremony from a URL with NO fragment, and routes to Settings →
 *    Mailboxes").
 * Every other expectation as it stood.
 */

const WORDS: Messages = {
  ...FRAME_WORDS.en,
  settings: settingsEn.settings,
  ...menuEn,
  ohbox: { title: "Ohbox" },
};
const bodyOf = (id: PaneId) =>
  function Body() {
    return <p>the {id} pane</p>;
  };
const ALL = Object.fromEntries(PANE_IDS.map((id) => [id, paneOf(id, { Body: bodyOf(id) })])) as SettingsPanes;
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "wide", Wide: ({ route }: PaneProps) => <p>at {route.place}</p> },
};

/** The way between sections as the mail's Settings hands it: the frame's own command, no link's section kept. */
function useBeside(): SettingsBeside {
  const { commands } = useFrame();
  return useMemo(() => ({ go: (pane) => commands.go({ place: "settings", sub: pane }), startAt: null }), [commands]);
}

function mount(at: string): FakeAddress {
  const address = fakeAddress(at);
  const settings = settingsPlace(ALL, useBeside);
  const made = madeOf(SETTINGS["W-m"]!, { address, window: fakeWindow("desktop"), places: { ohbox, settings } });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return address;
}
const menu = () => within(screen.getByRole("navigation", { name: settingsEn.settings.navAria }));
const press = (name: string) => fireEvent.click(menu().getByRole("button", { name }));
const activeNav = (): string =>
  menu()
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-current") === "page")
    ?.getAttribute("aria-label") ?? "";
const probe = () => screen.queryByText("the devices pane");

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the route carries the settings pane", () => {
  it("parses, canonicalizes and normalizes the settings segment like every other segment", () => {
    expect(routeOf("#/settings/devices")).toMatchObject({ place: "settings", sub: "devices" });
    expect(routeOf("#/settings/general")).toMatchObject({ place: "settings", sub: "general" });
    // BARE is a real spelling, not a default pane: null keeps the view's deep-link logic in charge.
    expect(routeOf("#/settings")).toMatchObject({ place: "settings", sub: null });
    // An unknown sub-path falls back to bare rather than 404ing…
    expect(routeOf("#/settings/bogus")).toMatchObject({ place: "settings", sub: null });
    // …and the bar is rewritten to the spelling that reproduces what is on screen.
    expect(mount("#/settings/bogus").read()).toBe("#/settings");
    cleanup();
    expect(mount("#/settings/devices").writes).toEqual([]);
    cleanup();
    expect(mount("#/settings").writes).toEqual([]);
    cleanup();
    // Round trips, both spellings.
    expect(fragmentOf(routeOf("#/settings/devices"))).toBe("#/settings/devices");
    expect(fragmentOf(routeOf("#/settings"))).toBe("#/settings");
  });

  it("goSettings always writes the NAMED form — a click is a decision, and bare would hand it back", () => {
    const address = mount("#/settings");
    press("Devices");
    expect(address.read()).toBe("#/settings/devices");
    press("General");
    expect(address.read()).toBe("#/settings/general");
  });
});

describe("the view follows the route, and clicks write it", () => {
  it("clicking a section writes the hash; a hash move (Back) brings the section back", () => {
    const address = mount("#/settings/devices");

    press("Tags");
    // The click wrote the ROUTE — one source — and the route came back down as the pane.
    expect(address.read()).toBe("#/settings/tags");
    expect(activeNav()).toBe("Tags");
    expect(probe()).toBeNull();

    // Back is a hash move to the previous entry; the section follows it.
    act(() => address.visit("#/settings/devices"));
    expect(activeNav()).toBe("Devices");
    expect(probe()).toBeTruthy();
  });
});
