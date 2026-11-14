import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ThreadMarksBar } from "../app/shell/ThreadMarks";
import messages from "../messages/en.json";

/**
 * A LETTER ANSWERED IN ITS READING STREAM, MEASURED IN A REAL ENGINE: the squares beside a conversation that opened in
 * place among a stream's cards, and a scrolled stream under its tile's top line (its control beside a scrolled
 * thread), over today's `ThreadMarks` markup and today's sheets in headless Chromium. These cases wait for the streams' mount (News, Receipts): it retires them
 * by their rows, their holders the new stream's own cases. Every other case of this file was sorted with the switch
 * (share reader-1): the conversation's squares beside the new reader are measured in a real browser by
 * `packages/app/test/states/squares-in-a-browser.test.ts`, the run's rule by `packages/ui/test/squares-window.test.ts`.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/avatar.css",
  "packages/ui/src/composites/row.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/reader.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");


const member = (id: string, unread: boolean): EngineMessage => ({
  id, accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
  from: { name: `Sender ${id}`, address: `${id}@example.invalid` }, to: [], cc: [],
  date: "2026-10-22T09:00:00.000Z", folder: "INBOX", snippet: "", unread, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-22T09:00:00.000Z",
} as unknown as EngineMessage);
const MEMBERS = [member("p1", true), member("p2", true), member("p3", false), member("p4", true)];

const panel = (id: string): string =>
  `<article class="pm" data-conv-id="${id}"><div class="pm-in"><div class="msg-from"><b>Sender ${id}</b></div>` +
  `<div class="pm-body"><p class="msg-p">${"A line of the letter that runs on for a while. ".repeat(6)}</p></div></div></article>`;


type Box = { left: number; right: number; top: number; bottom: number };
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

const split_ = (viewport: number, list: number, face: "ohmarchy" | "paper", extra = "", members = MEMBERS): string => {
  const bar = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ThreadMarksBar messages={members} here={null} tabStop={members.at(-1)!.id} onJump={() => {}} />
    </NextIntlClientProvider>,
  );
  return `<!doctype html><html data-theme="light"${face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8">
   <style>${SHEETS}${extra}</style><style>body{margin:0;font-family:system-ui,sans-serif}</style></head>
   <body><section class="view split" style="grid-template-columns:${list}px minmax(0,1fr);height:700px;margin:0 var(--gap-edge);width:calc(${viewport}px - 2 * var(--gap-edge))">
   <div class="list-col"></div><div class="thread-marks">${bar}</div><div class="read-col">
   <div class="conv" data-thread-read="">${members.map((m) => panel(m.id)).join("")}</div></div></section></body></html>`;
};

const FOCUSED = css("apps/webapp/app/shell/zone-cursor.css") + "html[data-face][data-theme]{--focus:#f0f}";
/** The columns of one painted row in a marker colour (each channel full or none), decoded in the engine. */
async function marked(page: Page, y: number, width: number, [r, g, b]: [number, number, number]): Promise<number[]> {
  const png = (await page.screenshot({ clip: { x: 0, y: Math.floor(y), width, height: 1 } })).toString("base64");
  return page.evaluate(async ([b64, want]) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g2 = new OffscreenCanvas(img.width, 1).getContext("2d")!;
    g2.drawImage(img, 0, 0);
    const d = g2.getImageData(0, 0, img.width, 1).data;
    const on = (v: number, w: number) => (w ? v > 200 : v < 80);
    return [...Array(img.width).keys()].filter((x) => want.every((w, i) => on(d[4 * x + i]!, w)));
  }, [png, [r, g, b]] as const);
}
const MAGENTA: [number, number, number] = [255, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

/**
 * THE SCROLLED READER STAYS UNDER ITS TILE'S TOP LINE (a tester on 0.30.8, ohmarchy look): the thread column
 * and the reading streams reclaim the deck's frame so paper scrolls to the window's edge; in ohmarchy
 * the text ran over the other tiles' top line up to the window border and the focus ring's top line
 * crossed it. Panels in a marker colour, scrolled under the top, read from the painted rows.
 */
describe("the scrolled reader stays under its tile's top line", () => {
  const thread = (face: "ohmarchy" | "paper", zone: boolean, squares = true): string => {
    const html = split_(1440, 634, face, css("packages/ui/src/composites/list-pane.css") + FOCUSED + ".pm{min-height:600px;background:#0f0!important}")
      .replace('data-theme="light"', `data-theme="dark"${zone ? ' data-zone="reader"' : ""}`).replace("margin:0 var(--gap-edge)", "margin:var(--gap-edge)");
    return squares ? html : html.replace(' data-thread-read=""', "");
  };
  const stream = (face: "ohmarchy" | "paper"): string =>
    `<!doctype html><html data-theme="dark"${face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8"><style>${SHEETS}${css("packages/ui/src/composites/stream.css")}</style>
     <style>body{margin:0}.stream{scroll-behavior:auto}</style></head><body><section class="view view-reads" style="height:700px;margin:var(--gap-edge)">
     <div class="stream" style="flex:1"><article class="scast" style="height:2400px;background:#0f0"></article></div></section></body></html>`;
  async function rows(html: string, scroller: string) {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await page.setContent(html);
      const m = await page.evaluate((sel) => {
        const col = document.querySelector<HTMLElement>(sel)!;
        col.scrollTop = 300;
        return { scrolled: col.scrollTop, top: document.querySelector(".view")!.getBoundingClientRect().top };
      }, scroller);
      expect(m.scrolled, "the column did not scroll: this proves nothing").toBe(300);
      return { above: await marked(page, m.top - 8, 1440, GREEN), ring: await marked(page, m.top - 1, 1440, MAGENTA), onRing: await marked(page, m.top - 1, 1440, GREEN) };
    } finally {
      await page.close();
    }
  }
  it("ohmarchy: a scrolled reading stream paints nothing above the tiles' top line", async () => {
    expect((await rows(stream("ohmarchy"), ".stream")).above).toEqual([]);
  }, 60_000);
  it("paper keeps scrolling to the window's edge, and the measurement sees it", async () => {
    expect((await rows(thread("paper", false), ".read-col")).above.length).toBeGreaterThan(400);
    expect((await rows(stream("paper"), ".stream")).above.length).toBeGreaterThan(400);
  }, 60_000);
});

/**
 * A LETTER ANSWERED IN ITS READING STREAM (`stream-in-place.tsx`): the card's element holds the
 * Ohbox's conversation, the squares in it on the split's seam (list | 12 | 18 | 12 | paper at the
 * desktop widths), the paper where it stands with one panel and with two, nothing clipped, and the
 * stream's other cards where they were. RED CONTROL: without the stream's reclaim the ring and the
 * paper's right edge are cut by the stream's own box.
 */
const NO_RECLAIM = ".view-reads .stream:has(> .scast.in-place){margin-left:0;margin-right:0;padding-left:12px;padding-right:12px;-webkit-mask-image:none;mask-image:none}";
/** Viewport, the list column (none on a phone) and where the view starts (past the nav rail). */
const STREAM_CASES: ReadonlyArray<[viewport: number, list: number, left: number]> = [[1440, 400, 250], [1024, 400, 250], [390, 0, 10]];
const card = (id: string): string =>
  `<article class="scast" data-sid="${id}"><div class="sc-head"><div class="sc-line"><b>Sender ${id}</b></div><h3>Issue ${id}</h3></div>` +
  `<div class="sc-clip"><p class="sc-body">${"A line of the letter. ".repeat(12)}</p></div></article>`;
const stream_ = (viewport: number, list: number, left: number, theme: "light" | "dark", panels: number, placed: boolean, extra = ""): string => {
  const members = MEMBERS.slice(0, panels);
  const bar = panels > 1 ? renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ThreadMarksBar messages={members} here={null} tabStop={members.at(-1)!.id} onJump={() => {}} />
    </NextIntlClientProvider>,
  ) : "";
  const inPlace = `<article class="scast in-place" data-sid="L"><div class="conv" data-stream="">` +
    (bar ? `<div class="thread-marks">${bar}</div>` : "") +
    `${members.map((m) => panel(m.id)).join("")}<div class="msg-actions"></div></div></article>`;
  return `<!doctype html><html data-theme="${theme}" data-face="ohmarchy"><head><meta charset="utf-8">
   <style>${SHEETS}${css("packages/ui/src/composites/stream.css")}${css("packages/ui/src/composites/list-pane.css")}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head>
   <body><section class="view split view-reads" style="grid-template-columns:${list ? `${list}px ` : ""}minmax(0,1fr);height:800px;margin-left:${left}px;width:${viewport - 2 * left + (list ? left - 12 : 0)}px">
   ${list ? '<div class="list-col"></div>' : ""}<div class="stream">${card("a")}${placed ? inPlace : card("L")}${card("b")}</div></section></body></html>`;
};

async function streamRead(viewport: number, list: number, left: number, theme: "light" | "dark", panels: number, placed = true, extra = "") {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
  try {
    await page.setContent(stream_(viewport, list, left, theme, panels, placed, extra));
    return await page.evaluate((narrowPx) => {
      // The component's own rule for its thin form, by the conversation's width.
      const conv = document.querySelector<HTMLElement>(".in-place .conv");
      const marks = document.querySelector<HTMLElement>(".in-place .thread-marks");
      if (conv && marks && conv.getBoundingClientRect().width < narrowPx) marks.setAttribute("data-narrow", "");
      const box = (el: Element | null): Box | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const stream = document.querySelector<HTMLElement>(".stream")!;
      const sq = document.querySelector(".tm-sq");
      const ring = sq ? sq.getBoundingClientRect().left + sq.getBoundingClientRect().width / 2 - 9 : null;
      return {
        stream: box(stream)!,
        list: box(document.querySelector(".list-col")),
        squares: [...document.querySelectorAll(".tm-mb")].map((b) => box(b)!),
        ring,
        panels: [...document.querySelectorAll(".in-place article.pm")].map((p) => box(p)!),
        resting: box(document.querySelector(".scast[data-sid='b']"))!,
        overflow: stream.scrollWidth - stream.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, 560);
  } finally {
    await page.close();
  }
}

describe("a letter answered in its reading stream", () => {
  for (const [viewport, list, left] of STREAM_CASES)
    for (const theme of ["light", "dark"] as const)
      it(`${viewport}px, ${theme}: the squares beside the panels, the ring whole, the paper still, the cards unmoved`, async () => {
        const two = await streamRead(viewport, list, left, theme, 2);
        const one = await streamRead(viewport, list, left, theme, 1);
        const rest = await streamRead(viewport, list, left, theme, 1, false);
        expect(two.squares, "the conversation drew no squares").toHaveLength(2);
        const hits = two.squares.flatMap((s, i) => two.panels.filter((p) => overlap(s, p)).map((_, j) => `square ${i} × panel ${j}`));
        expect(hits, "a square is drawn over a message").toEqual([]);
        expect(two.ring!, "the ring is cut by the stream's box").toBeGreaterThanOrEqual(two.stream.left - 0.5);
        expect(two.panels[0]!.right + 2, "the paper's ring is cut at the stream's right edge").toBeLessThanOrEqual(two.stream.right + 0.5);
        expect(two.panels[0]!.left, "the paper moved when the reply joined").toBeCloseTo(one.panels[0]!.left, 1);
        expect([two.resting.left, two.resting.right], "a resting card moved sideways").toEqual([rest.resting.left, rest.resting.right]);
        expect(two.overflow, "the stream scrolls sideways").toBeLessThanOrEqual(0);
        expect(two.pageOverflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
        if (viewport >= 1024) {
          // o9's seam, the Ohbox's: 10 from the list's ring and from the paper's to the 18px rail.
          expect(two.ring! - two.list!.right - 2, "list ring → rail").toBeCloseTo(10, 1);
          expect(two.panels[0]!.left - 2 - (two.ring! + 18), "rail → paper ring").toBeCloseTo(10, 1);
        }
      }, 60_000);

  it("at 1440 the paper stands where the Ohbox's does (x692, 736 wide), the cards where they stood (x736)", async () => {
    const r = await streamRead(1440, 400, 250, "light", 2);
    expect([r.panels[0]!.left, r.panels[0]!.right - r.panels[0]!.left], "the Ohbox's paper box").toEqual([692, 736]);
    expect(r.resting.left, "a resting card at today's x").toBe(736);
  }, 60_000);

  it("RED CONTROL: without the stream's reclaim the ring and the paper's edge are cut, and the measurement says so", async () => {
    const r = await streamRead(1440, 400, 250, "light", 2, true, NO_RECLAIM);
    expect(r.ring!, "the control found the ring whole: the measurement proves nothing").toBeLessThan(r.stream.left - 0.5);
    expect(r.panels[0]!.right + 2, "the control found the paper's ring whole").toBeGreaterThan(r.stream.right + 0.5);
  }, 60_000);
});
