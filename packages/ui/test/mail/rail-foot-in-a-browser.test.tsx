import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { ActivityLine } from "../../src/base/Feedback/ActivityLine.js";
import { RailFoot } from "../../src/mail/index.js";
import { entryCss, fontsCss } from "../compare/harness.js";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>>;
beforeAll(async () => {
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const name = "A very long account name that must be shortened";
const address = "a.very.long.account.name.for.layout.testing@sample.invalid";

describe("the rail account and its tools", () => {
  for (const width of [1400, 1024]) {
    it(`keeps text and controls apart at ${width} and on hover`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const foot = renderToStaticMarkup(
          <RailFoot
            account={{ name, address, note: address, title: "Mailboxes" }}
            tools={[
              { icon: "command", label: "Command palette · Ctrl K", keyHint: "Ctrl K" },
              { icon: "moon", label: "Dark" },
            ]}
          />,
        );
        await page.setContent(
          `<!doctype html><html data-face="paper" data-scheme="light" data-device="desktop" data-touch="0"><head><style>${await fontsCss()}</style><style>${await entryCss("mail")}</style></head><body><div class="oh-root"><div style="width:232px">${foot}</div></div></body></html>`,
        );
        await page.evaluate(() => document.fonts.ready);
        const account = page.getByRole("button", { name: `${name} · ${address}`, exact: true });
        const palette = page.getByRole("button", { name: "Command palette · Ctrl K" });
        const dark = page.getByRole("button", { name: "Dark" });
        const text = account.locator("span").filter({ hasText: name }).first();
        const measure = async () => ({
          text: await text.boundingBox(),
          palette: await palette.boundingBox(),
          dark: await dark.boundingBox(),
        });
        const before = await measure();
        if (process.env.FOOTER_SCREENSHOT)
          await page.screenshot({ path: `${process.env.FOOTER_SCREENSHOT}-${width}.png` });
        await palette.hover();
        const hover = await measure();
        expect(await palette.innerText()).toBe("");
        expect(before.text!.x + before.text!.width).toBeLessThanOrEqual(before.palette!.x);
        expect(before.palette!.x + before.palette!.width).toBeLessThanOrEqual(before.dark!.x);
        expect(hover).toEqual(before);
        expect(await account.getAttribute("title")).toBe("Mailboxes");
        expect(await text.getAttribute("title")).toBeNull();
        expect(
          await text.evaluate((el) =>
            Array.from(el.children).every((child) => getComputedStyle(child).textOverflow === "ellipsis"),
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
  }
});

it("leaves a centered, static line a third as wide when reduced motion is requested", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<style>${await entryCss("base")}</style><div role="status" style="width: 300px">${renderToStaticMarkup(<ActivityLine />)}</div>`,
    );
    const line = await page.getByRole("status").evaluate((status) => {
      const mark = status.firstElementChild!;
      const style = getComputedStyle(mark, "::before");
      return {
        hidden: mark.getAttribute("aria-hidden"),
        width: style.width,
        height: style.height,
        offset: new DOMMatrix(style.transform).m41,
        animations: mark.getAnimations({ subtree: true }).length,
      };
    });
    expect(line).toEqual({ hidden: "true", width: "100px", height: "2px", offset: 100, animations: 0 });
  } finally {
    await page.close();
  }
}, 30_000);
