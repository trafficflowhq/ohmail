/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import {
  PANE_GROUPS,
  PANE_IDS,
  type PaneId,
  type SettingsBeside,
  type SettingsPanes,
} from "../../../packages/app/src/settings/contract.js";
import { PANE_FACTS, paneOf } from "../../../packages/app/src/settings/facts.js";
import { settingsPlace } from "../../../packages/app/src/settings/place.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import settingsEn from "../../../packages/app/messages/settings.en.json" with { type: "json" };
import settingsDe from "../../../packages/app/messages/settings.de.json" with { type: "json" };
import menuEn from "../../../packages/app/messages/settings-menu.en.json" with { type: "json" };
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { madeOf, SETTINGS } from "../../../packages/app/test/settings/frame/hosts.js";

/**
 * ═══ SETTINGS ON A PHONE IS A LIST OF SECTIONS ════════════════════════════════════════
 *
 * DESIGN-FOLD-WIDTHS §5. Below 700px (the ladder's phone band) the bare `#/settings` is a list
 * of sections in three groups — Mail, Account, About — each row opening its section at its own
 * route; a routed section (`#/settings/<pane>`, a deep link included) stands alone, no tab row,
 * the topbar carrying "‹ Settings" and the section's name (`AppShell`, `shell-keys`). Sixteen
 * pills in a five-row cloud was the shape at 360 (LAYOUT-SWEEP, 2026-10-05).
 *
 * jsdom lays nothing out, so the width is the matchMedia answer: `(max-width: 699.98px)` true
 * is a phone. Mutation: make `listMode` constant false — the first describe goes red.
 *
 * RE-POINTED (the switch's older tests, sorted once): today's Settings view, its section list and its tab row leave
 * with the switch. Settings is the new frame's place (`settingsPlace`), drawn here by the place's own test door (the
 * frame over a fake host, `packages/app/test/settings/frame/hosts.ts`), a sentinel body for every section; the phone
 * is the fake window's phone room, the width the frame's own plan (one column), where today's was a matchMedia
 * answer. The section list is the menu (the navigation "Settings sections", its group headings, a button a section);
 * the tab row of two columns is that same menu beside the section that stands; a row's press and a caller's section
 * are the place's way between sections, which writes the frame's address (`#/settings/<id>`); the catalogue is the
 * app package's `settings` namespace. RETIRED HERE, each to a case of the new place seen green:
 *  - "a group with no wired pane is not listed": the place's "lists the setting's sections in their groups, and
 *    nothing a host withholds" (a setting with no Account section draws Mail and About and no Account heading; the
 *    phone's list is the same menu);
 *  - "a routed section stands alone: its cards, no tab row, no list": the place's "on a phone a section stands over
 *    the menu with the way back, and the dock gives way to it";
 *  - "a routed section this surface does not offer lands on the list, unrouted": the place's "an unknown or unlisted
 *    section shows General on two columns and the menu on one";
 *  - the two `?settings=<pane>` link cases: nothing reads that query now; the section is the address's fragment alone
 *    (the frame's route), which the consent return sets itself (`oauth-return-landing.test.tsx`, "completes the
 *    ceremony from a URL with NO fragment, and routes to Settings → Mailboxes"); on a phone that section stands with
 *    the way back (the place's phone case above) and on two columns beside the menu (the place's "on two columns
 *    draws the menu beside the section the route names, that entry the current page").
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

/** Settings in the frame at an address, in a room, over a setting of the host contract (the managed web: all three groups). */
function mount(at: string, room: "desktop" | "phone", setting = "W-m") {
  const address = fakeAddress(at);
  const beside: SettingsBeside = {
    startAt: null,
    go: (pane) => address.visit(pane === null ? "#/settings" : `#/settings/${pane}`),
  };
  const settings = settingsPlace(ALL, () => beside);
  const made = madeOf(SETTINGS[setting]!, { address, window: fakeWindow(room), places: { ohbox, settings } });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return { address, beside };
}
const list = () => screen.queryByRole("navigation", { name: settingsEn.settings.navAria });
const standing = () => screen.queryByText(/^the \w+ pane$/)?.textContent ?? null;

beforeEach(() => {
  try { localStorage.clear(); } catch { /* storage blocked */ }
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("below 700 the bare route is the section list", () => {
  it("renders the groups and their rows, no tab pill, one title", () => {
    // the managed web's sections: an Account and an About section wired, so all three groups have a member
    mount("#/settings", "phone");
    expect(standing(), "a section beside the list on a phone").toBeNull();
    const menu = within(list()!);
    const groups = menu
      .getAllByRole("heading")
      .map((g) => g.textContent)
      .filter((text) => text !== settingsEn.settings.title);
    expect(groups).toEqual([settingsEn.settings.groupMail, settingsEn.settings.groupAccount, settingsEn.settings.groupAbout]);
    const rows = menu.getAllByRole("button").map((r) => r.getAttribute("aria-label"));
    expect(rows.length).toBeGreaterThanOrEqual(4); // general, notifications, tags… — whatever this surface wires
    expect(rows).toContain(settingsEn.settings.general);
    expect(rows).toContain(settingsEn.settings.tags);
    expect(screen.getAllByRole("heading", { name: settingsEn.settings.title })).toHaveLength(1);
  });

  it("a row opens its section through the route (`onSelectPane`), the way the tab did", () => {
    const { address } = mount("#/settings", "phone");
    fireEvent.click(within(list()!).getByRole("button", { name: settingsEn.settings.notifications }));
    expect(address.read()).toBe("#/settings/notifications");
  });

  it("a caller's pane (the Screener's offer) is routed the same way on a phone", () => {
    const { address, beside } = mount("#/settings", "phone");
    act(() => beside.go("tags"));
    expect(address.read()).toBe("#/settings/tags");
    expect(standing()).toBe("the tags pane");
  });
});

describe("from 700 nothing changes: the tab row stands, no list", () => {
  it("the bare route renders the General pane with the tab row", () => {
    mount("#/settings", "desktop");
    expect(standing()).toBe("the general pane");
    expect(list(), "the tab row is gone at width").not.toBeNull();
  });
});

describe("the groups cover every pane and the catalogue carries both languages", () => {
  it("every PaneId is in exactly one group", () => {
    const seen = new Map<string, number>();
    for (const g of PANE_GROUPS) for (const p of PANE_IDS.filter((id) => PANE_FACTS[id].group === g)) seen.set(p, (seen.get(p) ?? 0) + 1);
    for (const id of PANE_IDS) expect(seen.get(id), `${id} is in no group or in two`).toBe(1);
  });
  it("the three group labels and the way back exist in en and de", () => {
    for (const k of ["groupMail", "groupAccount", "groupAbout", "back"] as const) {
      expect(typeof settingsEn.settings[k]).toBe("string");
      expect(typeof (settingsDe as typeof settingsEn).settings[k]).toBe("string");
    }
    expect((settingsDe as typeof settingsEn).settings.groupAccount).toBe("Account");
  });
});
