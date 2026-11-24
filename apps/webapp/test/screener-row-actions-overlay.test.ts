import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Row, type RowProps } from "@ohmail/ui/mail";
import { entryCss, fontsCss } from "../../../packages/ui/test/compare/harness.js";
import { launch } from "../../../test/compare/render.mjs";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>>;

beforeAll(async () => { browser = await launch(chromium); }, 120_000);
afterAll(async () => { await browser?.close(); });

const choose = "Choose a place";
const subject = "An especially long subject that needs room before the row's actions";
const common: RowProps = {
  who: "Sender",
  people: [{ name: "Sender", address: "sender@example.invalid" }],
  subject,
  preview: "More of the letter follows the subject",
  when: "09:20",
  onOpen: () => {},
};
const place: RowProps["place"] = {
  word: "News",
  accept: { label: "News", onPress: () => {} },
  choose: { label: choose, onPress: () => {} },
};

async function onPage(touch: boolean, run: (page: import("@playwright/test").Page) => Promise<void>) {
  const page = await browser.newPage({
    viewport: { width: 500, height: 470 }, hasTouch: touch,
  });
  page.setDefaultTimeout(3000);
  try {
    const output = renderToStaticMarkup(createElement("div", { className: "oh-root" },
      createElement("div", { style: { width: touch ? 390 : 330 }, role: "listbox", "aria-label": "Screener" },
        createElement(Row, { ...common, place, listing: { name: "Sender with actions", selected: false } }),
        createElement(Row, { ...common, listing: { name: "Sender without actions", selected: false } }),
        createElement(Row, {
          ...common, quick: { label: "Done", icon: "check", onPress: () => {} },
          listing: { name: "Resurfaced sender", selected: false },
        }),
      ),
    ));
    await page.setContent(`<!doctype html><html lang="en" data-face="paper" data-scheme="light"
      data-device="${touch ? "phone" : "desktop"}" data-touch="${touch ? "1" : "0"}" data-rm="1"><head>
      <style>${await fontsCss()}</style><style>${await entryCss("mail")}</style></head><body>${output}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await run(page);
  } finally {
    await page.close();
  }
}

describe("space for the Screener row's actions", () => {
  it("keeps clipped sender text outside the destination controls", async () => {
    await onPage(false, async (page) => {
      const row = page.getByRole("option", { name: "Sender with actions" });
      const headline = row.getByText(subject, { exact: true });
      const text = await headline.evaluate((el) => ({
        right: el.getBoundingClientRect().right,
        centre: (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2,
        clipped: el.scrollWidth > el.clientWidth,
      }));
      const accept = (await page.getByRole("button", { name: "News" }).boundingBox())!;
      const more = (await page.getByRole("button", { name: choose }).boundingBox())!;
      expect(text.clipped).toBe(true);
      expect(text.right).toBeLessThanOrEqual(accept.x + 0.5);
      expect(accept.x + accept.width).toBeLessThanOrEqual(more.x + 0.5);
      expect(text.centre).toBeGreaterThanOrEqual(accept.y);
      expect(text.centre).toBeLessThanOrEqual(accept.y + accept.height);
    });
  });

  it("gives the whole subject line to a row without actions", async () => {
    await onPage(false, async (page) => {
      const lineWidth = async (name: string) =>
        (await page.getByRole("option", { name }).getByText(subject, { exact: true }).boundingBox())!.width;
      expect(await lineWidth("Sender without actions")).toBeGreaterThan(await lineWidth("Sender with actions"));
    });
  });
});

describe("row actions by keyboard and touch", () => {
  it("keeps row actions reachable by keyboard focus", async () => {
    await onPage(false, async (page) => {
      const accept = page.getByRole("button", { name: "News" });
      const more = page.getByRole("button", { name: choose });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      expect(await accept.evaluate((el) => document.activeElement === el)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await more.evaluate((el) => document.activeElement === el)).toBe(true);
      const resurfaced = page.getByRole("option", { name: "Resurfaced sender" });
      const done = page.getByRole("button", { name: "Done" });
      await resurfaced.focus();
      await done.click({ trial: true });
    });
  });

  it("leaves the hidden quick control inert until it is revealed", async () => {
    await onPage(false, async (page) => {
      const done = page.getByRole("button", { name: "Done" });
      const under = () => done.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
      expect(await under()).toBe(false);
      await page.getByRole("option", { name: "Resurfaced sender" }).focus();
      expect(await under()).toBe(true);
    });
  });

  it("lets a finger reach the suggestion without a mouse hover", async () => {
    await onPage(true, async (page) => {
      const accept = page.getByRole("button", { name: "News" });
      expect(await page.getByRole("button", { name: choose }).count()).toBe(0);
      const row = page.getByRole("option", { name: "Sender with actions" });
      const preview = (await row.getByText(common.preview!, { exact: true }).boundingBox())!;
      const target = (await accept.boundingBox())!;
      expect(preview.x + preview.width).toBeLessThanOrEqual(target.x + 0.5);
      await accept.evaluate((el) => el.addEventListener("click", () => { el.setAttribute("data-pressed", "yes"); }));
      await accept.tap();
      expect(await accept.getAttribute("data-pressed")).toBe("yes");
    });
  });
});
