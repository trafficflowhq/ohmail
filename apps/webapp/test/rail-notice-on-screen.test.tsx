import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RailNav, type RailGroup } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { setActiveCatalog } from "../app/shell/locale";
import { FoldersRailGroup } from "../app/shell/FoldersRailGroup";
import { GapLettersNotice } from "../app/shell/GapLettersNotice";
import { OrganizerNotice } from "../app/shell/OrganizerNotice";

/**
 * THE GAP OFFER IS ON SCREEN AT WIDTH (GAP-OFFER-OFF-SCREEN-UNDER-FOLDERS).
 *
 * At the rail's foot, under 20 folders, "File them by your rules?" stood at y 1325 in a rail whose
 * visible box ends at 784 (1280x800) or 884 (1440x900): nobody with folders saw File or Leave. The
 * slot now stands right under the piles, before Tags; nothing above it grows with the account.
 * Measured in Chromium over the shipped sheets, with the real rail, folder group and notices.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/chip.css",
  "packages/ui/src/primitives/text-field.css",
  "packages/ui/src/composites/rail.css",
  "packages/ui/src/composites/list-pane.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/shell/column-handles.css",
].map(css).join("\n");

const noop = async (): Promise<void> => {};
const TAGS = ["Family", "Invoices", "Travel", "Garden", "Kiln", "Tax 2026", "School", "Club", "Health", "House", "Car", "Bank"];
const OFFER = [{ id: "mb1", address: "a@x.example", count: 2 }];

interface Shape { tags: number; folders: number; gap: boolean; stopped?: boolean; empty?: boolean }

/** The shell's group shapes (`shell-keys.tsx` `railGroups`), with the rail's notice slot filled. */
function rail(o: Shape, locale: "en" | "de"): string {
  const folders = Array.from({ length: o.folders }, (_, i) => {
    const name = `Project ${String(i + 1).padStart(2, "0")}`;
    return { id: `f-mb1-${name}`, name, mailboxId: "mb1", mailbox: "a@x.example" };
  });
  const groups: RailGroup[] = [
    { items: [{ id: "ohbox", label: "Ohbox", hot: true, count: 4 }, { id: "reads", label: "News", count: 2 }, { id: "receipts", label: "Receipts" }] },
    { items: [{ id: "screener", label: "Screener", count: 3, hot: true }] },
    { items: [{ id: "triage", label: "Answer later", count: 1 }, { id: "triage-aside", label: "Set aside" }, { id: "triage-resurface", label: "Resurface" }] },
    {
      items: [],
      tags: {
        label: "Tags", defaultOpen: true,
        items: TAGS.slice(0, o.tags).map((n, i) => ({ id: `t${i}`, label: n, hue: "moss" as const, count: 1 })),
        create: { label: "New tag", placeholder: "Tag name", emptyHint: "No tags yet", onCreate: () => {} },
      },
    },
    ...(o.folders > 0 ? [{
      items: [],
      custom: h(FoldersRailGroup, {
        folders, unread: new Map(), mailboxCount: 1, accountMailboxes: [{ id: "mb1", label: "a@x.example" }],
        verbs: { create: noop, rename: noop, remove: noop, dismiss: () => {}, summary: async () => null },
        junkSaid: { named: "Junk" }, junkReadable: true, onNavigate: () => {},
      } as never),
    }] : []),
    { items: [{ id: "history", label: "History" }, { id: "search", label: "Search", kbdHint: "/" }, { id: "drafts", label: "Drafts" }, { id: "settings", label: "Settings" }] },
  ];
  const stopped = [{ id: "mb2", address: "b@x.example", kind: "stopped" as const, name: "Kitchen Mac", at: "2026-10-20T10:00:00Z", order: 1 }];
  const notice = o.gap || o.stopped || o.empty
    ? h(React.Fragment, null,
      o.stopped ? h(OrganizerNotice, { notices: stopped, onAcknowledge: noop, variant: "rail" } as never) : null,
      o.gap ? h(GapLettersNotice, { offers: OFFER, onAnswer: noop, variant: "rail" }) : null,
      o.empty ? h(GapLettersNotice, { offers: [], onAnswer: noop, variant: "rail" }) : null)
    : undefined;
  setActiveCatalog(locale, locale === "en" ? null : (de as never));
  try {
    return renderToStaticMarkup(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(React.Fragment, null,
        // The shell's narrow-width copy stands before the topbar, as `AppShell` renders it.
        o.gap ? h(GapLettersNotice, { offers: OFFER, onAnswer: noop, variant: "shell" }) : null,
        h("div", { className: "topbar" }, h("b", null, "Ohbox")),
        h("div", { className: "deck" },
          h(RailNav, {
            onCompose: () => {}, composeLabel: "Compose", mailboxesLabel: "Mailboxes", ariaLabel: "Main", id: "shell-rail",
            groups, activeId: "ohbox", mailboxes: [{ name: "a@x.example", hint: "imap" }], notice,
            sync: h("button", { type: "button", className: "ritem rail-pull" }, "Pull new mail"),
            dock: h(React.Fragment, null,
              h("button", { type: "button", className: "ritem dock-cmd" }, "Command"),
              h("button", { type: "button", className: "ritem dock-theme", "aria-label": "Theme" }, "o")),
            footer: h("span", null, "Get ohmail for desktop"),
          }),
          h("main", { className: "stage" }, h("section", { className: "view split view-ohbox" }, h("div", { className: "list-col" })))),
      ),
    } as never));
  } finally {
    setActiveCatalog("en", null);
  }
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

interface Box { top: number; bottom: number }
interface Reading {
  visible: Box; client: number; scroll: number;
  gap: Box | null; verbs: Box[]; slotDisplay: string | null;
  shell: (Box & { display: string }) | null;
  tags: number; slot: Box | null; piles: Box; mail: number; innerBottom: number;
}

interface Opts { width: number; height: number; locale?: "en" | "de"; face?: "paper" | "ohmarchy"; touch?: boolean; toFoot?: boolean }

async function open(shape: Shape, o: Opts) {
  const ctx = await browser!.newContext({
    viewport: { width: o.width, height: o.height }, hasTouch: o.touch ?? false, isMobile: o.touch ?? false, deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html${o.face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${SHEETS}</style>
    <style>html,body{margin:0;height:100%}</style></head>
    <body class="mo-canvas"><div class="app-root"><div class="shell">${rail(shape, o.locale ?? "en")}</div></div></body></html>`);
  if (o.toFoot) {
    // The negative control: the slot carried back to the foot, where main drew it.
    await page.evaluate(() => {
      const nav = document.querySelector("nav.rail")!;
      nav.insertBefore(nav.querySelector(".rail-notice-slot")!, nav.querySelector(".rail-sync-slot"));
    });
  }
  return { ctx, page };
}

async function measure(shape: Shape, o: Opts): Promise<Reading> {
  const { ctx, page } = await open(shape, o);
  try {
    return await page.evaluate(() => {
      const box = (e: Element | null): Box | null => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      };
      const nav = document.querySelector("nav.rail") as HTMLElement;
      nav.scrollTop = 0;
      const nr = nav.getBoundingClientRect();
      const cs = getComputedStyle(nav);
      const slot = nav.querySelector(".rail-notice-slot");
      const shell = document.querySelector('.notice-shell[data-state="gap"]');
      const tagsGroup = nav.querySelector(".rgroup.rsub")!.parentElement!;
      return {
        visible: { top: Math.round(nr.top), bottom: Math.round(nr.top + nav.clientHeight) },
        client: nav.clientHeight, scroll: nav.scrollHeight,
        gap: box(nav.querySelector('[data-state="gap"]')),
        verbs: [...nav.querySelectorAll('[data-state="gap"] .rn-verbs button')].map((b) => box(b)!),
        slotDisplay: slot ? getComputedStyle(slot).display : null,
        shell: shell ? { ...box(shell)!, display: getComputedStyle(shell).display } : null,
        tags: Math.round(tagsGroup.getBoundingClientRect().top),
        slot: box(slot),
        piles: box(nav.querySelector('[data-rail-id="triage-resurface"]')!.parentElement)!,
        mail: Math.round(nav.querySelector(".rail-mail")!.getBoundingClientRect().bottom),
        innerBottom: Math.round(nr.bottom - parseFloat(cs.paddingBottom)),
      };
    });
  } finally {
    await ctx.close();
  }
}

const inside = (b: Box, v: Box): boolean => b.top >= v.top - 1 && b.bottom <= v.bottom + 1;

const CELLS: Array<{ name: string } & Opts> = [
  { name: "1280x800 paper", width: 1280, height: 800 },
  { name: "1440x900 paper", width: 1440, height: 900 },
  { name: "1280x800 German", width: 1280, height: 800, locale: "de" },
  { name: "1440x900 ohmarchy", width: 1440, height: 900, face: "ohmarchy" },
];

describe("the gap offer stands inside the rail's visible box at scrollTop 0", () => {
  for (const cell of CELLS) {
    for (const tags of [3, 12]) {
      it(`${cell.name}, ${tags} tags, 20 folders`, async () => {
        const m = await measure({ tags, folders: 20, gap: true }, cell);
        expect(m.scroll - m.client, "premise: the rail must scroll for this test to mean anything").toBeGreaterThan(300);
        expect(m.slotDisplay).not.toBe("none");
        expect(m.gap, "no gap offer in the rail").not.toBeNull();
        expect(inside(m.gap!, m.visible), `the offer at ${m.gap!.top}-${m.gap!.bottom}, visible ${m.visible.top}-${m.visible.bottom}`).toBe(true);
        expect(m.verbs).toHaveLength(2);
        for (const v of m.verbs) expect(inside(v, m.visible), `a verb at ${v.top}-${v.bottom}`).toBe(true);
      });
    }
  }

  it("under a stopped notice, 1280x800: the offer is still on screen", async () => {
    const m = await measure({ tags: 12, folders: 20, gap: true, stopped: true }, { width: 1280, height: 800 });
    expect(inside(m.gap!, m.visible)).toBe(true);
  });

  it("negative control: the same page with the slot at the rail's foot reads off screen", async () => {
    const m = await measure({ tags: 3, folders: 20, gap: true }, { width: 1440, height: 900, toFoot: true });
    expect(m.gap!.top).toBeGreaterThan(m.visible.bottom);
  });
});

describe("the slot's place and spacing", () => {
  it("an empty slot moves nothing: Tags sits where it sits with no notice", async () => {
    const none = await measure({ tags: 3, folders: 20, gap: false }, { width: 1440, height: 900 });
    const empty = await measure({ tags: 3, folders: 20, gap: false, empty: true }, { width: 1440, height: 900 });
    expect(empty.slot, "the empty case did not render a slot").not.toBeNull();
    expect(empty.tags).toBe(none.tags);
  });

  it("a tall window: the foot stays welded to the bottom and the slot follows the piles", async () => {
    const m = await measure({ tags: 3, folders: 0, gap: true }, { width: 1440, height: 1300 });
    expect(m.scroll, "premise: nothing scrolls in the tall window").toBeLessThanOrEqual(m.client);
    expect(Math.abs(m.mail - m.innerBottom), `account line at ${m.mail}, rail inner bottom ${m.innerBottom}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.slot!.top - (m.piles.bottom + 14)), `slot at ${m.slot!.top}, piles end ${m.piles.bottom}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.tags - (m.slot!.bottom + 14)), `Tags at ${m.tags}, slot ends ${m.slot!.bottom}`).toBeLessThanOrEqual(1);
  });

  it("390x844 touch: the rail slot is hidden and the shell copy is on screen", async () => {
    const m = await measure({ tags: 3, folders: 20, gap: true }, { width: 390, height: 844, touch: true });
    expect(m.slotDisplay).toBe("none");
    expect(m.shell, "no shell copy").not.toBeNull();
    expect(m.shell!.display).not.toBe("none");
    expect(inside(m.shell!, { top: 0, bottom: 844 }), `shell copy at ${m.shell!.top}-${m.shell!.bottom}`).toBe(true);
  });
});

describe("File and Leave by keyboard", () => {
  it("Tab from Compose reaches File, then Leave, before the Tags toggle", async () => {
    const { ctx, page } = await open({ tags: 3, folders: 20, gap: true }, { width: 1440, height: 900 });
    try {
      await page.focus(".compose-cta");
      const seq: string[] = [];
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press("Tab");
        const at = await page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null;
          if (!a || a === document.body) return null;
          if (a.closest('[data-state="gap"]')) return a === a.parentElement!.firstElementChild ? "FILE" : "LEAVE";
          if (a.classList.contains("rlabel-toggle")) return "TAGS";
          return a.textContent?.trim().slice(0, 18) ?? a.tagName;
        });
        if (at === null) break;
        seq.push(at);
        if (at === "TAGS") break;
      }
      const file = seq.indexOf("FILE");
      expect(file, `Tab order: ${seq.join(" | ")}`).toBeGreaterThanOrEqual(0);
      expect(file, "File is not the first stop after the piles").toBeLessThanOrEqual(8);
      expect(seq[file + 1]).toBe("LEAVE");
      expect(seq[file + 2]).toBe("TAGS");
    } finally {
      await ctx.close();
    }
  });
});
