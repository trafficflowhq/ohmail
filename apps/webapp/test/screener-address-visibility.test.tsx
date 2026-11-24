import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageHead, Row } from "@ohmail/ui/mail";
import { DEVICES, entryCss, fontsCss } from "../../../packages/ui/test/compare/harness.js";
import { launch } from "../../../test/compare/render.mjs";

import { readAddress, whole } from "./screener-address-measure";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
/** Sixty characters the sender chose, and invented addresses only. */
const NAME = "Lena Kaufmann of Atelier Eichspan, Customer Care and Billing";
const ADDR = "lena@atelier-eichspan.invalid";
const LONG = "giulia.ferrari.accounts.payable.and.invoicing.department@terracotta-studio.invalid";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let sheets: string;
beforeAll(async () => {
  [browser, sheets] = await Promise.all([
    launch(chromium),
    Promise.all([fontsCss(), entryCss("mail")]).then((css) => css.join("\n")),
  ]);
}, 120_000);
afterAll(async () => { await browser?.close(); });

const rootAttrs = Object.entries(DEVICES.desktop.root)
  .map(([key, val]) => ` ${key}="${val}"`).join("");
const doc = (body: string): string =>
  `<!doctype html><html data-face="paper" data-scheme="light"${rootAttrs}><head><meta charset="utf-8">
   <style>${sheets}</style><style>html,body{margin:0}</style></head>
   <body><div class="oh-root">${body}</div></body></html>`;

async function onPage<T>(html: string, fn: (sel: string) => T, arg: string, viewport = { width: 1280, height: 900 }): Promise<T> {
  const page = await browser!.newPage({ viewport });
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    return (await page.evaluate(fn, arg)) as T;
  } finally {
    await page.close();
  }
}

const screenerRow = (): string =>
  renderToStaticMarkup(
    <div style={{ width: 400 }}>
      <Row
        who={NAME}
        address={ADDR}
        people={[{ name: NAME, address: ADDR }]}
        subject="Kleine Ergänzung"
        when="08:40"
        listing={{ name: "Kleine Ergänzung", stop: true, selected: false }}
        place={{ word: "Choose", choose: { label: "Choose", onPress() {} } }}
      />
    </div>,
  );

describe("a Screener row draws the address whatever the name says", () => {
  it("the address sits with the name: no gap between the name's line and the address's", async () => {
    const gaps = () => {
      const who = document.querySelector(".oh-row .oh-row-who")!.getBoundingClientRect();
      const addr = document.querySelector(".oh-row .oh-row-address")!.getBoundingClientRect();
      const subj = document.querySelector(".oh-row .oh-row-subject")!.getBoundingClientRect();
      return { nameToAddr: addr.top - who.bottom, addrToSubj: subj.top - addr.bottom };
    };
    const g = await onPage(doc(screenerRow()), gaps, "");
    expect(g.nameToAddr, "the wrap opens a gap under the name").toBeLessThanOrEqual(0.5);
    expect(g.nameToAddr, "the address is nearer the subject than the name").toBeLessThanOrEqual(g.addrToSubj);
    // The subject stands 4px under the address (LOOK-2 POLISH), the address flush under the name.
    expect(g.addrToSubj - g.nameToAddr, "the subject is not set apart from the name and its address").toBeGreaterThanOrEqual(3.5);
  }, 60_000);
});

const held = (width: number, plain: boolean, name = NAME, address = LONG): string =>
  renderToStaticMarkup(
    <article style={{ width: width + 52 }}>
      <MessageHead
        sender={{ name, address, onPress: plain ? undefined : () => {} }}
        staticMetadata={plain ? true : undefined}
        stamp={{ when: "08:40", full: false, title: "08:40" }}
      />
    </article>,
  );

describe("the Screener's held card draws the address whatever the name says", () => {
  for (const width of [300, 440, 560]) for (const plain of [false, true]) for (const name of [NAME, "Ines Roth"]) {
    it(`a ${width}px held card (${plain ? "plain line" : "the sender press"}, a ${name.length}-character name): the domain whole on one line, the name ≥ 2.5em`, async () => {
      const r = await onPage(doc(held(width, plain, name)), readAddress, ".oh-messagehead .oh-messagehead-address");
      whole(r, `${width}px held card`);
      expect(r.domainLines, "the domain is broken over lines while the local part has room to give").toBe(1);
      expect(r.nameEm, "the name is crushed under 2.5em").toBeGreaterThanOrEqual(2.5);
    }, 60_000);
  }

  it("a 60-character name and an ordinary address: the address is not cut at all on a 440px card", async () => {
    const html = doc(held(440, false, NAME, ADDR));
    whole(await onPage(html, readAddress, ".oh-messagehead .oh-messagehead-address"), "440px held card");
    const cut = await onPage(html, () => [...document.querySelectorAll(".oh-messagehead .oh-messagehead-address *")].some((e) => e.scrollWidth > e.clientWidth + 0.5), "");
    expect(cut, "the address is cut where its own line holds it").toBe(false);
  }, 60_000);
});
