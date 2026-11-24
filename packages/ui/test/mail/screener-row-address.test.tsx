import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { Row } from "../../src/mail/index.js";
import { entryCss } from "../compare/harness.js";

const requirePlaywright = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = requirePlaywright("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>>;
beforeAll(async () => {
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const domain = "accounts.receivables.example";
const address = ["settlements", domain].join("@");
const name = "A sender with a name that takes much more space than the row";
const options = { keepAddressDomain: true };

for (const width of [260, 400]) {
  it(`keeps the sender's whole domain visible when the row is ${width}px wide`, async () => {
    const row = renderToStaticMarkup(
      <Row
        {...options}
        who={name}
        address={address}
        people={[{ name, address }]}
        subject="Statement"
        when="08:40"
        labels={["2 held"]}
        listing={{ name: "Statement", selected: false }}
      />,
    );
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html data-face="paper" data-device="desktop" data-touch="0">
        <head><style>${await entryCss("mail")}</style></head>
        <body><div style="width:${width}px">${row}</div></body></html>`);
      const visible = await page
        .getByRole("option", { name: "Statement" })
        .evaluate((element, domainText) => {
          const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let text = walk.nextNode(); text; text = walk.nextNode()) {
            const start = text.textContent?.indexOf(domainText) ?? -1;
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, start + domainText.length);
            return [...range.getClientRects()].every((rect) => {
              if (rect.width === 0 || rect.height === 0) return false;
              const rowRect = element.getBoundingClientRect();
              if (rect.right > rowRect.right + 1) return false;
              for (let node = text.parentElement; node && node !== element; node = node.parentElement) {
                if (getComputedStyle(node).overflowX === "visible") continue;
                const clip = node.getBoundingClientRect();
                if (rect.left < clip.left - 1 || rect.right > clip.right + 1) return false;
              }
              return true;
            });
          }
          return false;
        }, domain);
      expect(visible).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
}

async function drawnRow(row: string, width: number, device: "phone" | "desktop") {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html data-face="paper" data-device="${device}" data-touch="${device === "phone" ? 1 : 0}">
    <head><style>${await entryCss("mail")}</style></head>
    <body><div style="width:${width}px">${row}</div></body></html>`);
  return page;
}

/* A sender with no name stands as the address itself: its local part gives all its room before the domain breaks,
   so the domain breaks only when it alone is wider than the line. */
const bare = ["support", "cinderl0ck-secure.example"].join("@");
for (const width of [200, 240, 284, 300, 320, 340]) {
  it(`gives up a bare address's local part before its domain breaks, ${width}px wide`, async () => {
    const row = renderToStaticMarkup(
      <Row
        {...options}
        who={bare}
        people={[{ name: bare, address: bare }]}
        subject="Your account"
        when="12 Jul"
        listing={{ name: "Your account", selected: false }}
      />,
    );
    const page = await drawnRow(row, width, "phone");
    try {
      const read = await page.locator(".oh-row-first").evaluate((line) => {
        const local = line.querySelector<HTMLElement>(".oh-address-local")!;
        const domain = line.querySelector<HTMLElement>(".oh-address-domain")!;
        const one = line.querySelector<HTMLElement>(".oh-row-when")!.getBoundingClientRect().height;
        return {
          broken: domain.getBoundingClientRect().height > one * 1.5,
          local: local.getBoundingClientRect().width,
        };
      });
      if (read.broken) expect(read.local, "the domain broke while the local part kept room").toBeLessThan(1);
    } finally {
      await page.close();
    }
  }, 30_000);
}

/* Outside the Screener the address gives way to the name, which is never cut to a letter or two: it keeps the least
   width every row's name keeps. (In the Screener the name gives way to the address.) */
const lena = ["lena.hartmann", "accounts.receivables.example"].join("@");
for (const width of [360, 520]) {
  it(`keeps a few letters of the sender's name beside the address outside the Screener, ${width}px wide`, async () => {
    const row = renderToStaticMarkup(
      <Row
        who="Lena Hartmann-Oberholzer"
        address={lena}
        people={[{ name: "Lena Hartmann-Oberholzer", address: lena }]}
        subject="Statement"
        when="12 Jul"
        listing={{ name: "Statement", selected: false }}
      />,
    );
    const page = await drawnRow(row, width, "phone");
    try {
      const read = await page.locator(".oh-row-who").evaluate((who) => ({
        width: who.getBoundingClientRect().width,
        em: parseFloat(getComputedStyle(who).fontSize),
      }));
      expect(read.width, "the name is cut to a letter or two").toBeGreaterThanOrEqual(read.em * 3 - 1);
    } finally {
      await page.close();
    }
  }, 30_000);
}
