import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderedUiFont, skipUnlessMeasuredFont } from "./_measured-font.js";
import { AddressText, Chip, MessageRow, StreamCard } from "@ohmail/ui";

/**
 * ═══ LISTS AND CARDS AT PHONE AND FOLDABLE WIDTHS — MEASURED IN A REAL ENGINE ═════════════════
 *
 * jsdom lays nothing out, so each property here is read off headless Chromium over the real
 * components and stylesheets:
 *
 *   · ONE SACRIFICE ORDER for "who · address · time" (row, stream card head, reader header): the
 *     time and an amount are whole, the name is whole on one line down to its 12ch floor, the
 *     address takes only the room left and leaves under 14ch or on a line under 280px; the
 *     delivered-to chip stands on a card head only at a 600px card.
 *   · A COLLAPSED CARD ENDS WITH ITS MAIL: 348 is a ceiling; the fade and the pill mark a cut.
 *   · EDGES AND GUTTERS: a hairline under the head of a scrolled list and over its foot while rows
 *     continue; History's month rail never over a row; a draft row's surface under its Discard;
 *     the first-sync pill's height reserved at the end of a phone scroller.
 *
 * Every arm has its RED CONTROL: the layout it replaced, re-applied as an override on the same
 * page, read by the same measurement, which must then find the defect.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/address-text.css",
  "packages/ui/src/composites/row.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/stream.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/primitives/chip.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/views/history-rail.css",
].map(css).join("\n");

/** The fixture's 15-character name the ruling pins the cut from; invented addresses only. */
const NAME = "Greta Lindqvist";
const ADDR = "greta@lindqvist-textile.invalid";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
/** The face paper's text renders in here; the arms measured in Inter read it (`_measured-font.ts`). */
let uiFont = "";
beforeAll(async () => {
  browser = await chromium.launch();
  uiFont = await renderedUiFont(browser);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const doc = (body: string, extra = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body class="mo-canvas">${body}</body></html>`;

async function onPage<T>(html: string, fn: () => T, viewport = { width: 1280, height: 900 }): Promise<T> {
  const page = await browser!.newPage({ viewport });
  try {
    await page.setContent(html);
    return (await page.evaluate(fn)) as T;
  } finally {
    await page.close();
  }
}

type LineReading = {
  line: number; nameCut: boolean; nameWrapped: boolean; addrShown: boolean; addrW: number; floor14: number;
  timeCut: boolean; amtCut: boolean; chipShown: boolean;
};

/** One "who · address · time" line, read the way a person sees it. */
const readLine = (): LineReading => {
  const line = document.querySelector(".row-top, .sc-line, .msg-from") as HTMLElement;
  const name = line.querySelector(".who, :scope > b, .msg-sender > b") as HTMLElement;
  const addr = line.querySelector(".addr, small") as HTMLElement | null;
  const text = addr?.firstElementChild as HTMLElement | null;
  const time = line.querySelector(".t") as HTMLElement;
  const amt = line.querySelector(".amt") as HTMLElement | null;
  const chip = line.querySelector(".sc-place") as HTMLElement | null;
  /* Drawn, as a person sees it: a hidden address is CLIPPED (so a screen reader keeps it), which
     leaves its box in place — so the clip is read as well as display and visibility. */
  const shown = (el: HTMLElement | null): boolean => {
    if (!el || el.getBoundingClientRect().width <= 1) return false;
    for (let e: HTMLElement | null = el; e && e !== line; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility !== "visible" || cs.clipPath === "inset(50%)") return false;
    }
    return true;
  };
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(14);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
  addr?.appendChild(probe);
  const floor14 = probe.getBoundingClientRect().width;
  probe.remove();
  const lh = parseFloat(getComputedStyle(name).lineHeight) || parseFloat(getComputedStyle(name).fontSize) * 1.4;
  return {
    line: line.getBoundingClientRect().width,
    nameCut: name.scrollWidth > name.clientWidth + 0.5,
    nameWrapped: name.getBoundingClientRect().height > lh * 1.5,
    addrShown: shown(addr) && shown(text),
    addrW: addr ? addr.getBoundingClientRect().width : 0,
    floor14,
    timeCut: time.scrollWidth > time.clientWidth + 0.5,
    amtCut: !!amt && amt.scrollWidth > amt.clientWidth + 0.5,
    chipShown: shown(chip),
  };
};

const rowMarkup = (width: number): string =>
  `<div class="rows" style="width:${width}px">${renderToStaticMarkup(
    <MessageRow id="r1" from={NAME} address={ADDR} time="21 Sep" subject="Swatches for the spring run" preview="Three weights, two dyes." />,
  )}</div>`;

const cardMarkup = (width: number, extra: Record<string, unknown> = {}): string =>
  `<div class="stream" style="width:${width}px;padding:0">${renderToStaticMarkup(
    <StreamCard
      id="c1" from="Harbour Supply" address="tickets@harbour-supply.invalid" time="21 Sep"
      subject="Your order is on its way" body="Two crates, one invoice." expandLabel="Expand" collapseLabel="Collapse"
      {...extra}
    />,
  )}</div>`;

/** The line rules this replaced: the name capped at a share of the row, the address shrinking beside it, no cut. */
const PRE_LINE = `
.row-top{container:none}.row-top .who{max-width:58%;min-width:0}
.row-top .addr{flex:1 1 auto;container:none;overflow:hidden;text-overflow:ellipsis;position:static;width:auto;height:auto;clip-path:none}
.row-top .addr > span{display:inline;visibility:visible;clip-path:none}
.sc-head{container:none}.sc-line b{min-width:0}
.sc-line .addr{flex:1 100 auto;container:none;overflow:hidden;text-overflow:ellipsis;display:block;position:static;width:auto;height:auto;clip-path:none}
.sc-line .addr > span{display:inline;visibility:visible;clip-path:none}
.sc-line .sc-place{display:inline-flex;flex:none}
.msg-from{container:none}.msg-from b{white-space:normal;min-width:0}
.msg-from small{flex:initial;container:none;display:inline;min-width:0;overflow:hidden;text-overflow:ellipsis}
.msg-from small > span{display:inline;visibility:visible}
.msg-from:has(> .msg-from-line) small{display:inline !important}.msg-from-line{display:none !important}
.msg-from .msg-sender{flex-wrap:nowrap;position:static;padding-left:3px;min-height:0}.msg-from .msg-sender > .av{position:static}
`;

describe("one sacrifice order: the time whole, the name whole on one line, the address gives first", () => {
  for (const width of [300, 330, 360, 420, 640]) {
    it(`a list row at ${width}px: neither the name nor the time is cut, and the address is ≥ 14ch or gone`, async () => {
      const r = await onPage(doc(rowMarkup(width)), readLine);
      expect(r.timeCut, "the date is cut").toBe(false);
      expect(r.nameCut, `the 15-character name is cut on a ${r.line}px line`).toBe(false);
      expect(r.nameWrapped).toBe(false);
      if (r.line < 280) expect(r.addrShown, `an address on a ${r.line}px line`).toBe(false);
      if (r.addrShown) expect(r.addrW, "the address is drawn under its 14ch floor").toBeGreaterThanOrEqual(r.floor14 - 1);
    }, 60_000);
  }

  it("the address is drawn wherever the line can give it 14ch (a 412px phone, a 1024px list)", async () => {
    // Positive control for the cut: at the widths the ruling expects an address it is there.
    for (const width of [340, 360]) {
      const r = await onPage(doc(rowMarkup(width)), readLine);
      expect(r.addrShown, `no address on a ${r.line}px line`).toBe(true);
    }
  }, 60_000);

  it("RED CONTROL: the 58% cap with a shrinking address cuts the name and the address at once", async () => {
    const r = await onPage(doc(rowMarkup(300), PRE_LINE), readLine);
    expect(r.nameCut && r.addrShown, "the replaced rules no longer cut both — this arm measures nothing").toBe(true);
  }, 60_000);

  for (const width of [358, 386]) {
    it(`a Receipts card head at a ${width}px card: name, amount and time whole; no crushed address`, async () => {
      const r = await onPage(doc(cardMarkup(width, { amount: "CHF 96.00", mailbox: "Work", mailboxTitle: "Delivered to Work" })), readLine);
      expect(r.nameCut, "the sender is cut").toBe(false);
      expect(r.amtCut || r.timeCut, "the amount or the time is cut").toBe(false);
      if (r.addrShown) expect(r.addrW).toBeGreaterThanOrEqual(r.floor14 - 1);
      expect(r.chipShown, "the delivered-to chip stands on a card under 600px").toBe(false);
    }, 60_000);
  }

  it("the delivered-to chip stands on the line of a 620px card, and on the open card's head below 600", async () => {
    const wide = await onPage(doc(cardMarkup(620, { mailbox: "Work", mailboxTitle: "Delivered to Work" })), readLine);
    expect(wide.chipShown, "no chip on a 620px card").toBe(true);
    const narrowOpen = await onPage(
      doc(cardMarkup(386, { mailbox: "Work", mailboxTitle: "Delivered to Work" }).replace('class="scast', 'class="scast open')),
      () => getComputedStyle(document.querySelector(".sc-place-alt")!).display,
    );
    expect(narrowOpen, "the open card under 600px does not say where it was delivered").not.toBe("none");
  }, 60_000);

  it("RED CONTROL: the chip on a phone card head takes the name's room", async () => {
    const r = await onPage(doc(cardMarkup(358, { mailbox: "claude-fixture@lindqvist-textile.invalid", mailboxTitle: "Delivered" }), PRE_LINE), readLine);
    expect(r.chipShown && r.nameCut, "the replaced rules no longer crush the name — this arm measures nothing").toBe(true);
  }, 60_000);

  const header = (width: number): string => `<article class="msg" style="width:${width + 68}px;max-width:none">
    <div class="msg-from">
      <button type="button" class="msg-sender"><span class="av s">F</span><b>Fixture Roles frf259</b><small>${renderToStaticMarkup(<AddressText address={ADDR} />)}</small></button>
      <span class="t num"><span class="msg-menu"><button type="button" class="msg-more">⋯</button></span><button type="button" class="stamp-toggle"><time>21 Sep</time></button></span>
      <p class="msg-from-line">from ${ADDR}</p>
    </div></article>`;
  const fromLineShown = () => {
    const l = document.querySelector(".msg-from-line") as HTMLElement;
    return getComputedStyle(l).display !== "none" && l.getBoundingClientRect().height > 0;
  };
  for (const width of [200, 240, 300, 360, 419, 430, 560]) {
    it(`the reader header at ${width}px: the name on one line, ⋯ and the time whole`, async () => {
      const r = await onPage(doc(header(width)), readLine);
      expect(r.nameWrapped, "the sender's name wraps").toBe(false);
      expect(r.timeCut, "the ⋯/time cluster is cut").toBe(false);
      if (r.line < 420) expect(r.addrShown, `an address in a ${r.line}px header`).toBe(false);
      if (r.addrShown) expect(r.addrW).toBeGreaterThanOrEqual(r.floor14 - 1);
      // HAND BACK H2: wherever the header drops the address, its own line states it; never both.
      const line = await onPage(doc(header(width)), fromLineShown);
      expect(line, "the address is on screen neither in the header nor on its own line").toBe(!r.addrShown);
    }, 60_000);
  }

  it("a header with room draws the whole address: the name is never padded (LOOK UGLY 1, UGLY 3)", async () => {
    // The 12ch "floor" was a pad: `min-width:min(100%,12ch)` widened a short name and the address
    // was cut to 14ch with ~180px free beside it. Red control: the pad, re-applied on the one-line,
    // address-shrinks-first header it was measured on (the header now wraps the address under the name).
    const read = () => {
      const s = document.querySelector(".msg-from small") as HTMLElement;
      const b = document.querySelector(".msg-from b") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(b);
      const cut = [s, ...s.querySelectorAll<HTMLElement>("*")].some((e) => e.scrollWidth > e.clientWidth + 0.5);
      return { addrCut: cut, namePad: b.getBoundingClientRect().width - range.getBoundingClientRect().width };
    };
    const short = header(560).replace("Fixture Roles frf259", "Ben Arnold");
    const r = await onPage(doc(short), read);
    expect(r.addrCut, "the address is cut with room beside it").toBe(false);
    expect(r.namePad, "the name's box is wider than its text").toBeLessThanOrEqual(0.5);
    const pre = await onPage(doc(short, ".msg-from b{min-width:min(100%,12ch)}.msg-from .msg-sender{flex-wrap:nowrap}.msg-from small{flex:0 100 auto;min-width:14ch}.msg-from small > span{display:block;overflow:hidden;text-overflow:ellipsis}.msg-from .addr-dom{white-space:nowrap}"), read);
    expect(pre.addrCut, "the pad no longer cuts the address — this arm measures nothing").toBe(true);
  }, 60_000);

  it("a list row's short name is not padded, and the address keeps the width it had", async (ctx) => {
    skipUnlessMeasuredFont(uiFont, ctx);
    const read = () => {
      const b = document.querySelector(".who") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(b);
      return b.getBoundingClientRect().width - range.getBoundingClientRect().width;
    };
    const row = rowMarkup(400).replace(NAME, "Ben Arnold");
    expect(await onPage(doc(row), read), "the name's box is wider than its text").toBeLessThanOrEqual(0.5);
    expect(await onPage(doc(row, ".row-top .who{min-width:min(100%,12ch)}"), read), "red control: the pad").toBeGreaterThan(2);
  }, 60_000);

  it("a header 420px wide and up draws the address, cut no narrower than 14ch", async () => {
    // Positive control for the 420 cut: the address is there wherever the header can hold it.
    for (const width of [430, 560]) {
      const r = await onPage(doc(header(width)), readLine);
      expect(r.addrShown, `no address in a ${r.line}px header`).toBe(true);
      expect(r.addrW).toBeGreaterThanOrEqual(r.floor14 - 1);
    }
  }, 60_000);

  it("RED CONTROL: the replaced header wraps the name word by word", async () => {
    const r = await onPage(doc(header(300), PRE_LINE), readLine);
    expect(r.nameWrapped, "the replaced header no longer wraps — this arm measures nothing").toBe(true);
  }, 60_000);
});

describe("a collapsed card ends where its mail ends; the fade and the pill mark a cut", () => {
  /** A viewer card whose body is `h` px tall, in the state StreamCard's measurement puts it in. */
  const viewer = (h: number, fits: boolean): string => cardMarkup(358).replace(
    /<div class="sc-clip">[\s\S]*?<div class="sc-fade"><\/div><\/div>/,
    `<div class="sc-clip"><div class="sc-viewer"><div class="body" style="height:${h}px"></div></div><div class="sc-fade"></div></div>`,
  ).replace('class="scast', `class="scast viewer${fits ? " short" : ""}`);
  const readCard = () => {
    const clip = document.querySelector(".sc-clip") as HTMLElement;
    const body = clip.querySelector(".sc-viewer, .sc-body") as HTMLElement;
    const shown = (s: string) => {
      const cs = getComputedStyle(document.querySelector(s)!);
      return cs.display !== "none" && cs.opacity !== "0";
    };
    return {
      clip: clip.getBoundingClientRect().height,
      voidPx: clip.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom,
      cut: clip.scrollHeight > clip.clientHeight + 1,
      pill: shown(".sc-x"), fade: shown(".sc-fade"),
    };
  };

  it("a short letter's card ends under it: no void, no pill, no fade", async () => {
    const r = await onPage(doc(viewer(150, true)), readCard);
    expect(r.voidPx, "the card holds empty room under the mail").toBeLessThanOrEqual(24);
    expect(r.clip).toBeLessThan(348);
    expect(r.pill || r.fade, "a pill or a fade over a mail that is all there").toBe(false);
  }, 60_000);

  it("a long letter is cut at 348 with the fade and the pill under the cut", async () => {
    const r = await onPage(doc(viewer(900, false)), readCard);
    expect(Math.round(r.clip)).toBe(348);
    expect(r.cut && r.pill && r.fade).toBe(true);
  }, 60_000);

  it("a waiting card reserves its own estimate, not the clamp", async () => {
    const html = doc(cardMarkup(358, { bodyState: "loading", loadingLabel: "Loading", estWidthPx: 358 }));
    const r = await onPage(html, readCard);
    expect(r.clip, "the waiting card reserves less than its floor").toBeGreaterThanOrEqual(119.5);
    expect(r.clip, "the waiting card reserves the whole clamp").toBeLessThan(348);
  }, 60_000);

  it("RED CONTROL: the fixed 348 box holds a void under a short letter", async () => {
    const r = await onPage(doc(viewer(150, false), ".scast.viewer:not(.open) .sc-clip{height:348px}"), readCard);
    expect(r.voidPx, "the replaced box no longer holds a void — this arm measures nothing").toBeGreaterThan(24);
  }, 60_000);
});

describe("edges and gutters", () => {
  const list = (attrs: string): string => `<div class="list-col" ${attrs} style="height:400px">
    <div class="vhead"><h1>Ohbox</h1></div>
    <div class="scroller">${Array.from({ length: 20 }, (_, i) => `<div class="row" style="height:60px">${i}</div>`).join("")}</div>
    <div class="list-hints"><span>? shortcuts</span></div></div>`;
  const edges = () => ({
    head: getComputedStyle(document.querySelector(".vhead")!).boxShadow,
    foot: getComputedStyle(document.querySelector(".list-hints")!).boxShadow,
  });

  it("a scrolled list draws a hairline under its head, and one over its foot while rows continue", async () => {
    const on = await onPage(doc(list("data-scrolled data-more-below")), edges);
    expect(on.head, "no edge under the head of a scrolled list").not.toBe("none");
    expect(on.foot, "no edge over the hints strip with rows below").not.toBe("none");
    const off = await onPage(doc(list("")), edges);
    expect([off.head, off.foot], "an edge drawn over a list that has not scrolled").toEqual(["none", "none"]);
  }, 60_000);

  const history = (gutter: boolean): string => `<section class="view view-history"><div class="list-col">
    <div class="scroller" style="height:500px;width:360px;position:relative">
      <div class="history-rail-anchor"><nav class="history-rail">
        <button class="history-rail-item year">2026</button><button class="history-rail-item cur">Ohne Datum</button>
        <button class="history-rail-item">Sept. 2026</button></nav></div>
      <div class="rows">${Array.from({ length: 6 }, (_, i) => `<button class="row"><span class="row-top"><span class="who">Row ${i}</span><span class="t num">21 Sep</span></span></button>`).join("")}</div>
    </div></div></section>`;
  const railOverRow = (gutter: boolean) => {
    const nav = document.querySelector(".history-rail") as HTMLElement;
    if (gutter) (document.querySelector(".scroller") as HTMLElement).style.setProperty("--history-gutter", `${Math.ceil(nav.offsetWidth)}px`);
    const rr = nav.getBoundingClientRect();
    return [...document.querySelectorAll(".row")].filter((row) => {
      const r = row.getBoundingClientRect();
      return r.right > rr.left + 0.5 && r.left < rr.right && r.bottom > rr.top && r.top < rr.bottom;
    }).length;
  };

  it("History's month rail never covers a row: the rows keep the rail's width as a gutter", async () => {
    const page = await browser!.newPage({ viewport: { width: 400, height: 700 } });
    try {
      await page.setContent(doc(history(true)));
      expect(await page.evaluate(railOverRow, true)).toBe(0);
      // RED CONTROL: without the gutter the rail stands over the first rows.
      await page.setContent(doc(history(false)));
      expect(await page.evaluate(railOverRow, false), "the rail no longer overlaps rows without the gutter — this arm measures nothing").toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  const draft = `<section class="view view-drafts"><div class="draft-row"><div class="draft-row-main">
    <button type="button" class="draft-open"><span class="draft-line"><b class="draft-subject">Spring order</b></span></button>
    <button type="button" class="draft-discard">Discard</button></div></div></section>`;
  const draftPaint = async (extra: string) => {
    const page = await browser!.newPage({ viewport: { width: 830, height: 400 } });
    try {
      await page.setContent(doc(draft, extra));
      await page.hover(".draft-open");
      return await page.evaluate(() => {
        const main = document.querySelector(".draft-row-main")!;
        const discard = document.querySelector(".draft-discard")!.getBoundingClientRect();
        const m = main.getBoundingClientRect();
        return { paint: getComputedStyle(main).backgroundColor, inside: discard.left >= m.left && discard.right <= m.right };
      });
    } finally {
      await page.close();
    }
  };

  it("a hovered draft's surface is the whole line, Discard included", async () => {
    const r = await draftPaint("");
    expect(r.inside).toBe(true);
    expect(r.paint, "the row line is unpainted on hover — Discard stands beside the row").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // RED CONTROL: the tint on the draft button alone leaves the line unpainted.
    const pre = await draftPaint(".draft-row-main:hover{background:none}.draft-open:hover{background:var(--tint)}");
    expect(pre.paint).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }, 60_000);

  const phoneList = (pill: boolean): string => `<div class="shell"><main class="stage"><section class="view col">
    <div class="list-col" style="height:700px"><div class="scroller">${Array.from({ length: 30 }, (_, i) => `<button class="row" style="display:block;height:56px">Row ${i}</button>`).join("")}</div></div>
    </section></main>${pill ? `<div class="sync-bar busy" role="status"><b>Syncing your mail.</b></div>` : ""}</div>`;
  const pillOverLast = (reserve: boolean) => {
    const bar = document.querySelector(".sync-bar") as HTMLElement;
    if (reserve) document.documentElement.style.setProperty("--pill-h", `${bar.offsetHeight + 18}px`);
    const sc = document.querySelector(".scroller") as HTMLElement;
    sc.scrollTop = sc.scrollHeight;
    const rows = [...document.querySelectorAll(".row")];
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    return last.bottom > bar.getBoundingClientRect().top;
  };

  for (const width of [360, 800]) {
    it(`at ${width}px the first-sync pill's height is reserved, so the last row rests clear of it`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 700 } });
      try {
        await page.setContent(doc(phoneList(true)));
        expect(await page.evaluate(pillOverLast, true), "the pill covers the last row at scroll end").toBe(false);
        // RED CONTROL: with nothing reserved the pill stands over the last row.
        await page.setContent(doc(phoneList(true)));
        expect(await page.evaluate(pillOverLast, false), "the pill no longer overlaps without the reservation — this arm measures nothing").toBe(true);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});

describe("in a 300px list column (the two-pane band) the rows keep their text", () => {
  /** The list column as the app draws it: the container every rule here asks. */
  const column = (inner: string, view = "view-ohbox"): string =>
    `<section class="view split ${view}"><div class="list-col" style="width:300px"><div class="scroller"><div class="rows">${inner}</div></div></div></section>`;
  const NO_COLUMN = ".list-col{container:none}";

  const screenerRow = renderToStaticMarkup(
    <MessageRow id="s1" from="Lena Kaufmann" time="08:40" subject="Kleine Ergänzung" preview="Nochmals kurz"
      avatarInitial="L" avatarHue={20} aiSuggestion={{ destLabel: "Screened out", confidence: 0.97 }}
      actions={<button type="button" className="scn-act scn-act-yes">Accept</button>} />,
  );
  const readScreener = () => {
    const name = document.querySelector(".who") as HTMLElement;
    const text = document.querySelector(".sr-main, .row-top")!.getBoundingClientRect();
    const act = document.querySelector(".scn-act")!.getBoundingClientRect();
    return { nameCut: name.scrollWidth > name.clientWidth + 0.5, below: act.top >= text.bottom - 1 };
  };

  it("the Screener's Accept stands under the row's text, and the name is whole", async () => {
    const r = await onPage(doc(column(screenerRow, "view-screener")), readScreener);
    expect(r.below, "Accept still stands beside the text in a 300px column").toBe(true);
    expect(r.nameCut, "the sender's name is cut").toBe(false);
    // RED CONTROL: without the column container Accept takes the row's side again.
    const pre = await onPage(doc(column(screenerRow, "view-screener"), NO_COLUMN), readScreener);
    expect(pre.below, "the column rule no longer decides this — this arm measures nothing").toBe(false);
  }, 60_000);

  const historyRow = renderToStaticMarkup(
    <MessageRow id="h1" from="Brandung Records" time="10:20" subject="Your tickets — Sommernacht Open Air" preview="2 × Stehplatz"
      place="ohmail/Receipts" amount="CHF 96.00" />,
  );
  const readHistory = () => {
    const subj = document.querySelector(".subj") as HTMLElement;
    const place = document.querySelector(".badge.place") as HTMLElement | null;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(14);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    subj.appendChild(probe);
    const floor = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      subj: subj.getBoundingClientRect().width, floor,
      placeShown: !!place && getComputedStyle(place).display !== "none" && place.getBoundingClientRect().width > 0,
    };
  };

  it("a History row's place badge leaves first, and the subject has the room it held", async () => {
    const r = await onPage(doc(column(historyRow, "view-history")), readHistory);
    expect(r.placeShown, "the place badge still takes the subject's room").toBe(false);
    expect(r.subj, "the subject is cut under 14ch").toBeGreaterThanOrEqual(r.floor - 1);
    const pre = await onPage(doc(column(historyRow, "view-history"), NO_COLUMN), readHistory);
    expect(pre.placeShown, "the column rule no longer decides this — this arm measures nothing").toBe(true);
  }, 60_000);

  it("above a 380px column a place badge stays whole, as every badge (LOOK UGLY 2)", async () => {
    const row = renderToStaticMarkup(
      <MessageRow id="h2" from="Brandung Records" time="10:20" subject="Tickets" preview="2 × Stehplatz"
        place="ohmail/Receipts/Tickets" amount="CHF 96.00" threadCount={4} hasAttachment
        tags={[{ name: "Paperwork", hue: "ochre" as const }]} />,
    );
    const html = `<section class="view split view-history"><div class="list-col" style="width:400px"><div class="scroller"><div class="rows">${row}</div></div></div></section>`;
    const read = () => {
      const b = document.querySelector(".badge.place") as HTMLElement;
      return { shown: b.getBoundingClientRect().width > 0, cut: b.scrollWidth > b.clientWidth + 0.5 };
    };
    const r = await onPage(doc(html), read);
    expect(r.shown, "no place badge in a 400px column — this arm measures nothing").toBe(true);
    expect(r.cut, "the place badge is cut to an ellipsis at a wide width").toBe(false);
    const pre = await onPage(doc(html, ".row .badges > .bdg-tail > .badge.place{display:block;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"), read);
    expect(pre.cut, "the ellipsis rule no longer cuts it here — this arm measures nothing").toBe(true);
  }, 60_000);

  const aiChip = `<div class="reads-chip-row">${renderToStaticMarkup(
    <Chip variant="ai" actions={[{ label: "Approve", onPress: () => {} }, { label: "Correct", onPress: () => {} }]}>
      News — AI 0.87: newsletter fingerprint
    </Chip>,
  )}</div>`;
  const readChip = () => {
    const chip = document.querySelector(".chip") as HTMLElement;
    const textNode = [...chip.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim())!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const lines = range.getClientRects().length;
    const textBottom = range.getBoundingClientRect().bottom;
    const act = chip.querySelector(".mini")!.getBoundingClientRect();
    return { lines, actionsBelow: act.top >= textBottom - 1 };
  };

  it("the News AI chip in a 300px column: the sentence across the chip, Approve · Correct under it", async () => {
    const r = await onPage(doc(column(aiChip, "view-reads")), readChip);
    expect(r.actionsBelow, "the verbs still stand beside the sentence").toBe(true);
    expect(r.lines, "the sentence still stacks word by word").toBeLessThanOrEqual(2);
    const pre = await onPage(doc(column(aiChip, "view-reads"), NO_COLUMN), readChip);
    expect(pre.lines, "the replaced shape no longer stacks — this arm measures nothing").toBeGreaterThan(2);
  }, 60_000);

  const reader = `<!--x--><div class="read-col" style="width:364px;height:600px;overflow:auto"><button type="button" class="read-col-close">×</button>
    <article class="msg"><div class="msg-from"><button type="button" class="msg-sender"><span class="av s">P</span><b>Petra Wyss</b><small><span>${ADDR}</span></small></button>
    <span class="t num"><span class="msg-menu"><button type="button" class="msg-more">⋯</button></span><button type="button" class="stamp-toggle"><time>10:39</time></button></span></div>
    <h2>Invitation: Tech check</h2></article></div>`;
  const readClose = () => {
    const c = document.querySelector(".read-col-close")!.getBoundingClientRect();
    const h = document.querySelector(".msg-from")!.getBoundingClientRect();
    return { centreGap: Math.abs((c.top + c.bottom) / 2 - (h.top + h.bottom) / 2), clear: c.right <= h.left + 0.5, shown: c.width > 0 };
  };

  it("the inline reader's close shares the one-line header's row, at its left, under a thumb", async () => {
    const page = await browser!.newPage({ viewport: { width: 800, height: 700 }, isMobile: true, hasTouch: true });
    try {
      const head = '<meta name="viewport" content="width=device-width,initial-scale=1">';
      await page.setContent(doc(reader).replace("<head>", `<head>${head}`));
      const r = await page.evaluate(readClose);
      expect(r.shown, "no close under a coarse pointer in the band — this arm measures nothing").toBe(true);
      expect(r.centreGap, "the close is not on the header's row").toBeLessThanOrEqual(4);
      expect(r.clear, "the close stands over the header").toBe(true);
      // RED CONTROL: the ladder's first placement put it on a row of its own above the header.
      await page.setContent(doc(reader, "@media (pointer: coarse){.read-col-close{display:inline-flex !important;margin:10px 10px -48px auto !important}.read-col > .msg > .msg-from{margin-left:0 !important}.read-col > .msg{padding-top:26px !important}}").replace("<head>", `<head>${head}`));
      expect((await page.evaluate(readClose)).centreGap, "the replaced placement is on the header's row — this arm measures nothing").toBeGreaterThan(4);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("hand back 1: the keyboard, the accessibility tree, the Screener at 360", () => {
  it("a short card's pill is out of sight at rest and reachable by Tab, drawn on keyboard focus (H1)", async () => {
    const html = doc(cardMarkup(386).replace('class="scast', 'class="scast short'));
    const read = async (extra: string) => {
      const page = await browser!.newPage({ viewport: { width: 600, height: 700 } });
      try {
        await page.setContent(doc(cardMarkup(386).replace('class="scast', 'class="scast short'), extra));
        const rest = await page.evaluate(() => getComputedStyle(document.querySelector(".sc-x")!).opacity);
        await page.keyboard.press("Tab");
        return await page.evaluate((r) => {
          const x = document.querySelector(".sc-x") as HTMLElement;
          const box = x.getBoundingClientRect(), card = document.querySelector(".scast")!.getBoundingClientRect();
          return { rest: r, focused: document.activeElement === x, drawn: getComputedStyle(x).opacity, inCard: box.bottom <= card.bottom + 0.5, cardH: card.height };
        }, rest);
      } finally {
        await page.close();
      }
    };
    void html;
    const r = await read("");
    expect(r.rest, "the pill is drawn on a card whose mail fits").toBe("0");
    expect(r.focused, "Tab does not reach the short card's pill").toBe(true);
    expect(r.drawn, "the focused pill is not drawn").toBe("1");
    expect(r.inCard).toBe(true);
    const pre = await read(".scast.short .sc-x{display:none !important}");
    expect(pre.focused, "red control: the hidden pill is still reached — this arm measures nothing").toBe(false);
  }, 60_000);

  it("the focused pill covers no line of the card's text (VERIFY L2)", async () => {
    const body = "Sommernacht Open Air. Your tickets are attached and in your wallet. Rain or shine; the lake stage has never cancelled.";
    const read = async (extra: string) => {
      const page = await browser!.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
      try {
        await page.setContent(doc(cardMarkup(358, { body }).replace('class="scast', 'class="scast short'), extra));
        await page.keyboard.press("Tab");
        return await page.evaluate(() => {
          const x = document.querySelector(".sc-x")!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(".sc-body")!);
          const t = range.getBoundingClientRect();
          return { drawn: getComputedStyle(document.querySelector(".sc-x")!).opacity === "1", overText: x.top < t.bottom - 0.5 };
        });
      } finally {
        await page.close();
      }
    };
    const r = await read("");
    expect(r.drawn, "premise: the pill is drawn under keyboard focus").toBe(true);
    expect(r.overText, "the focused pill sits over the card's last line").toBe(false);
    const pre = await read(".scast.short:not(.open):not(.pend):has(> .sc-x:focus-visible){padding-bottom:0}");
    expect(pre.overText, "red control: without the room the pill no longer covers text — this arm measures nothing").toBe(true);
  }, 60_000);

  it("a card head's clipped address stays in the accessibility tree (LOW 3)", async () => {
    const page = await browser!.newPage({ viewport: { width: 600, height: 700 } });
    try {
      await page.setContent(doc(cardMarkup(300)));
      const tree = await page.locator(".sc-head").ariaSnapshot();
      expect(tree, "the hidden address left the card head's accessible text").toContain("tickets@harbour-supply.invalid");
      const geo = await page.evaluate(() => (document.querySelector(".sc-line .addr") as HTMLElement).getBoundingClientRect().width);
      expect(geo, "premise: the address is out of sight on a 248px line").toBeLessThanOrEqual(1);
      await page.setContent(doc(cardMarkup(300), ".sc-line .addr{display:none !important}"));
      expect(await page.locator(".sc-head").ariaSnapshot(), "red control").not.toContain("tickets@harbour-supply.invalid");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the Screener at a 344px column: the suggestion's cut shows an ellipsis and the time stays on its line (LOW 4)", async (ctx) => {
    skipUnlessMeasuredFont(uiFont, ctx);
    const row = renderToStaticMarkup(
      <MessageRow id="s2" from="JackpotJodel Promo" time="Mo. 06:58" subject="Sie haben 3 Freispiele gewonnen" preview="x"
        avatarInitial="J" avatarHue={20} aiSuggestion={{ destLabel: "Aussortiert und noch etwas länger", confidence: 0.97 }}
        actions={<button type="button" className="scn-act scn-act-yes">Übernehmen</button>} />,
    );
    const html = `<section class="view split view-screener"><div class="list-col" style="width:344px"><div class="scroller"><div class="rows">${row}</div></div></div></section>`;
    const read = () => {
      const chip = document.querySelector(".sr-chips > .badge") as HTMLElement;
      const top = document.querySelector(".row-top")!.getBoundingClientRect();
      const t = document.querySelector(".row-top .t")!.getBoundingClientRect();
      return { chipBlock: getComputedStyle(chip).display === "block", chipCut: chip.scrollWidth > chip.clientWidth, timeOut: t.right > top.right + 0.5 };
    };
    const r = await onPage(doc(html), read);
    expect(r.chipCut, "premise: the suggestion is cut in this column").toBe(true);
    expect(r.chipBlock, "the cut badge is a flex box, which draws no ellipsis").toBe(true);
    expect(r.timeOut, "the time leaves its line").toBe(false);
    const pre = await onPage(doc(html, ".row-top .who{min-width:min(100%,12ch)}.sr-chips > .badge{display:inline-flex}"), read);
    expect(pre.chipBlock || !pre.timeOut, "red control: the replaced rules no longer show the defect").toBe(false);
  }, 60_000);
});

/**
 * THE SCREENER'S HEADS COVER NO LETTER AND NO ROW (a tester, 0.30.8: the newest held letter's subject
 * half under the "Screened · N held" bar). The real `ScreenerView` on a mirror, bundled and mounted
 * in Chromium: the newest letter's sender line lands below the sticky decision bar, and the list's
 * first row below the list's head, in both looks and at every width, after the cursor's walk too.
 */
describe("the Screener: the newest letter clears the decision bar, the first row the list head", () => {
  const SCREENER_SHEETS = [
    "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css",
    "packages/ui/src/base.css", "packages/ui/src/primitives/avatar.css", "packages/ui/src/primitives/address-text.css",
    "packages/ui/src/composites/row.css", "packages/ui/src/composites/list-pane.css", "packages/ui/src/composites/message.css",
    "packages/ui/src/composites/decision-bar.css", "apps/webapp/app/app.css",
  ].map(css).join("\n");
  let js = "";
  beforeAll(async () => {
    const { build } = await import("esbuild");
    const out = await build({
      stdin: {
        resolveDir: resolve(process.cwd(), "apps/webapp"), loader: "tsx",
        contents: `import { createElement as h, useEffect, useState } from "react"; import { createRoot } from "react-dom/client";
          import { NextIntlClientProvider } from "next-intl"; import { OhmailEngine, MemoryMirrorStore } from "@ohmail/client-engine";
          import { ThemeProvider } from "@ohmail/ui"; import messages from "./messages/en.json";
          import { useScreenerState } from "./app/shell/screener-state"; import { ScreenerView } from "./app/views/ScreenerView";
          import { KeymapProvider } from "./app/shell/keymap"; import { withBodyDoor } from "./test/_body-door";
          const NOW = new Date("2026-08-10T12:00:00.000Z");
          const msg = (s, i) => ({ id: "m" + s + "-" + i, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
            subject: "Offer " + s + "/" + i + ": quarry invoice glacier review", from: { name: "Vane Offers " + s, address: "offers" + s + "@vane.invalid" },
            to: [], cc: [], date: new Date(Date.parse("2026-08-10T11:00:00Z") - s * 3600e3 - i * 60e3).toISOString(), folder: "ohmail/Screened",
            snippet: "s", unread: true, body: "Thistle review invoice garden beacon ember pantry glacier harbour. ".repeat(s + i === 0 ? 120 : 10),
            hasAttachments: false,
            attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
            triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-10T09:00:00.000Z" });
          window.mountScreener = async (host, full) => {
            const store = new MemoryMirrorStore(); await store.load(); let seq = 0;
            const all = Array.from({ length: 24 }, (_, s) => Array.from({ length: s === 0 ? 80 : 2 }, (_, i) => msg(s, i))).flat();
            await store.applyChanges(all.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
            const engine = new OhmailEngine({ store, now: () => NOW, adapter: {
              sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
              mutate: async () => ({ changes: [], seq: null }), withdrawSend: async () => ({ outcome: "unsupported" }),
              fetchBody: async () => ({ text: "x", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }) } });
            function Probe() {
              const [v, setV] = useState(0);
              useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
              const state = useScreenerState(engine, v, () => {});
              const [sel, setSel] = useState({ waiting: null, screened: null, spam: null });
              return h(ScreenerView, { owed: false, state, segment: "screened", settled: true,
                selection: { ...sel, screened: sel.screened ?? state.screenedOut[0]?.id ?? null },
                onSelect: (s, id) => setSel((m) => ({ ...m, [s]: id })), hydrateBody: () => {}, hydrateBodies: () => {}, full, onFull: () => {} });
            }
            createRoot(host).render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW,
              children: h(ThemeProvider, { storageKey: null, children: withBodyDoor(engine, h(KeymapProvider, { children: h(Probe) })) }) }));
          };`,
      },
      bundle: true, write: false, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic",
      loader: { ".css": "empty", ".svg": "empty" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
    });
    js = out.outputFiles[0]!.text;
  }, 120_000);

  type Box = { top: number; bottom: number };
  type Heads = { bar: Box; line: Box; subject: Box; col: Box; head: Box | null; scroller: Box | null; row: Box | null; newest: string };
  const readHeads = (): Heads => {
    const box = (sel: string): Box | null => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom } : null;
    };
    const cards = document.querySelectorAll(".view-screener .scn-read .hmail");
    const last = cards[cards.length - 1]!;
    const r = (e: Element): Box => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom });
    const listShown = (document.querySelector(".view-screener .list-col") as HTMLElement | null)?.offsetParent != null;
    return {
      bar: box(".view-screener .scn-read > .decide")!, line: r(last.querySelector(".hm-line")!), subject: r(last.querySelector("h2")!),
      col: box(".view-screener .scn-read")!, head: listShown ? box(".view-screener .list-col .scn-head") : null,
      scroller: listShown ? box(".view-screener .list-col .scroller") : null,
      row: listShown ? box(".view-screener .list-col .row .row-top") : null, newest: last.querySelector("h2")!.textContent ?? "",
    };
  };
  async function mount(width: number, height: number, face: string, theme: string): Promise<Page> {
    const page = await browser!.newPage({ viewport: { width, height } });
    const html = `<!doctype html><html data-theme="${theme}"${face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8">
      <style>${SCREENER_SHEETS}</style><style>body{margin:0;font-family:system-ui,sans-serif}#host{height:${height}px;display:flex}</style>
      </head><body><div id="host"></div></body></html>`;
    // A document with an origin: the view reads cookies, which about:blank refuses.
    await page.route("http://screener.invalid/", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://screener.invalid/");
    await page.addScriptTag({ content: "window.process={env:{NODE_ENV:'production'}};" });
    await page.addScriptTag({ content: js });
    await page.evaluate((full) => (window as unknown as { mountScreener: (h: Element, f: boolean) => Promise<void> })
      .mountScreener(document.getElementById("host")!, full), width < 700);
    await page.waitForFunction(() => document.querySelectorAll(".view-screener .scn-read .hmail").length > 0);
    // Settled: the bodies paint after the rows, and the column re-anchors as they grow.
    await page.evaluate(() => new Promise<void>((done) => {
      const read = document.querySelector(".view-screener .scn-read") as HTMLElement;
      let last = "", same = 0, n = 0;
      const tick = () => {
        const now = `${read.scrollTop}:${read.scrollHeight}`;
        same = now === last ? same + 1 : 0;
        last = now;
        if (same >= 10 || ++n > 300) done(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    return page;
  }
  const clear = (h: Heads, where: string) => {
    expect(h.newest, `${where}: premise: the newest letter is the last card`).toContain("Offer 0/0:");
    expect(h.line.top, `${where}: the newest letter's sender line is under the decision bar`).toBeGreaterThanOrEqual(h.bar.bottom - 0.5);
    expect(h.subject.bottom, `${where}: the newest letter's subject is below the column`).toBeLessThanOrEqual(h.col.bottom + 0.5);
    if (h.row && h.head && h.scroller) {
      expect(h.row.top, `${where}: the first row is under the list's head`).toBeGreaterThanOrEqual(h.head.bottom - 0.5);
      expect(h.row.top, `${where}: the first row starts above the list's scrollport`).toBeGreaterThanOrEqual(h.scroller.top - 0.5);
    }
  };

  const LOOKS: ReadonlyArray<[string, string]> = [["ohmarchy", "dark"], ["paper", "light"]];
  const SIZES: ReadonlyArray<[number, number]> = [[390, 760], [800, 700], [1100, 800], [1920, 1080]];
  for (const [face, theme] of LOOKS) {
    for (const [width, height] of SIZES) {
      it(`${face} ${theme} at ${width}px: the newest letter lands below the bar, the first row below the head`, async () => {
        const page = await mount(width, height, face, theme);
        try {
          clear(await page.evaluate(readHeads), `${face} ${width}px`);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

  it("the cursor walked down the list and back leaves the first row clear of the head", async () => {
    const page = await mount(1100, 600, "ohmarchy", "dark");
    try {
      await page.locator(".view-screener .list-col .scroller").focus();
      for (let i = 0; i < 23; i++) await page.keyboard.press("j");
      const walked = await page.evaluate(() => document.querySelector(".view-screener .list-col .scroller")!.scrollTop);
      expect(walked, "premise: the walk scrolled the list").toBeGreaterThan(0);
      for (let i = 0; i < 23; i++) await page.keyboard.press("k");
      clear(await page.evaluate(readHeads), "after the walk");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("red control: the 0.30.8 landing (the newest letter at the column's top) is read as covered", async () => {
    const page = await mount(1920, 1080, "ohmarchy", "dark");
    try {
      const covered = await page.evaluate(() => {
        const read = document.querySelector(".view-screener .scn-read") as HTMLElement;
        const cards = read.querySelectorAll(".hmail");
        const last = cards[cards.length - 1]!;
        read.scrollTop += last.getBoundingClientRect().top - read.getBoundingClientRect().top - 14;
        return last.querySelector(".hm-line")!.getBoundingClientRect().top < read.querySelector(":scope > .decide")!.getBoundingClientRect().bottom;
      });
      expect(covered, "red control: the measurement does not see a letter under the bar").toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
