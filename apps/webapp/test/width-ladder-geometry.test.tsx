import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapOmarchyThemePair } from "../../../packages/tokens/omarchy/map.js";
import { omarchyRuleText } from "../../../packages/tokens/omarchy/rule.js";

/**
 * ═══ THE WIDTH LADDER, MEASURED IN A REAL ENGINE ═════════════════════════════════════════════
 *
 * DESIGN-FOLD-WIDTHS §1: between 700 and 1023 CSS px the shell is a topbar over TWO panes —
 * the list at `clamp(300px, 38%, 380px)`, the reader inline beside it — with the rail still a
 * drawer; below 700 it is the phone (one column, the reader an overlay); from 1024 it is the
 * three-pane desktop, unchanged. The stylesheet test (`width-ladder.test.ts`) pins the rules;
 * this file reads the GEOMETRY those rules produce, because a clamp, a grid gap and a deck
 * padding only add up in a layout engine: headless Chromium over the shipped cascade and the
 * shell's own element shapes, `getBoundingClientRect` at each edge of each band.
 *
 * The one canary the ruling asked for (§9 risk 6) is here: at exactly 700 the reader column is
 * 364px — above Android's own 320 floor — and the list 300. The list's percentage is a grid-track
 * percentage, resolved against the deck's content box (not the free space after the gap), so
 * the list reads `clamp(300, 0.38 × deckInner, 380)`: 300 at 700, ≈304 at 821, 380 at 1023.
 *
 * THE RED CONTROL is the pre-ladder stylesheet, re-applied as an override on the same page: the
 * old `max-width: 900px` block collapsed every split to one column, so at 821 the same
 * measurement reads NO reading column. An arm that only admits proves nothing; the last describe
 * fails if the override is not caught.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade the shell renders under, in the order the app loads it. */
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/rail.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/reader.css",
  "packages/ui/src/primitives/waterline.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/shell/column-handles.css",
].map(css).join("\n");

/** The old shell's narrow block, as an override: one column and no reading column under 900. */
const PRE_LADDER = `
@media (max-width: 900px) {
  .view.split { grid-template-columns: 1fr; }
  .view.split > .read-col { display: none; }
}
`;

/** The shell's own shapes, nothing invented: topbar, deck, rail, stage, a split view. */
const PAGE = (extra = ""): string => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHEETS}${extra}</style>
<style>html,body{margin:0;height:100%}</style></head>
<body class="mo-canvas"><div class="app-root"><div class="shell">
  <div class="topbar"><button type="button" class="tb-btn">≡</button><b>Ohbox</b><button type="button" class="tb-btn">⌘K</button></div>
  <div class="deck">
    <nav class="rail" aria-label="Main"><div class="wordmark"><b><em>oh</em>mail</b></div><div class="rgroup"><button type="button" class="ritem on">Ohbox</button></div></nav>
    <main class="stage"><section class="view split view-ohbox">
      <div class="list-col"><div class="vhead"><h1>Ohbox</h1></div><div class="scroller"><div class="rows"></div></div></div>
      <div class="read-col" role="region" aria-label="Open message" tabindex="-1">
        <button type="button" class="read-col-close" aria-label="Close"></button>
        <article class="msg"><h2>A subject</h2><p>Body</p></article>
      </div>
    </section></main>
  </div>
</div></div></body></html>`;

type Reading = {
  list: number | null;
  reader: number | null;
  readerShown: boolean;
  railFixed: boolean;
  topbar: string;
  closeShown: boolean;
  closeRect: number[] | null;
  colRect: number[] | null;
  deckInner: number;
  gap: number;
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function read(width: number, touch: boolean, extra = ""): Promise<Reading> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: 1,
  });
  try {
    const page = await ctx.newPage();
    await page.setContent(PAGE(extra));
    return await page.evaluate(() => {
      const w = (sel: string): number | null => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width;
      };
      const show = (sel: string): string => getComputedStyle(document.querySelector(sel)!).display;
      const rect = (sel: string): number[] | null => { const el = document.querySelector(sel); if (!el) return null; const q = el.getBoundingClientRect(); return [q.left, q.top, q.width, q.height]; };
      const deck = document.querySelector(".deck")!;
      const ds = getComputedStyle(deck);
      const deckInner = deck.getBoundingClientRect().width - parseFloat(ds.paddingLeft) - parseFloat(ds.paddingRight);
      const split = getComputedStyle(document.querySelector(".view.split")!);
      return {
        list: w(".list-col"),
        reader: w(".read-col"),
        readerShown: show(".read-col") !== "none",
        railFixed: getComputedStyle(document.querySelector(".deck > .rail")!).position === "fixed",
        topbar: show(".topbar"),
        closeShown: show(".read-col-close") !== "none",
        closeRect: rect(".read-col-close"),
        colRect: rect(".read-col"),
        deckInner,
        gap: parseFloat(split.columnGap) || 0,
      };
    });
  } finally {
    await ctx.close();
  }
}

describe("the phone band ends at 699 and the two-pane band begins at 700", () => {
  it("699 touch: one column, the reading column gone, the rail a drawer under the topbar", async () => {
    const r = await read(699, true);
    expect(r.readerShown, "a reading column at 699 — the phone band lost its one-column rule").toBe(false);
    expect(r.railFixed).toBe(true);
    expect(r.topbar).toBe("flex");
  }, 60_000);

  it("700 touch — THE CANARY: list 300, reader 364, rail still a drawer, the ✕ shown", async () => {
    const r = await read(700, true);
    expect(r.readerShown).toBe(true);
    expect(r.list).toBeCloseTo(300, 0);
    // 700 − deck padding 10 + 10 − gap 16 − list 300 = 364: above Android's 320 floor (§9 risk 6).
    expect(r.reader).toBeCloseTo(364, 0);
    expect(r.reader!).toBeGreaterThanOrEqual(360);
    expect(r.railFixed, "the rail stands at 700 — the drawer band must reach 1023").toBe(true);
    expect(r.topbar).toBe("flex");
    expect(r.closeShown, "no ✕ for a thumb at 700 — the column has no Esc there").toBe(true);
    /* WHERE it sits, not only that it shows (REVIEW-026 LOW 9): 38px square at the column's top-LEFT
       corner — the phone's thumb corner, folded and unfolded alike, the lane's own look judged
       defensible against the ruling's top-right (filed as WEB-TWO-PANE-CLOSE-TOP-RIGHT). */
    expect(r.closeRect![2]).toBeCloseTo(38, 0);
    expect(r.closeRect![3]).toBeCloseTo(38, 0);
    expect(Math.abs(r.closeRect![0] - r.colRect![0]), "the ✕ left the column's left edge").toBeLessThanOrEqual(12);
    expect(Math.abs(r.closeRect![1] - r.colRect![1]), "the ✕ left the column's top edge").toBeLessThanOrEqual(12);
  }, 60_000);

  it("821 (a foldable's inner screen): list at its 38%, the reader takes the rest; a fine pointer gets no ✕", async () => {
    const touch = await read(821, true);
    const track = Math.min(380, Math.max(300, 0.38 * touch.deckInner));
    expect(touch.list).toBeCloseTo(track, 0);
    expect(touch.reader!).toBeCloseTo(touch.deckInner - touch.gap - track, 0);
    expect(touch.reader!).toBeGreaterThanOrEqual(460);
    expect(touch.closeShown).toBe(true);
    const fine = await read(821, false);
    expect(fine.closeShown, "a ✕ under a mouse — fine pointers keep Esc and no button, as at 1024").toBe(false);
    expect(fine.list).toBeCloseTo(track, 0);
  }, 60_000);

  it("1023 touch: the band's upper edge — the list at the 380 cap, still a drawer", async () => {
    const r = await read(1023, true);
    expect(r.list!).toBeCloseTo(380, 0);
    expect(r.reader!).toBeGreaterThanOrEqual(600);
    expect(r.railFixed).toBe(true);
    expect(r.topbar).toBe("flex");
    expect(r.closeShown).toBe(true);
  }, 60_000);

  it("1024 touch: three panes — the rail stands, no topbar, no ✕, the desktop split", async () => {
    const r = await read(1024, true);
    expect(r.railFixed, "the rail is a drawer at 1024 — the desktop changed").toBe(false);
    expect(r.topbar).toBe("none");
    expect(r.closeShown).toBe(false);
    expect(r.readerShown).toBe(true);
    // the desktop's own `--split: minmax(320px,400px) 1fr`
    expect(r.list!).toBeGreaterThanOrEqual(320);
    expect(r.list!).toBeLessThanOrEqual(400);
  }, 60_000);
});

/** The News list's waterline with the real strings in a column too narrow for them: no sideways scroll.
 *  240 rather than the band's 300, because the headless font sets the strings narrower than the app's
 *  webfont (the old row measures less here than in the app) and at that width the row fits here either way;
 *  the property holds at any width. */
const WATERLINE = (extra = ""): string => `<!doctype html><html><head><meta charset="utf-8">
<style>${SHEETS}${extra}</style><style>html,body{margin:0}</style></head>
<body class="mo-canvas"><div class="list-col" style="width:240px"><div class="scroller" style="overflow:auto;width:240px">
<div class="waterline"><b>Seen up to here</b><span class="num">last visit · 5 Oct, 19:54</span></div>
</div></div></body></html>`;

async function waterlineOverflow(extra = ""): Promise<{ over: number; metaClipped: boolean }> {
  const ctx = await browser!.newContext({ viewport: { width: 700, height: 400 } });
  try {
    const page = await ctx.newPage();
    await page.setContent(WATERLINE(extra));
    return await page.evaluate(() => {
      const sc = document.querySelector(".scroller")!;
      const span = document.querySelector(".waterline span")!;
      return { over: sc.scrollWidth - sc.clientWidth, metaClipped: span.scrollWidth > span.clientWidth };
    });
  } finally {
    await ctx.close();
  }
}

describe("the News waterline fits the band's 300px list — the meta gives way, never the column", () => {
  it("no sideways scroll in a column the strings do not fit, and it is the meta that was cut", async () => {
    const r = await waterlineOverflow();
    expect(r.over, "the list scrolls sideways under its waterline").toBeLessThanOrEqual(0);
    expect(r.metaClipped, "nothing gave way — the fixture no longer exercises the overflow").toBe(true);
  }, 60_000);
  it("red control: the old `flex:none` meta pushes the row past the column", async () => {
    const r = await waterlineOverflow(".waterline span{flex:none;min-width:auto;overflow:visible}");
    expect(r.over, "the control did not bite").toBeGreaterThan(0);
  }, 60_000);
});

describe("the red control: the pre-ladder stylesheet re-applied is caught by the same reading", () => {
  it("under the old 900 block, 821 reads one column and no reading column", async () => {
    const r = await read(821, true, PRE_LADDER);
    expect(r.readerShown, "the control did not bite — the override no longer reaches the split").toBe(false);
  }, 60_000);
});

/* THE DESKTOP'S OUTER EDGE UNDER THE OMARCHY FEED (owner reports 2026-10-24/25, a 1488px window):
   the feed maps Hyprland's gaps_out to the deck's edge; a gaps_out read as 0 put the rail, list and
   reader flush to the window, then one ring off it. Every tile's ring stays inside the window, and
   the frame is never narrower than the gap between two tiles. */
const GRUVBOX = readFileSync(resolve(process.cwd(), "packages/tokens/omarchy/fixtures/raw/gruvbox.colors.toml"), "utf8");
const hypr = (css: string): string => `{"option": "general:gaps_out", "css": "${css}", "set": true }`;

async function tileEdges(
  hyprGapsOut: string,
  hyprGapsIn = '{"option": "general:gaps_in", "css": "5 5 5 5", "set": true }',
  hyprBorderSize = '{"option": "general:border_size", "int": 2, "set": true }',
) {
  const mapped = mapOmarchyThemePair({ colorsToml: GRUVBOX, hyprGapsIn, hyprGapsOut, hyprBorderSize })!;
  const live = omarchyRuleText(mapped.native.tokens, mapped.mode, mapped.counterpart?.tokens ?? null);
  const html = PAGE(`${css("packages/tokens/src/ohmarchy.css")}\n${live}`)
    .replace("<html>", '<html data-face="ohmarchy" data-theme="dark">');
  const ctx = await browser!.newContext({ viewport: { width: 1488, height: 932 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(html);
    return await page.evaluate(() =>
      [".deck > .rail", ".list-col", ".read-col"].map((sel) => {
        const el = document.querySelector(sel)!;
        const r = el.getBoundingClientRect();
        const ring = Number(/0px 0px 0px ([\d.]+)px/.exec(getComputedStyle(el).boxShadow)?.[1] ?? 0);
        return { sel, ring, box: { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom }, r: { left: r.left, right: r.right } };
      }),
    );
  } finally {
    await ctx.close();
  }
}

describe("the desktop's tiles keep their rings inside the window under the Omarchy feed", () => {
  const noGapsToggle = ['{"option": "general:gaps_in", "css": "0 0 0 0", "set": true }', '{"option": "general:border_size", "int": 0, "set": true }'] as const;
  const shapes: (readonly [string, ...string[]])[] = [[hypr("0 0 0 0")], [hypr("10 10 10 10")], [hypr("0 10 10 10")], [hypr("4 4 4 4")], [hypr("10")], ['{"option": "general:gaps_out", "int": 0, "set": true }'], [hypr("0 0 0 0"), ...noGapsToggle]];
  for (const shape of shapes)
    it(`${shape.join(" ")}: the window's frame is the gap between two tiles`, async () => {
      const tiles = await tileEdges(...shape);
      const [rail, list] = tiles;
      const between = list!.r.left - rail!.r.right;
      expect(between, "the tile gap").toBe(10);
      for (const t of tiles) {
        expect(t.ring, `${t.sel} draws no ring: this proves nothing`).toBeGreaterThan(0);
        for (const side of ["left", "top", "right", "bottom"] as const)
          if (!(t.sel === ".list-col" && (side === "left" || side === "right")))
            if (!(t.sel === ".deck > .rail" && side === "right") && !(t.sel === ".read-col" && side === "left"))
              expect(t.box[side], `${t.sel}'s edge at the ${side}`).toBe(between);
      }
    }, 60_000);
});
