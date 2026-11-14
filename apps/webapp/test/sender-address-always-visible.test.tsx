import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderedUiFont, skipUnlessMeasuredFont } from "./_measured-font.js";
import { MessageHead } from "@ohmail/ui/mail";
import { DEVICES, entryCss, fontsCss, type Device } from "../../../packages/ui/test/compare/harness.js";

/**
 * ═══ A SENDER'S ADDRESS IS ON SCREEN WHERE A STRANGER IS JUDGED, AT EVERY WIDTH ═══════════════
 *
 * The display name is the sender's to choose; the address, and above all its domain, is the
 * evidence. In the open message's header the address is drawn with a visible width above zero and
 * its domain whole, whatever the name says. Measured in headless Chromium over the head the reader
 * draws (the kit's `MessageHead`, handed the sender as `packages/app/src/reader/Letter.tsx` hands
 * it) in the mail entry's own stylesheets and typefaces, with the root a desktop or a phone carries;
 * each arm has a red control that re-applies the layout it replaced. (The Screener's row and held
 * card: `sender-address-always-visible-screener.test.tsx`.)
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

/** Sixty characters the sender chose, and invented addresses only. */
const NAME = "Lena Kaufmann of Atelier Eichspan, Customer Care and Billing";
const ADDR = "lena@atelier-eichspan.invalid";
const LONG = "giulia.ferrari.accounts.payable.and.invoicing.department@terracotta-studio.invalid";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
/** The face paper's text renders in here; the arm measured in Inter reads it (`_measured-font.ts`). */
let uiFont = "";
beforeAll(async () => { browser = await chromium.launch(); uiFont = await renderedUiFont(browser); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** The page: the mail entry's sheets and faces, the root as `device` carries it, the head in a box `width` wide. */
const doc = async (width: number, body: string, device: Device, extra = ""): Promise<string> => {
  const root = { "data-face": "paper", "data-scheme": "light", ...DEVICES[device].root, "data-icons": "1", "data-rm": "1" };
  const attrs = Object.entries(root).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<!doctype html><html lang="en"${attrs}><head><meta charset="utf-8">
<style>${await fontsCss()}</style><style>${await entryCss("mail")}</style><style>html,body{margin:0}${extra}</style></head>
<body><div class="oh-root"><div style="width:${width}px">${body}</div></div></body></html>`;
};

async function onPage<T>(html: string, fn: (sel: string) => T, arg: string, device: Device): Promise<T> {
  const [width, height] = DEVICES[device].window;
  const page = await browser!.newPage({ viewport: { width, height } });
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
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
     AND its cut one), each first cut to the clip it is painted inside. The line is the sender's:
     the head's who line, name and address. */
  const line = (host.closest(".oh-messagehead-who") as HTMLElement).getBoundingClientRect();
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
  const name = host.closest(".oh-messagehead-who")?.querySelector("b") as HTMLElement | null;
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

/** The sender's address as the head draws it. */
const ADDRESS = ".oh-messagehead-address";

/**
 * The open message's head as the reader hands it the sender (`Letter.tsx`: the name, the address, a press to the
 * contact card), with its menu, its time, its recipients and its details folded. A head under 420px is a phone's
 * (the root a phone carries: a finger's head).
 */
const header = (width: number, name: string, address: string, extra = ""): Promise<string> =>
  doc(
    width,
    renderToStaticMarkup(
      <MessageHead
        sender={{ name, address }}
        menu={{ label: "Message" }}
        stamp={{ when: "21 Sep", full: false, title: "Mon 21 Sep 2026 08:40" }}
        to={[{ word: "to", people: [{ name: "you" }] }]}
        details={{ label: "details", open: false, lines: [] }}
      />,
    ),
    deviceAt(width),
    extra,
  );
const deviceAt = (width: number): Device => (width < 420 ? "phone" : "desktop");
/** The 0.25.17 candidate's header rules, on the head's own parts: the address shrinks first, cut by an ellipsis at its end. */
const PRE_HEADER = ".oh-messagehead-name{flex:0 1 auto}.oh-messagehead-address{flex:0 100 auto;min-width:14ch;max-width:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
/**
 * The address as ONE RUN of text, as the candidate's and the plain line's heads drew it: the kit's address part now
 * draws its two halves as boxes of their own (`AddressText`), so a control that puts an old line's rules on the head's
 * address host also lays its halves back into that one run, or the halves' own rules would measure the fix instead.
 */
const ONE_RUN = `${ADDRESS} :is(.oh-address,.oh-address-local,.oh-address-domain,.oh-address-held){display:inline;flex:none;min-width:0;max-width:none;overflow:visible;text-overflow:clip;white-space:inherit;word-break:normal}`;

describe("the open message's header draws the address whatever the name says", () => {
  for (const width of [430, 504, 572]) {
    it(`a ${width}px header with a long local part: the domain whole, the name kept to ≥ 2.5em`, async () => {
      const r = await onPage(await header(width, NAME, LONG), readAddress, ADDRESS, deviceAt(width));
      whole(r, `${width}px header`);
      expect(r.nameEm, "the name is crushed under 2.5em").toBeGreaterThanOrEqual(2.5);
    }, 60_000);
  }

  it("a 60-character name and an ordinary address: the address is not cut at all, it takes the line under the name", async () => {
    for (const width of [430, 572]) {
      const html = await header(width, NAME, ADDR);
      whole(await onPage(html, readAddress, ADDRESS, deviceAt(width)), `${width}px header`);
      const cut = await onPage(html, (sel) => [document.querySelector(sel)!, ...document.querySelectorAll(`${sel} *`)].some((e) => e.scrollWidth > e.clientWidth + 0.5), ADDRESS, deviceAt(width));
      expect(cut, `the address is cut in a ${width}px header where its own line holds it`).toBe(false);
    }
  }, 60_000);

  it("a short name leaves the address whole where the line has room for it", async () => {
    const html = await header(572, "Bo", ADDR);
    const r = await onPage(html, readAddress, ADDRESS, deviceAt(572));
    whole(r, "572px header, a two-letter name");
    const cut = await onPage(html, (sel) => [document.querySelector(sel)!, ...document.querySelectorAll(`${sel} *`)].some((e) => e.scrollWidth > e.clientWidth + 0.5), ADDRESS, deviceAt(572));
    expect(cut, "the address is cut beside free room").toBe(false);
  }, 60_000);

  it("under 420px the address stands on its own line, whole", async () => {
    whole(await onPage(await header(360, NAME, LONG), readAddress, ADDRESS, deviceAt(360)), "360px header");
  }, 60_000);

  /** The address's local part: how many lines it is drawn on. */
  const localPart = (sel: string) => {
    const host = document.querySelector(sel) as HTMLElement;
    const text = host.textContent ?? "";
    const at = text.lastIndexOf("@");
    const tops: number[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      for (let i = off; i < Math.min(at, off + n.data.length); i++) {
        const rg = document.createRange();
        rg.setStart(n, i - off);
        rg.setEnd(n, i - off + 1);
        const r = rg.getBoundingClientRect();
        if (r.width > 0) tops.push(Math.round(r.top));
      }
      off += n.data.length;
    }
    return { lines: new Set(tops).size };
  };

  for (const width of [240, 300, 360]) {
    it(`a ${width}px header's own address line never breaks the local part`, async () => {
      const html = await header(width, NAME, LONG);
      whole(await onPage(html, readAddress, ADDRESS, deviceAt(width)), `${width}px from line`);
      expect(await onPage(html, localPart, ADDRESS, deviceAt(width)), `${width}px from line`).toEqual({ lines: 1 });
    }, 60_000);
  }

  it("an ordinary address on the 360px header's own line is not cut at all", async () => {
    const html = await header(360, NAME, ADDR);
    whole(await onPage(html, readAddress, ADDRESS, deviceAt(360)), "360px from line");
    const cut = await onPage(html, (sel) => [document.querySelector(sel)!, ...document.querySelectorAll(`${sel} *`)].some((e) => e.scrollWidth > e.clientWidth + 0.5), ADDRESS, deviceAt(360));
    expect(cut, "the address is cut where its own line holds it").toBe(false);
  }, 60_000);

  it("RED CONTROL: the plain-text line that wraps anywhere breaks a long local part", async () => {
    const html = await header(240, NAME, LONG, `${ADDRESS}{display:block;white-space:normal;overflow-wrap:anywhere}${ONE_RUN}`);
    expect((await onPage(html, localPart, ADDRESS, deviceAt(240))).lines, "the old line no longer breaks the local part — this arm measures nothing").toBeGreaterThan(1);
  }, 60_000);

  it("RED CONTROL: the candidate's header cuts the domain away at 572px", async (ctx) => {
    skipUnlessMeasuredFont(uiFont, ctx);
    const r = await onPage(await header(572, NAME, LONG, PRE_HEADER + ONE_RUN), readAddress, ADDRESS, deviceAt(572));
    expect(r.domainVisibleW, "the replaced header no longer cuts the domain — this arm measures nothing").toBeLessThan(r.domainW - 0.5);
  }, 60_000);
});
