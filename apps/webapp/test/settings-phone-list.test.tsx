/** @vitest-environment jsdom */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { SettingsView, SETTINGS_GROUPS } from "../app/views/SettingsView";
import { PANE_IDS, type PaneId } from "../app/shell/routing";

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
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

/** The view's required props, as `settings-account-layout.test.tsx` mounts it. */
const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

function phone(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: matches && /max-width:\s*(699\.98|1023\.98)px/.test(query) && !/min-width/.test(query),
      media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }),
  });
}

async function mount(extra: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const props: Parameters<typeof SettingsView>[0] = { ...BASE, ...extra };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  try { localStorage.clear(); } catch { /* storage blocked */ }
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe("below 700 the bare route is the section list", () => {
  it("renders the groups and their rows, no tab pill, one title", async () => {
    phone(true);
    // an Account and an About section wired, so all three groups have a member
    await mount({ accountSection: h("div", null, "account"), aboutSection: h("div", null, "about") });
    expect(host.querySelector(".set-nav"), "a tab row on a phone").toBeNull();
    const list = host.querySelector(".set-list")!;
    expect(list, "no section list").not.toBeNull();
    const groups = [...list.querySelectorAll(".grouplabel")].map((g) => g.textContent);
    expect(groups).toEqual([messages.settings.groupMail, messages.settings.groupAccount, messages.settings.groupAbout]);
    const rows = [...list.querySelectorAll<HTMLElement>("button.set-row")];
    expect(rows.length).toBeGreaterThanOrEqual(4); // general, notifications, tags… — whatever this surface wires
    expect(rows.map((r) => r.dataset.pane)).toContain("general");
    expect(rows.map((r) => r.dataset.pane)).toContain("tags");
    expect(host.querySelectorAll("h1")).toHaveLength(1);
  });

  it("a group with no wired pane is not listed — the groups are membership over this surface's panes", async () => {
    phone(true);
    await mount();
    const groups = [...host.querySelectorAll(".set-list .grouplabel")].map((g) => g.textContent);
    expect(groups).toEqual([messages.settings.groupMail]);
  });

  it("a row opens its section through the route (`onSelectPane`), the way the tab did", async () => {
    phone(true);
    const picked: PaneId[] = [];
    await mount({ onSelectPane: (p) => picked.push(p) });
    const row = host.querySelector<HTMLButtonElement>('button.set-row[data-pane="notifications"]')!;
    await act(async () => { row.click(); });
    expect(picked).toEqual(["notifications"]);
  });

  it("a routed section stands alone: its cards, no tab row, no list", async () => {
    phone(true);
    await mount({ pane: "notifications" });
    expect(host.querySelector(".set-list")).toBeNull();
    expect(host.querySelector(".set-nav")).toBeNull();
    expect(host.querySelector(".set-pane-col"), "the section's own column is missing").not.toBeNull();
  });

  it("a `?settings=<pane>` link on a phone becomes the routed section, and the query leaves the URL (H1)", async () => {
    /* The away notice's link and the consent return write the query and keep it; read once it had left
       one pane standing with no list, no tab row and no back control. Routed, the shell's topbar
       carries "‹ Settings" and Back is the list. */
    phone(true);
    window.history.replaceState(null, "", "/?settings=notifications#/settings");
    const picked: PaneId[] = [];
    const searchAtCall: string[] = [];
    /* THE ORDER IS THE FACT: the route moves FIRST and the query is dropped after, so the URL the
       app router adopts from the drop already carries the section's hash. Dropped first, the router
       adopted `/demo#/settings` and repaired the hash change back to it on the built page — the
       person landed on the list. The stub records the URL's search at the moment it is called. */
    await mount({ onSelectPane: (p) => { picked.push(p); searchAtCall.push(window.location.search); window.location.hash = `#/settings/${p}`; } });
    expect(picked, "the query was not routed").toEqual(["notifications"]);
    expect(searchAtCall, "the query was dropped BEFORE the route moved").toEqual(["?settings=notifications"]);
    expect(new URL(window.location.href).searchParams.get("settings"), "the query stayed in the URL").toBeNull();
    expect(window.location.hash, "the query drop lost the routed hash").toBe("#/settings/notifications");
  });

  it("a caller's pane (the Screener's offer) is routed the same way on a phone", async () => {
    phone(true);
    const picked: PaneId[] = [];
    await mount({ initialPane: "tags", onSelectPane: (p) => picked.push(p) });
    expect(picked).toEqual(["tags"]);
  });

  it("a routed section this surface does not offer lands on the list, unrouted", async () => {
    phone(true);
    const picked: PaneId[] = [];
    await mount({ pane: "signatures", onSelectPane: (p) => picked.push(p) });
    expect(host.querySelector(".set-list"), "no list for an unknown section").not.toBeNull();
    expect(picked).toEqual([]);
  });

  it("from 700 a `?settings=<pane>` link is left alone: the pane beside the tab row, as before", async () => {
    phone(false);
    window.history.replaceState(null, "", "/?settings=notifications#/settings");
    const picked: PaneId[] = [];
    await mount({ onSelectPane: (p) => picked.push(p) });
    expect(picked).toEqual([]);
    expect(new URL(window.location.href).searchParams.get("settings")).toBe("notifications");
    expect(host.querySelector(".set-nav")).not.toBeNull();
  });
});

describe("from 700 nothing changes: the tab row stands, no list", () => {
  it("the bare route renders the General pane with the tab row", async () => {
    phone(false);
    await mount();
    expect(host.querySelector(".set-list")).toBeNull();
    expect(host.querySelector(".set-nav"), "the tab row is gone at width").not.toBeNull();
  });
});

describe("the groups cover every pane and the catalogue carries both languages", () => {
  it("every PaneId is in exactly one group", () => {
    const seen = new Map<string, number>();
    for (const g of SETTINGS_GROUPS) for (const p of g.panes) seen.set(p, (seen.get(p) ?? 0) + 1);
    for (const id of PANE_IDS) expect(seen.get(id), `${id} is in no group or in two`).toBe(1);
  });
  it("the three group labels and the way back exist in en and de", () => {
    for (const k of ["groupMail", "groupAccount", "groupAbout", "back"] as const) {
      expect(typeof messages.settings[k]).toBe("string");
      expect(typeof (de as typeof messages).settings[k]).toBe("string");
    }
    expect((de as typeof messages).settings.groupAccount).toBe("Account");
  });
});
