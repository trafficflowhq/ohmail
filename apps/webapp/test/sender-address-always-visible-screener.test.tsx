import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageRow } from "@ohmail/ui";
import { readAddress, whole } from "./screener-address-measure";

/**
 * ═══ A SENDER'S ADDRESS IS ON SCREEN WHERE A STRANGER IS JUDGED, AT EVERY WIDTH ═══════════════
 *
 * The display name is the sender's to choose; the address, and above all its domain, is the
 * evidence. The list row must show the whole domain, whatever the name says. These row cases
 * preserve the requirement while the current row's address layout is resolved.
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
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
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
