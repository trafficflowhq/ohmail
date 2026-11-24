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
