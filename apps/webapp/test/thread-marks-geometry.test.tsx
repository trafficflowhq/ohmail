import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EngineMessage } from "@ohmail/client-engine";
import { ThreadMarks } from "../app/shell/ThreadMarks";
import messages from "../messages/en.json";

/**
 * THE COLUMN OF SQUARES NEVER COVERS A MESSAGE — MEASURED IN A REAL ENGINE. jsdom lays nothing out,
 * so this drives headless Chromium over the real `ThreadMarks` markup and the real stylesheets: a
 * conversation of four panels in the reading column (the sheet at 390), at the widths the product
 * ships, in light and dark. The column's squares may not intersect any panel, stay inside the
 * scrollport, and cause no horizontal overflow. THE RED CONTROL draws the column in the panels'
 * own box instead of the gutter ({@link OVER_PANELS}): the same measurement then reads
 * intersections, or it proves nothing.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/message.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

/** The column drawn inside the panels' box: no gutter padding, the bar at the content's left edge. */
const OVER_PANELS = ".conv:has(> .thread-marks){padding-left:0}.tm-bar{right:auto;left:0}";

/** Viewport → the reading column's width there: the sheet on a phone, the column beside the list elsewhere. */
const WIDTHS: ReadonlyArray<[number, number]> = [[390, 390], [700, 300], [1024, 604], [1440, 1020]];

const member = (id: string, unread: boolean): EngineMessage => ({
  id, accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
  from: { name: `Sender ${id}`, address: `${id}@example.invalid` }, to: [], cc: [],
  date: "2026-10-22T09:00:00.000Z", folder: "INBOX", snippet: "", unread, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-22T09:00:00.000Z",
} as unknown as EngineMessage);
const MEMBERS = [member("p1", true), member("p2", true), member("p3", false), member("p4", true)];

const marks = renderToStaticMarkup(
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <ThreadMarks messages={MEMBERS} onEnter={() => {}} />
  </NextIntlClientProvider>,
);
const panel = (id: string): string =>
  `<article class="pm" data-conv-id="${id}"><div class="pm-in"><div class="msg-from"><b>Sender ${id}</b></div>` +
  `<div class="pm-body"><p class="msg-p">${"A line of the letter that runs on for a while. ".repeat(6)}</p></div></div></article>`;

const page_ = (col: number, theme: "light" | "dark", extra: string): string =>
  `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head>
   <body><div class="read-col" style="width:${col}px;height:700px">
   <div class="conv" data-thread-read="">${marks}${MEMBERS.map((m) => panel(m.id)).join("")}</div></div></body></html>`;

type Box = { left: number; right: number; top: number; bottom: number };
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

async function read(viewport: number, col: number, theme: "light" | "dark", extra = "") {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
  try {
    await page.setContent(page_(col, theme, extra));
    return await page.evaluate((narrowPx) => {
      // The component's own rule for its thin form, by the conversation's width.
      const conv = document.querySelector<HTMLElement>(".conv")!;
      const marks = document.querySelector<HTMLElement>(".thread-marks")!;
      if (conv.getBoundingClientRect().width < narrowPx) marks.setAttribute("data-narrow", "");
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const col = document.querySelector<HTMLElement>(".read-col")!;
      return {
        squares: [...document.querySelectorAll(".tm-mb")].map(box),
        bar: box(document.querySelector(".tm-bar")!),
        panels: [...document.querySelectorAll("article.pm")].map(box),
        col: box(col),
        overflow: col.scrollWidth - col.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, 560);
  } finally {
    await page.close();
  }
}

const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe("the column of squares stands beside the panels, over nothing", () => {
  for (const [viewport, col] of WIDTHS)
    for (const theme of ["light", "dark"] as const)
      it(`${viewport}px (a ${col}px column), ${theme}: no square on a panel, inside the scrollport, no overflow`, async () => {
        const r = await read(viewport, col, theme);
        expect(r.squares.length, "the column drew no squares").toBe(4);
        const hits = r.squares.flatMap((s, i) => r.panels.filter((p) => overlap(s, p)).map((_, j) => `square ${i} × panel ${j}`));
        expect(hits, "a square is drawn over a message").toEqual([]);
        expect(r.bar.left, "the column runs out of the scrollport's left edge").toBeGreaterThanOrEqual(r.col.left - 0.5);
        expect(r.bar.top).toBeGreaterThanOrEqual(r.col.top - 0.5);
        expect(r.overflow, "the column widens the scroller").toBeLessThanOrEqual(0);
        expect(r.pageOverflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
      }, 60_000);

  it("the ring switches at once: no transition on it, and only the square in view wears it", async () => {
    /* In WebKitGTK a ring fading out on a box hung outside its sticky parent was never
       repainted, so two to nine squares stayed ringed at once until hovered. The ring is a place,
       not news: it switches instantly (the reduced-motion arm, where no stale ring ever showed). */
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await page.setContent(page_(1020, "light", ""));
      const r = await page.evaluate(() => {
        const bs = [...document.querySelectorAll<HTMLElement>(".tm-mb")];
        bs[2]!.setAttribute("aria-current", "location");
        return bs.map((b) => {
          const after = getComputedStyle(b, "::after");
          return { duration: after.transitionDuration, opacity: after.opacity };
        });
      });
      expect(r.map((x) => x.duration), "a ring that fades can be left painted").toEqual(["0s", "0s", "0s", "0s"]);
      expect(r.map((x) => x.opacity), "one ring, on the square in view").toEqual(["0", "0", "1", "0"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("under reduced motion the ring still runs no transition at all", async () => {
    /* Reduced motion sets every transition's duration to .01ms (base.css). A ring with no
       transition of its own falls back to `all` there and gets a real, if tiny, opacity
       transition, which left up to eight stale rings in WebKitGTK 2.50 with animations turned
       off. The ring declares `transition: none`, so nothing runs under either preference. */
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
    try {
      await page.setContent(page_(1020, "light", ""));
      const r = await page.evaluate(() => {
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const bs = [...document.querySelectorAll<HTMLElement>(".tm-mb")];
        bs[1]!.setAttribute("aria-current", "location");
        return {
          reduced,
          rings: bs.map((b) => {
            const after = getComputedStyle(b, "::after");
            return { property: after.transitionProperty, opacity: after.opacity };
          }),
        };
      });
      expect(r.reduced, "the page is not under reduced motion: this arm proves nothing").toBe(true);
      expect(r.rings.map((x) => x.property), "a ring under reduced motion runs a transition").toEqual(["none", "none", "none", "none"]);
      expect(r.rings.map((x) => x.opacity), "one ring, on the square in view").toEqual(["0", "1", "0", "0"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("RED CONTROL: the column drawn in the panels' box lands on them, and the measurement says so", async () => {
    const r = await read(1440, 1020, "light", OVER_PANELS);
    const hits = r.squares.filter((s) => r.panels.some((p) => overlap(s, p)));
    expect(hits.length, "the control found no intersection: the measurement proves nothing").toBeGreaterThan(0);
  }, 60_000);
});
