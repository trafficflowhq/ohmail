import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderedUiFont, skipUnlessMeasuredFont } from "./_measured-font.js";
import { AddressText, MessageRow } from "@ohmail/ui";

/**
 * ═══ A SENDER'S ADDRESS IS ON SCREEN WHERE A STRANGER IS JUDGED, AT EVERY WIDTH ═══════════════
 *
 * The display name is the sender's to choose; the address, and above all its domain, is the
 * evidence. On a Screener row, in the open message's header and on the Screener's held card the
 * address is drawn with a visible width above zero and its domain whole, whatever the name says.
 * Measured in headless Chromium over the real components and stylesheets; each arm has a red
 * control that re-applies the layout it replaced.
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
  "packages/ui/src/composites/row.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/message.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

/** Sixty characters the sender chose, and invented addresses only. */
const NAME = "Lena Kaufmann of Atelier Eichspan, Customer Care and Billing";
const ADDR = "lena@atelier-eichspan.invalid";
const LONG = "giulia.ferrari.accounts.payable.and.invoicing.department@terracotta-studio.invalid";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
/** The face paper's text renders in here; the arm measured in Inter reads it (`_measured-font.ts`). */
let uiFont = "";
beforeAll(async () => { browser = await chromium.launch(); uiFont = await renderedUiFont(browser); }, 120_000);
afterAll(async () => { await browser?.close(); });

const doc = (body: string, extra = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body class="mo-canvas">${body}</body></html>`;

async function onPage<T>(html: string, fn: (sel: string) => T, arg: string, viewport = { width: 1280, height: 900 }): Promise<T> {
  const page = await browser!.newPage({ viewport });
  try {
    await page.setContent(html);
    return (await page.evaluate(fn, arg)) as T;
  } finally {
    await page.close();
  }
}

type Reading = { visibleW: number; domainW: number; domainVisibleW: number; domainLines: number; inside: boolean; nameEm: number };

/** The address text inside `sel` as a person sees it: its rects against every clipping ancestor. */
const readAddress = (sel: string): Reading => {
  const host = document.querySelector(sel) as HTMLElement | null;
  if (!host) return { visibleW: -1, domainW: -1, domainVisibleW: -1, domainLines: 0, inside: false, nameEm: -1 };
  const hidden = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.display === "none" || c.visibility !== "visible" || c.clipPath === "inset(50%)") return true;
    }
    return false;
  };
  const clipOf = (el: Element) => {
    let L = -Infinity, R = Infinity, T = -Infinity, B = Infinity;
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = getComputedStyle(a), r = a.getBoundingClientRect();
      if (c.overflowX !== "visible") { L = Math.max(L, r.left); R = Math.min(R, r.right); }
      if (c.overflowY !== "visible") { T = Math.max(T, r.top); B = Math.min(B, r.bottom); }
    }
    return { L, R, T, B };
  };
  const text = host.textContent ?? "";
  const at = text.lastIndexOf("@");
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes: { n: Text; start: number }[] = [];
  let off = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) { nodes.push({ n, start: off }); off += n.data.length; }
  /* Painted width: the union of the text's rects per line (an ellipsised run reports its full box
     AND its cut one), each first cut to the clip it is painted inside. */
  const line = (host.closest(".row-top, .msg-from, .hm-line") as HTMLElement).getBoundingClientRect();
  let inside = true;
  const width = (from: number, to: number, clipped: boolean) => {
    const lines = new Map<number, [number, number][]>();
    for (const { n, start } of nodes) {
      const a = Math.max(from, start), b = Math.min(to, start + n.data.length);
      if (a >= b || hidden(n.parentElement!)) continue;
      const rg = document.createRange();
      rg.setStart(n, a - start);
      rg.setEnd(n, b - start);
      const k = clipOf(n.parentElement!);
      for (const r of rg.getClientRects()) {
        let [l, rr] = [r.left, r.right];
        if (clipped) {
          if (Math.min(r.bottom, k.B) <= Math.max(r.top, k.T)) continue;
          [l, rr] = [Math.max(l, k.L), Math.min(rr, k.R)];
        }
        if (clipped && rr > l && (l < line.left - 0.5 || rr > line.right + 0.5)) inside = false;
        if (rr > l) lines.set(Math.round(r.top), [...(lines.get(Math.round(r.top)) ?? []), [l, rr]]);
      }
    }
    let w = 0;
    for (const spans of lines.values()) {
      spans.sort((x, y) => x[0] - y[0]);
      let [cl, cr] = spans[0]!;
      for (const [l, r] of spans.slice(1)) { if (l <= cr) cr = Math.max(cr, r); else { w += cr - cl; [cl, cr] = [l, r]; } }
      w += cr - cl;
    }
    lines.size && (lastLines = lines.size);
    return w;
  };
  let lastLines = 0;
  const name = host.closest(".row-top, .msg-from, .hm-line")?.querySelector(".who, b") as HTMLElement | null;
  const visibleW = width(0, text.length, true);
  const domainW = width(at, text.length, false);
  const domainLines = lastLines;
  return {
    visibleW, domainW, domainVisibleW: width(at, text.length, true), domainLines, inside,
    nameEm: name ? name.clientWidth / parseFloat(getComputedStyle(name).fontSize) : -1,
  };
};

const whole = (r: Reading, where: string) => {
  expect(r.visibleW, `${where}: the address is not on screen`).toBeGreaterThan(0);
  expect(r.domainW, `${where}: no domain measured`).toBeGreaterThan(0);
  expect(r.domainVisibleW, `${where}: the domain is cut (${r.domainVisibleW} of ${r.domainW}px)`).toBeGreaterThanOrEqual(r.domainW - 0.5);
  expect(r.inside, `${where}: the address runs out of its line`).toBe(true);
};

const screenerRow = (width: number, props: { from?: string; address?: string; addressFirst?: boolean } = {}): string =>
  `<section class="view view-screener"><div class="rows" style="width:${width}px">${renderToStaticMarkup(
    <MessageRow id="s1" from={props.from ?? NAME} address={"address" in props ? props.address : ADDR} addressFirst={props.addressFirst ?? true}
      time="08:40" subject="Kleine Ergänzung" avatarInitial="L" avatarHue={42} />,
  )}</div></section>`;

describe("a Screener row draws the address whatever the name says", () => {
  // A 260px row is the Screener row beside Accept at 1024 and 1440 (a 190px line); 140 is narrower than any layout gives.
  for (const width of [140, 190, 260, 400, 640]) {
    it(`a ${width}px row with a 60-character name: the address is on screen and its domain whole`, async () => {
      const r = await onPage(doc(screenerRow(width)), readAddress, ".row .addr");
      whole(r, `${width}px row`);
      // On its own line an ordinary address is not broken: the domain wraps only where nothing else is left.
      if (width >= 260) expect(r.domainLines, "the domain is broken over lines beside the name").toBe(1);
    }, 60_000);
  }

  it("a long local part takes the ellipsis; the domain stays whole", async () => {
    whole(await onPage(doc(screenerRow(190, { address: LONG })), readAddress, ".row .addr"), "long local part");
  }, 60_000);

  it("a domain wider than the whole line wraps and stays whole rather than be cut", async () => {
    const wide = "a@" + "billing-and-customer-care.".repeat(3) + "invalid";
    whole(await onPage(doc(screenerRow(190, { address: wide })), readAddress, ".row .addr"), "a domain wider than the line");
  }, 60_000);

  it("a nameless sender's name IS the address, drawn by the same rule", async () => {
    whole(await onPage(doc(screenerRow(190, { from: LONG, address: undefined })), readAddress, ".row .who"), "nameless sender");
  }, 60_000);

  /* A hyphenated domain on the 172px line a 390 phone gave the row beside Accept (LOOK BROKEN 1): the
     local part keeps its ellipsis, and the domain is on one line or broken where no hyphen ends a line. */
  const breaks = (sel: string) => {
    const host = document.querySelector(sel) as HTMLElement;
    const line = (host.closest(".row-top") as HTMLElement).getBoundingClientRect().width;
    const local = host.querySelector(".addr-local") as HTMLElement;
    const chars: { c: string; top: number }[] = [];
    const walker = document.createTreeWalker(host.querySelector(".addr-dom")!, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      for (let i = 0; i < t.data.length; i++) {
        const rg = document.createRange();
        rg.setStart(t, i);
        rg.setEnd(t, i + 1);
        chars.push({ c: t.data[i]!, top: Math.round(rg.getBoundingClientRect().top) });
      }
    }
    const ends = chars.flatMap((ch, i) => (i > 0 && ch.top !== chars[i - 1]!.top ? [chars[i - 1]!.c] : []));
    const fs = parseFloat(getComputedStyle(local).fontSize);
    return { line, localW: local.clientWidth, localCut: local.scrollWidth > local.clientWidth + 0.5, ch: fs * 0.5, ends };
  };
  for (const address of ["win@jackpotjodel-alerts.invalid", "billing@atelier-eichspan-and-sons-customer-care.invalid"]) {
    it(`a 172px line: ${address.length} characters with a hyphenated domain keep the local part's ellipsis and no line ends at a hyphen`, async () => {
      const html = doc(screenerRow(273, { address }));
      const r = await onPage(html, readAddress, ".row .addr");
      whole(r, "172px line");
      const b = await onPage(html, breaks, ".row .addr");
      expect(Math.round(b.line), "the fixture is not the 390 phone's 172px line").toBeGreaterThanOrEqual(171);
      expect(Math.round(b.line)).toBeLessThanOrEqual(173);
      expect(b.localW, "the local part is erased").toBeGreaterThan(b.ch);
      if (b.localCut) expect(b.localW, "the local part is cut without room for its ellipsis").toBeGreaterThanOrEqual(2 * b.ch);
      expect(b.ends, "a line of the domain ends at its own hyphen").not.toContain("-");
    }, 60_000);
  }

  /* A local part narrower than 3ch is drawn at its own width: a floor there pads it, and the padding
     reads as a space before the "@" in a proportional face (LOOK-2 UGLY 1). */
  for (const address of ["win@jackpotjodel-alerts.invalid", "hi@atelier-eichspan.invalid"]) for (const width of [273, 400]) {
    it(`a short local part (${address.split("@")[0]}) on a ${width}px row shows no gap before the @ and keeps the address on one line`, async () => {
      const lines = await onPage(doc(screenerRow(width, { address })), readAddress, ".row .addr");
      whole(lines, `${width}px row`);
      expect(lines.domainLines, "the domain wraps while the line still had room for it").toBe(1);
      const pad = await onPage(doc(screenerRow(width, { address })), (sel) => {
        const l = document.querySelector(sel) as HTMLElement;
        const rg = document.createRange();
        rg.selectNodeContents(l);
        return l.getBoundingClientRect().width - rg.getBoundingClientRect().width;
      }, ".row .addr-local");
      expect(pad, "the local part's box is wider than its text").toBeLessThanOrEqual(0.5);
    }, 60_000);
  }

  it("the address sits with the name: no gap between the name's line and the address's", async () => {
    const gaps = () => {
      const who = document.querySelector(".row .who")!.getBoundingClientRect();
      const addr = document.querySelector(".row .addr")!.getBoundingClientRect();
      const subj = document.querySelector(".row .subj")!.getBoundingClientRect();
      return { nameToAddr: addr.top - who.bottom, addrToSubj: subj.top - addr.bottom };
    };
    const g = await onPage(doc(screenerRow(400)), gaps, "");
    expect(g.nameToAddr, "the wrap opens a gap under the name").toBeLessThanOrEqual(0.5);
    expect(g.nameToAddr, "the address is nearer the subject than the name").toBeLessThanOrEqual(g.addrToSubj);
    // The subject stands 4px under the address (LOOK-2 POLISH), the address flush under the name.
    expect(g.addrToSubj - g.nameToAddr, "the subject is not set apart from the name and its address").toBeGreaterThanOrEqual(3.5);
  }, 60_000);

  it("in the two-pane band (700-1023) the Screener row keeps its address", async () => {
    const r = await onPage(doc(screenerRow(268)), readAddress, ".row .addr", { width: 800, height: 900 });
    whole(r, "the band at 800");
    const pre = await onPage(doc(screenerRow(268), "@media (min-width:700px) and (max-width:1023.98px){.view-screener .row .row-top .addr{display:none}}"), readAddress, ".row .addr", { width: 800, height: 900 });
    expect(pre.visibleW, "red control: the band's old rule no longer hides the address — this arm measures nothing").toBe(0);
  }, 60_000);

  it("RED CONTROL: the same row without `addressFirst` (the 0.25.17 candidate's Screener row) draws no address", async () => {
    const r = await onPage(doc(screenerRow(190, { addressFirst: false })), readAddress, ".row .addr");
    expect(r.visibleW, "the generic row no longer hides the address on a 190px line — this arm measures nothing").toBe(0);
  }, 60_000);
});

const header = (width: number, name: string, address: string): string => `<article class="msg" style="width:${width + 68}px;max-width:none">
    <div class="msg-from">
      <button type="button" class="msg-sender"><span class="av s">G</span><b>${name}</b><small>${renderToStaticMarkup(<AddressText address={address} />)}</small></button>
      <span class="t num"><span class="msg-menu"><button type="button" class="msg-more">⋯</button></span><button type="button" class="stamp-toggle"><time>21 Sep</time></button></span>
      <p class="msg-from-line">from ${address}</p>
    </div></article>`;
/** The 0.25.17 candidate's header rules: the address shrinks first, cut by an ellipsis at its end. */
const PRE_HEADER = ".msg-from b{flex:0 1 auto}.msg-from small{flex:0 100 auto;min-width:14ch;max-width:none}.msg-from small > span{display:block;overflow:hidden;text-overflow:ellipsis}.msg-from .addr-dom{white-space:nowrap}";

describe("the open message's header draws the address whatever the name says", () => {
  for (const width of [430, 504, 572]) {
    it(`a ${width}px header with a long local part: the domain whole, the name kept to ≥ 2.5em`, async () => {
      const r = await onPage(doc(header(width, NAME, LONG)), readAddress, ".msg-from small");
      whole(r, `${width}px header`);
      expect(r.nameEm, "the name is crushed under 2.5em").toBeGreaterThanOrEqual(2.5);
    }, 60_000);
  }

  it("a 60-character name and an ordinary address: the address is not cut at all, it takes the line under the name", async () => {
    for (const width of [430, 572]) {
      const html = doc(header(width, NAME, ADDR));
      whole(await onPage(html, readAddress, ".msg-from small"), `${width}px header`);
      const cut = await onPage(html, () => [...document.querySelectorAll(".msg-from small *")].some((e) => e.scrollWidth > e.clientWidth + 0.5), "");
      expect(cut, `the address is cut in a ${width}px header where its own line holds it`).toBe(false);
    }
  }, 60_000);

  it("a short name leaves the address whole where the line has room for it", async () => {
    const r = await onPage(doc(header(572, "Bo", ADDR)), readAddress, ".msg-from small");
    whole(r, "572px header, a two-letter name");
    const cut = await onPage(doc(header(572, "Bo", ADDR)), () => [...document.querySelectorAll(".msg-from small *")].some((e) => e.scrollWidth > e.clientWidth + 0.5), "");
    expect(cut, "the address is cut beside free room").toBe(false);
  }, 60_000);

  it("under 420px the address stands on its own line, whole", async () => {
    whole(await onPage(doc(header(360, NAME, LONG)), readAddress, ".msg-from-line"), "360px header");
  }, 60_000);

  it("RED CONTROL: the candidate's header cuts the domain away at 572px", async (ctx) => {
    skipUnlessMeasuredFont(uiFont, ctx);
    const r = await onPage(doc(header(572, NAME, LONG), PRE_HEADER), readAddress, ".msg-from small");
    expect(r.domainVisibleW, "the replaced header no longer cuts the domain — this arm measures nothing").toBeLessThan(r.domainW - 0.5);
  }, 60_000);
});

const held = (width: number, plain: boolean, name = NAME, address = LONG): string => {
  const who = `<b>${name}</b><span class="addr">${renderToStaticMarkup(<AddressText address={address} />)}</span>`;
  return `<article class="hmail" style="width:${width + 52}px"><div class="hm-line">${plain ? `<span class="hm-name">${who}</span>` : `<button type="button" class="hm-who">${who}</button>`}<span class="t num">08:40</span></div><h2>Kleine Ergänzung</h2></article>`;
};

describe("the Screener's held card draws the address whatever the name says", () => {
  for (const width of [300, 440, 560]) for (const plain of [false, true]) for (const name of [NAME, "Ines Roth"]) {
    it(`a ${width}px held card (${plain ? "plain line" : "the sender press"}, a ${name.length}-character name): the domain whole on one line, the name ≥ 2.5em`, async () => {
      const r = await onPage(doc(held(width, plain, name)), readAddress, ".hm-line .addr");
      whole(r, `${width}px held card`);
      expect(r.domainLines, "the domain is broken over lines while the local part has room to give").toBe(1);
      expect(r.nameEm, "the name is crushed under 2.5em").toBeGreaterThanOrEqual(2.5);
    }, 60_000);
  }

  it("a 60-character name and an ordinary address: the address is not cut at all on a 440px card", async () => {
    const html = doc(held(440, false, NAME, ADDR));
    whole(await onPage(html, readAddress, ".hm-line .addr"), "440px held card");
    const cut = await onPage(html, () => [...document.querySelectorAll(".hm-line .addr *")].some((e) => e.scrollWidth > e.clientWidth + 0.5), "");
    expect(cut, "the address is cut where its own line holds it").toBe(false);
  }, 60_000);

  it("RED CONTROL: the card's old line lets the name push the address out", async () => {
    const pre = ".hm-line :is(.hm-who,.hm-name) b{flex:0 1 auto;min-width:auto}.hm-line :is(.hm-who,.hm-name) .addr{flex:1 1 0;max-width:none;overflow:hidden}.hm-line :is(.hm-who,.hm-name){flex-wrap:nowrap}.hm-line .addr-text{display:inline}";
    const r = await onPage(doc(held(440, false), pre), readAddress, ".hm-line .addr");
    expect(r.domainVisibleW, "the replaced line no longer cuts the domain — this arm measures nothing").toBeLessThan(r.domainW - 0.5);
  }, 60_000);
});
