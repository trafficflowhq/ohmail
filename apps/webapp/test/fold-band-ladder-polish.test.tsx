import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Chip, SegmentedControl, StreamCard } from "@ohmail/ui";

/**
 * ═══ THE FOLD BANDS' NARROW LIST COLUMN, AND FOUR SMALL BOXES BESIDE IT ═══════════════════════
 *
 * At 700 and 821 the split list is 300px wide (the two-pane band's clamp). Measured in headless
 * Chromium over the real components and stylesheets: three tabs stand in one row, the draft's provenance wraps at words, the tag helper sits
 * off the add row's rule, and a hidden receipt address is the 1px sr-only box.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/avatar.css",
  "packages/ui/src/primitives/address-text.css",
  "packages/ui/src/primitives/chip.css",
  "packages/ui/src/primitives/seg.css",
  "packages/ui/src/composites/row.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/stream.css",
  "packages/ui/src/composites/settings.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const doc = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body class="mo-canvas">${body}</body></html>`;

async function onPage<T>(html: string, fn: () => T, width = 1280): Promise<T> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  try {
    await page.setContent(html);
    return (await page.evaluate(fn)) as T;
  } finally {
    await page.close();
  }
}

/** A list column of `w` px — the container every row, chip and tab strip in it asks about its room. */
const listCol = (w: number, inner: string): string =>
  `<section class="view view-ohbox"><div class="list-col" style="width:${w}px"><div class="rows">${inner}</div></div></section>`;

describe("the tab strip stays a row in the fold bands' list column", () => {
  const tabs = (cls: string): string => renderToStaticMarkup(
    <SegmentedControl className={cls} role="tablist" ariaLabel="Screener" value="waiting" onChange={() => {}}
      options={[{ id: "waiting", label: "Waiting", count: 3 }, { id: "screened", label: "Screened out", count: 2 }, { id: "spam", label: "Spam", count: 2 }]} />,
  );
  /** The row form's own width against the room its parent gives it — the component's two measurements. */
  const fits = () => {
    const seg = document.querySelector(".seg") as HTMLElement;
    const par = seg.parentElement as HTMLElement;
    const pcs = getComputedStyle(par), scs = getComputedStyle(seg);
    const avail = par.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight)
      - parseFloat(scs.marginLeft) - parseFloat(scs.marginRight);
    const natural = [...seg.querySelectorAll("button")].reduce((a, b) => a + b.getBoundingClientRect().width, 0)
      + parseFloat(scs.paddingLeft) + parseFloat(scs.paddingRight);
    return { avail, natural };
  };

  it("three counted tabs fit in one row in a 265px strip of a narrow list column", async () => {
    const r = await onPage(doc(listCol(300, `<div style="width:265px">${tabs("scn-seg")}</div>`)), fits);
    expect(r.natural, `the row form needs ${r.natural.toFixed(0)}px of ${r.avail.toFixed(0)}`).toBeLessThanOrEqual(r.avail);
  }, 60_000);

  it("the Screener's head gives the strip the room the three tabs need in the 300px column", async () => {
    const html = doc(`<section class="view view-screener"><div class="list-col" style="width:300px"><div class="scn-head">${tabs("scn-seg")}</div></div></section>`);
    const r = await onPage(html, fits);
    expect(r.natural, `the row form needs ${r.natural.toFixed(0)}px of ${r.avail.toFixed(0)}`).toBeLessThanOrEqual(r.avail);
  }, 60_000);

  it("the overflow form wraps into rows rather than one option per line", async () => {
    const html = doc(`<div style="width:200px">${tabs("").replace('class="seg', 'data-stack="" class="seg')}</div>`);
    const tops = await onPage(html, () => [...document.querySelectorAll(".seg button")].map((b) => Math.round(b.getBoundingClientRect().top)));
    expect(new Set(tops).size, `three options on ${new Set(tops).size} lines`).toBeLessThan(tops.length);
  }, 60_000);
});

describe("the draft's provenance is one sentence", () => {
  it("at 300px its lines start at the chip's left edge — it wraps at words, not in columns", async () => {
    const html = doc(`<div class="grounding" style="width:300px">${renderToStaticMarkup(
      <Chip variant="rationale">
        <>Drafted from your <b>14 previous replies to Giulia</b> + KB: “Delivery replies — standard note”</>
      </Chip>,
    )}</div>`);
    const r = await onPage(html, () => {
      const chip = document.querySelector(".chip") as HTMLElement;
      const c = chip.getBoundingClientRect(), pl = parseFloat(getComputedStyle(chip).paddingLeft);
      const lines = new Map<number, number>();
      const tw = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const rg = document.createRange();
        rg.selectNodeContents(n);
        for (const q of rg.getClientRects()) {
          const top = Math.round(q.top);
          lines.set(top, Math.min(lines.get(top) ?? Infinity, q.left));
        }
      }
      const starts = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
      return { lines: starts.length, contentLeft: c.left + pl, starts };
    });
    expect(r.lines, "the fixture does not wrap at all, so the arm says nothing").toBeGreaterThanOrEqual(2);
    for (const s of r.starts.slice(1)) {
      expect(s, `a wrapped line starts at ${s.toFixed(0)}, not at the chip's left ${r.contentLeft.toFixed(0)}`).toBeLessThanOrEqual(r.contentLeft + 1);
    }
  }, 60_000);
});

describe("the provenance keeps its pill on one line", () => {
  const chip = (w: number): string => doc(`<div class="grounding" style="width:${w}px">${renderToStaticMarkup(
    <Chip variant="rationale"><>Drafted from your <b>14 previous replies</b></></Chip>,
  )}</div>`);
  const radius = () => parseFloat(getComputedStyle(document.querySelector(".chip") as HTMLElement).borderTopLeftRadius);
  it("at 1440 a one-line provenance is a pill, as 0.25.16 drew it", async () => {
    expect(await onPage(chip(560), radius, 1440), "the one-line chip lost its pill radius").toBeGreaterThan(20);
  }, 60_000);
  it("under 700px, where it wraps, it takes the card radius", async () => {
    const r = await onPage(chip(266), radius, 390);
    expect(r, "the wrapping chip kept the pill radius").toBeLessThan(20);
    expect(r).toBeGreaterThan(0);
  }, 60_000);
});

describe("Settings › Tags: the add row", () => {
  const pane = (w: number): string => doc(`<div class="set-pane" style="width:${w}px">
    <div class="set-row"><span class="lab"><b>Paperwork</b></span></div>
    <div class="set-row set-tag-edit set-tag-new"><span class="tdot hue-moss"></span>
      <input class="tf set-tag-input" placeholder="Name a new tag…"/>
      <span class="set-tag-acts"><button class="btn primary">Add</button></span></div>
    <p class="set-note-inline">A tag groups messages across Ohbox, News and Receipts without moving them.</p></div>`);
  const read = () => {
    const row = (document.querySelector(".set-tag-new") as HTMLElement).getBoundingClientRect();
    const input = (document.querySelector(".set-tag-input") as HTMLElement).getBoundingClientRect();
    const add = (document.querySelector(".set-tag-acts") as HTMLElement).getBoundingClientRect();
    const note = (document.querySelector(".set-note-inline") as HTMLElement).getBoundingClientRect();
    return { rowBottom: row.bottom, noteTop: note.top, addMid: (add.top + add.bottom) / 2, inputTop: input.top, inputBottom: input.bottom };
  };

  it("the 1440 pane: the helper sits below the add row's rule", async () => {
    const r = await onPage(pane(574), read, 1440);
    expect(r.noteTop, `the helper's box starts ${(r.rowBottom - r.noteTop).toFixed(0)}px inside the row`).toBeGreaterThanOrEqual(r.rowBottom);
  }, 60_000);

  it("the 1024 pane: Add stays on the input's line", async () => {
    const r = await onPage(pane(530), read, 1024);
    expect(r.addMid, "Add wrapped under the input").toBeGreaterThan(r.inputTop);
    expect(r.addMid).toBeLessThan(r.inputBottom);
    expect(r.noteTop).toBeGreaterThanOrEqual(r.rowBottom);
  }, 60_000);
});

describe("a receipt card's hidden address is the 1px sr-only box", () => {
  it("a 390 phone's card: under 14ch of address room the address span is 1px and still in the head's text", async () => {
    const html = doc(`<div style="width:342px">${renderToStaticMarkup(
      <StreamCard id="c1" from="Open-Air Kino Seeblick" address="tickets@kino-seeblick.invalid" subject="Deine Tickets"
        time="09:41" amount="CHF 36.00" body="2 × Liegestuhl" expandLabel="Show more" collapseLabel="Show less" />,
    )}</div>`);
    const r = await onPage(html, () => {
      const span = document.querySelector(".sc-line .addr > span") as HTMLElement | null;
      const b = span?.getBoundingClientRect();
      return { w: b?.width ?? -1, h: b?.height ?? -1, text: document.querySelector(".sc-line")?.textContent ?? "" };
    });
    expect(r.w, "no address span rendered").toBeGreaterThanOrEqual(0);
    expect(r.w, `the hidden address claims ${r.w}px of the line`).toBeLessThanOrEqual(1);
    expect(r.h).toBeLessThanOrEqual(1);
    expect(r.text, "the address left the head's text").toContain("tickets@kino-seeblick.invalid");
  }, 60_000);
});
