import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadWalk, type EngineMessage } from "@ohmail/client-engine";
import { MessageRow } from "@ohmail/ui";
import { ThreadMarksBar, ThreadTip, tipAt, type TipPlace } from "../app/shell/ThreadMarks";
import messages from "../messages/en.json";

/**
 * THE COLUMN OF SQUARES NEVER COVERS A MESSAGE — MEASURED IN A REAL ENGINE. jsdom lays nothing out,
 * so this drives headless Chromium over the real `ThreadMarks` markup and the real stylesheets: a
 * conversation of four panels in the reading column, the column of squares beside it in the split
 * view as `ThreadMarks` places it, and in the reader sheet's conversation, at the widths the product ships, in light and
 * dark. The column's squares may not intersect any panel, stay inside the scrollport, cause no
 * horizontal overflow, and stand still while the column scrolls. THE RED CONTROL draws the column
 * in the panels' own box instead of the gutter ({@link OVER_PANELS}): the same measurement then
 * reads intersections, or it proves nothing.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/row.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/reader.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

/** The column drawn inside the panels' box: no gutter padding, the bar at the content's left edge. */
const OVER_PANELS = ".view.split > .read-col > .conv[data-thread-read]{padding-left:0}";

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
    <ThreadMarksBar messages={MEMBERS} here={null} tabStop="p4" onJump={() => {}} />
  </NextIntlClientProvider>,
);
const panel = (id: string): string =>
  `<article class="pm" data-conv-id="${id}"><div class="pm-in"><div class="msg-from"><b>Sender ${id}</b></div>` +
  `<div class="pm-body"><p class="msg-p">${"A line of the letter that runs on for a while. ".repeat(6)}</p></div></div></article>`;

const page_ = (viewport: number, col: number, theme: "light" | "dark", extra: string): string =>
  `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head>
   <body><section class="view split" style="grid-template-columns:${col - 16}px;height:700px;margin-left:${viewport - col}px">
   <div class="thread-marks">${marks}</div><div class="read-col">
   <div class="conv" data-thread-read="">${MEMBERS.map((m) => panel(m.id)).join("")}</div></div></section></body></html>`;

type Box = { left: number; right: number; top: number; bottom: number };
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

async function read(viewport: number, col: number, theme: "light" | "dark", extra = "") {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
  try {
    await page.setContent(page_(viewport, col, theme, extra));
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

  it("the squares stand still while the conversation scrolls, and stay beside the panels", async () => {
    /* Owner report, desktop: the squares jumped for a frame while the column scrolled — WebKitGTK
       moved them, sticky inside the scroller, apart from the scroll. They are not in it now. */
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await page.setContent(page_(1440, 1020, "dark", ".pm{min-height:600px}"));
      const r = await page.evaluate(() => {
        const col = document.querySelector<HTMLElement>(".read-col")!;
        const top = (): number[] => [...document.querySelectorAll(".tm-mb")].map((b) => b.getBoundingClientRect().top);
        const before = top();
        col.scrollTop = 900;
        const panels = [...document.querySelectorAll("article.pm")].map((p) => p.getBoundingClientRect());
        const squares = [...document.querySelectorAll(".tm-mb")].map((b) => b.getBoundingClientRect());
        const over = squares.some((q) => panels.some((p) => q.left < p.right - 0.5 && p.left < q.right - 0.5 && q.top < p.bottom - 0.5 && p.top < q.bottom - 0.5));
        return { scrolled: col.scrollTop, before, after: top(), inScroller: col.contains(document.querySelector(".tm-bar")), over };
      });
      expect(r.scrolled, "the column did not scroll: this proves nothing").toBeGreaterThan(800);
      expect(r.inScroller).toBe(false);
      expect(r.after, "a square moved with the scroll").toEqual(r.before);
      expect(r.over, "a scrolled panel runs under a square").toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const viewport of [390, 1280])
    it(`in the reader sheet at ${viewport}px the squares stand beside the conversation, on top, before and after a scroll`, async () => {
      /* Review finding: the sheet's scroller is `.reader`, which is no split view; the box stood
         beside it at the window's corner, under the opaque sheet, and a press closed the sheet. */
      const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
      try {
        await page.setContent(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${SHEETS}.pm{min-height:500px}</style>
          <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div class="app-root">
          <div class="reader" role="dialog"><button type="button" class="reader-close">back</button>
          <div class="conv" data-thread-read=""><div class="thread-marks"${viewport < 560 ? " data-narrow" : ""}>${marks}</div>
          ${MEMBERS.map((m) => panel(m.id)).join("")}</div></div></div></body></html>`);
        const r = await page.evaluate(() => {
          const sheet = document.querySelector<HTMLElement>(".reader")!;
          const look = () => {
            const q = document.querySelector(".tm-mb")!.getBoundingClientRect();
            const p = document.querySelector("article.pm")!.getBoundingClientRect();
            const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
            return { top: q.top, onTop: !!hit?.closest(".tm-mb"), beside: q.right <= p.left + 0.5, inSheet: q.left >= 0 && q.top >= 0 };
          };
          const before = look();
          sheet.scrollTop = 600;
          return { scrolled: sheet.scrollTop, before, after: look() };
        });
        expect(r.scrolled, "the sheet did not scroll: this proves nothing").toBeGreaterThan(500);
        for (const at of [r.before, r.after]) {
          expect(at.onTop, "the square is under something").toBe(true);
          expect(at.beside, "the square is not beside the conversation").toBe(true);
          expect(at.inSheet).toBe(true);
        }
        expect(r.after.top, "the squares scrolled away with the sheet").toBe(r.before.top);
      } finally {
        await page.close();
      }
    }, 60_000);

  it("the ring switches at once: no transition on it, and only the square in view wears it", async () => {
    /* In WebKitGTK a ring fading out on a box hung outside its sticky parent was never
       repainted, so two to nine squares stayed ringed at once until hovered. The ring is a place,
       not news: it switches instantly (the reduced-motion arm, where no stale ring ever showed). */
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await page.setContent(page_(1440, 1020, "light", ""));
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
      await page.setContent(page_(1440, 1020, "light", ""));
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

/**
 * THE EVEN SEAM (owner 2026-10-24, o9): "the gap must be more even between the list and the viewer
 * column". The column of squares is an 18px rail standing one tile gap from the list's edge and one
 * from the paper — 10 | 18 | 10 in ohmarchy, 16 | 18 | 16 in paper — at every split width, its
 * press area starting at the reading track (the gap beside the list is the column handle's), its
 * corners from the radius tokens (square in ohmarchy). Measured over a real split: the list column,
 * the column of squares where `ThreadMarks` puts it, and the reading column.
 */
const SPLITS: ReadonlyArray<[viewport: number, list: number]> = [[1440, 634], [1100, 634], [900, 334]];
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

async function seam(viewport: number, list: number, face: "ohmarchy" | "paper") {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
  try {
    await page.setContent(split_(viewport, list, face));
    return await page.evaluate((narrowPx) => {
      const conv = document.querySelector<HTMLElement>(".conv")!;
      const marks = document.querySelector<HTMLElement>(".thread-marks")!;
      if (conv.getBoundingClientRect().width < narrowPx) marks.setAttribute("data-narrow", "");
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const sq = r(".tm-sq");
      const mb = document.querySelector<HTMLElement>(".tm-mb")!;
      return {
        narrow: marks.hasAttribute("data-narrow"),
        gap: parseFloat(getComputedStyle(document.querySelector(".view.split")!).columnGap),
        listRight: r(".list-col").right,
        barLeft: r(".tm-bar").left,
        barRight: r(".tm-bar").right,
        centre: sq.left + sq.width / 2,
        rail: parseFloat(getComputedStyle(mb).gridTemplateColumns.split(" ")[0] ?? ""),
        slot: mb.getBoundingClientRect().height,
        paper: r("article.pm").left,
        corner: getComputedStyle(document.querySelector(".tm-sq")!).borderTopLeftRadius,
        ringCorner: getComputedStyle(mb, "::after").borderTopLeftRadius,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, 560);
  } finally {
    await page.close();
  }
}

describe("the seam: list | gap | 18px rail | gap | paper, even in both faces", () => {
  for (const face of ["ohmarchy", "paper"] as const)
    for (const [viewport, list] of SPLITS)
      it(`${face} at ${viewport}px: the rail stands one gap from the list and one from the paper`, async () => {
        const m = await seam(viewport, list, face);
        expect(m.gap, "the face's tile gap").toBe(face === "ohmarchy" ? 10 : 16);
        expect(m.narrow, "the conversation's form at this width").toBe(viewport !== 1440);
        expect(m.rail, "the rail is as wide as the ring").toBe(18);
        const railLeft = m.centre - 9;
        const railRight = m.centre + 9;
        expect(railLeft - m.listRight, "list edge → rail").toBeCloseTo(m.gap, 1);
        expect(m.paper - railRight, "rail → paper").toBeCloseTo(m.gap, 1);
        expect(m.barLeft, "the press area covers the column handle's gap").toBeGreaterThanOrEqual(m.listRight + m.gap - 0.5);
        expect(m.barRight, "the press area ends at the paper").toBeLessThanOrEqual(m.paper + 0.5);
        expect(m.slot, "a slot's pitch").toBe(m.narrow ? 30 : 24);
        expect(m.corner, "a square's corner from the radius token").toBe(face === "ohmarchy" ? "0px" : "2px");
        expect(m.ringCorner, "the ring's corner").toBe(face === "ohmarchy" ? "0px" : "4px");
        expect(m.pageOverflow).toBeLessThanOrEqual(0);
      }, 60_000);
});

describe("the walk over a laid-out thread", () => {
  it("measured in the engine: the first at the top, the one-line last at the end, never a step back, a press lands on the line", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } });
    const many = Array.from({ length: 9 }, (_, i) => member(`w${i}`, i % 2 === 0));
    try {
      await page.setContent(split_(1440, 634, "ohmarchy", `[data-conv-id="w0"] .pm-body{height:20px;overflow:hidden}
        [data-conv-id="w8"] .pm-body{height:20px;overflow:hidden}[data-conv-id="w4"] .pm-body{min-height:900px}`, many));
      const geo = await page.evaluate(() => {
        const sc = document.querySelector<HTMLElement>(".read-col")!;
        const top0 = sc.getBoundingClientRect().top;
        const tops = [...sc.querySelectorAll<HTMLElement>("[data-conv-id]")].map((p) => p.getBoundingClientRect().top - top0 + sc.scrollTop);
        return { tops, max: sc.scrollHeight - sc.clientHeight, view: sc.clientHeight };
      });
      expect(geo.max, "the thread does not scroll: this proves nothing").toBeGreaterThan(geo.view);
      const walk = threadWalk({ ...geo, opened: 8 });
      expect(walk.current(0)).toBe(0);
      expect(walk.current(geo.max), "the short last message at the very end").toBe(8);
      const seen: number[] = [];
      for (let s = 0; s <= geo.max; s += 1) seen.push(walk.current(s));
      expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!), "a step back on a scroll down").toBe(true);
      expect(new Set(seen).size, "every message is current on the way").toBe(9);
      for (let k = 1; k < 8; k++) {
        const s = walk.scrollFor(k);
        const at = await page.evaluate(([s, k]) => {
          const sc = document.querySelector<HTMLElement>(".read-col")!;
          sc.scrollTop = s!;
          const p = sc.querySelectorAll<HTMLElement>("[data-conv-id]")[k!]!;
          return { scroll: sc.scrollTop, top: p.getBoundingClientRect().top - sc.getBoundingClientRect().top };
        }, [s, k]);
        expect(at.scroll, `the engine took the press's scroll for ${k}`).toBeCloseTo(s, 0);
        expect(walk.current(at.scroll), `a press on ${k} rings it`).toBe(k);
        expect(at.top, `${k}'s top on the line`).toBeLessThanOrEqual(walk.lineAt(at.scroll) + 1);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("the open row's strip", () => {
  it("stands under the row inside the list column, the row's own 8px squares step aside, a long thread scrolls sideways", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => member(`q${i}`, i > 25));
    const strip = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <div className="list-col" style={{ width: 400 }}>
          <MessageRow id="q29" from="Lena" subject="Q3 plan" time="09:12" preview="the words" unread
            marks={thirty.map((m) => (m.unread ? "unread" : "read"))} marksLabel="30 messages"
            follow={<ThreadMarksBar axis="x" messages={thirty} here="q12" tabStop="q12" onJump={() => {}} />} />
          <MessageRow id="z1" from="Bo" subject="Other" time="08:00" preview="more words"
            marks={["read", "unread"]} marksLabel="2 messages" follow={null} />
        </div>
      </NextIntlClientProvider>,
    );
    const page = await browser!.newPage({ viewport: { width: 900, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html data-theme="light" data-face="ohmarchy"><head><meta charset="utf-8"><style>${SHEETS}</style>
        <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${strip}</body></html>`);
      const m = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".list-col")!;
        const bar = document.querySelector<HTMLElement>(".row-follow .tm-strip")!;
        const b = bar.querySelector<HTMLElement>(".tm-mb")!.getBoundingClientRect();
        const marks = [...document.querySelectorAll<HTMLElement>(".row-marks")].map((el) => getComputedStyle(el).display);
        return {
          orientation: bar.getAttribute("aria-orientation"),
          marks,
          strip: bar.getBoundingClientRect(),
          list: list.getBoundingClientRect(),
          button: { w: b.width, h: b.height },
          sideways: bar.scrollWidth > bar.clientWidth,
          listOverflow: list.scrollWidth - list.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(m.orientation).toBe("horizontal");
      expect(m.marks, "the open row's 8px squares hide under the strip; a row with an empty follower keeps its own").toEqual(["none", "flex"]);
      expect(m.strip.right, "the strip stays in the list column").toBeLessThanOrEqual(m.list.right + 0.5);
      expect(m.button.h, "a square's button").toBe(20);
      expect(m.button.w).toBeGreaterThanOrEqual(16);
      expect(m.sideways, "thirty squares scroll sideways").toBe(true);
      expect(m.listOverflow, "the strip widens the list").toBeLessThanOrEqual(0);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

/**
 * THE CHIP (o9): a square the pointer rests on names its message — sender and stamp — in one fixed
 * box placed by `tipAt`. Beside the reader its right edge stands 6px before the rail, over the
 * list's gap and the open row's end, never over message text; under the row's strip it stays inside
 * the list column. Measured with the real stylesheets: the chip's own box, where `tipAt` puts it.
 */
const chipMarkup = (m: EngineMessage, place: TipPlace): string => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <ThreadTip m={m} place={place} now={new Date("2026-10-24T12:00:00.000Z")} />
  </NextIntlClientProvider>,
);
type R = { left: number; right: number; top: number; bottom: number; width: number; height: number };

describe("the chip names a square, beside the rail or under the strip, over no message", () => {
  for (const face of ["ohmarchy", "paper"] as const)
    for (const [viewport, list] of [[1440, 634], [1100, 634]] as const)
      it(`${face} at ${viewport}px: the chip's right edge 6px before the rail, on the square's line, over no panel`, async () => {
        const page = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
        try {
          await page.setContent(split_(viewport, list, face));
          await page.evaluate((html) => { document.body.insertAdjacentHTML("beforeend", html); }, chipMarkup(MEMBERS[2]!, "left"));
          const at = await page.evaluate(() => {
            const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
            const b = document.querySelectorAll(".tm-mb")[2]!;
            return { button: rect(b), square: rect(b.querySelector(".tm-sq")!), chipW: document.querySelector<HTMLElement>(".tm-tip")!.offsetWidth };
          }) as { button: R; square: R; chipW: number };
          const pos = tipAt("left", at.button, at.square, 18, at.chipW);
          const m = await page.evaluate(({ left, top }) => {
            const c = document.querySelector<HTMLElement>(".tm-tip")!;
            c.style.left = `${left}px`;
            c.style.top = `${top}px`;
            const r = c.getBoundingClientRect();
            const words = [...document.querySelectorAll(".pm-in")].map((p) => p.getBoundingClientRect());
            return {
              chip: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
              over: words.some((p) => r.left < p.right - 0.5 && p.left < r.right - 0.5 && r.top < p.bottom - 0.5 && p.top < r.bottom - 0.5),
              position: getComputedStyle(c).position,
              text: c.textContent,
            };
          }, pos);
          const railLeft = at.square.left + at.square.width / 2 - 9;
          expect(m.position).toBe("fixed");
          expect(m.text).toMatch(/^Sender p3 · /);
          expect(railLeft - m.chip.right, "chip → rail").toBeCloseTo(6, 1);
          expect((m.chip.top + m.chip.bottom) / 2, "on the square's line").toBeCloseTo(at.button.top + at.button.height / 2, 0);
          expect(m.over, "the chip covers message text").toBe(false);
          expect(m.chip.left).toBeGreaterThanOrEqual(0);
        } finally {
          await page.close();
        }
      }, 60_000);

  it("under the strip: 4px under the square's button, inside the list column, at the right end too", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => member(`s${i}`, i > 7));
    const body = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <div className="list-col" style={{ width: 300 }}>
          <MessageRow id="s9" from="Lena" subject="Q3 plan" time="09:12" preview="the words" unread
            marks={ten.map((m) => (m.unread ? "unread" : "read"))} marksLabel="10 messages"
            follow={<ThreadMarksBar axis="x" messages={ten} here="s9" tabStop="s9" onJump={() => {}} />} />
        </div>
      </NextIntlClientProvider>,
    );
    const page = await browser!.newPage({ viewport: { width: 900, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html data-theme="light" data-face="ohmarchy"><head><meta charset="utf-8"><style>${SHEETS}</style>
        <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${body}${chipMarkup(ten[9]!, "under")}</body></html>`);
      const at = await page.evaluate(() => {
        const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const bs = document.querySelectorAll(".tm-strip .tm-mb");
        const b = bs[bs.length - 1]!;
        return {
          button: rect(b), square: rect(b.querySelector(".tm-sq")!), list: rect(document.querySelector(".list-col")!),
          chipW: document.querySelector<HTMLElement>(".tm-tip")!.offsetWidth,
        };
      }) as { button: R; square: R; list: R; chipW: number };
      const pos = tipAt("under", at.button, at.square, 18, at.chipW, at.list);
      const r = await page.evaluate(({ left, top }) => {
        const c = document.querySelector<HTMLElement>(".tm-tip")!;
        c.style.left = `${left}px`;
        c.style.top = `${top}px`;
        const b = c.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top };
      }, pos);
      expect(r.top - at.button.bottom, "under the square").toBeCloseTo(4, 1);
      expect(r.left, "inside the list column").toBeGreaterThanOrEqual(at.list.left + 8 - 0.5);
      expect(r.right, "inside the list column").toBeLessThanOrEqual(at.list.right - 8 + 0.5);
    } finally {
      await page.close();
    }
  }, 60_000);
});
