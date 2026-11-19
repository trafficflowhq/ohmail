/** The frame keeps its token values when the host also loads the original document styles. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListHead } from "@ohmail/ui/mail";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/* The new design first, today's after it: the order in which a page that loads both is most likely to hurt the frame. */
const NEW = ["packages/tokens/src/design/tokens.css", "packages/ui/src/base/base.css", "packages/app/src/frame/seam.generated.css"];
const TODAY = [
  "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css",
];
const LOOKS = [
  { face: "paper", theme: "light" }, { face: "paper", theme: "dark" },
  { face: "ohmarchy", theme: "light" }, { face: "ohmarchy", theme: "dark" },
] as const;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe("the seam between today's views and the frame", () => {
  for (const look of LOOKS) {
    it(`${look.face}, ${look.theme}: --float is a colour inside .today and a shadow inside .oh-root`, async () => {
      const page = await browser!.newPage();
      const documentFor = (sheets: readonly string[], body: string) =>
        `<!doctype html><html data-face="${look.face}" data-theme="${look.theme}" data-scheme="${look.theme}"><head><style>${sheets.map(css).join("\n")}</style></head><body class="today">${body}</body></html>`;
      const value = () => page.locator("#sample").evaluate((el) => getComputedStyle(el).getPropertyValue("--float").trim());
      await page.setContent(documentFor(TODAY, '<i id="sample"></i>'));
      const views = await value();
      const frameMarkup = '<div class="oh-root"><i id="sample"></i></div>';
      await page.setContent(documentFor(NEW, frameMarkup));
      const expectedFrame = await value();
      await page.setContent(documentFor([...NEW, ...TODAY], frameMarkup));
      const frame = await value();
      expect(frame).toBe(expectedFrame);
      await page.close();
      // A shadow has an offset and a blur; a colour is one value.
      expect(frame, "the frame's --float is not a shadow").toMatch(/px/);
      expect(views, "today's --float is not a colour").not.toMatch(/px/);
      expect(views.length).toBeGreaterThan(0);
    });
  }
});

/** The list header the mail place renders stays visible on the phone, fold and desktop. */
describe("a view's own heading inside the frame", () => {
  const sheets = [...NEW, ...TODAY, "packages/ui/src/mail/Lists/list-head.css", "apps/webapp/app/app.css"];
  const header = renderToStaticMarkup(createElement(ListHead, { title: "Trash" }));
  for (const [width, height] of [[390, 844], [719, 781], [1440, 900]] as const) {
    it(`stands on screen at ${width} by ${height}`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.setContent(`<!doctype html><html><head><style>${sheets.map(css).join("\n")}</style></head>
        <body class="mo-canvas app-body today"><div class="oh-root"><div class="fr-columns"><section class="fr-list">
        ${header}</section></div></div></body></html>`);
      const visible = await page.getByRole("heading", { name: "Trash" }).isVisible();
      await page.close();
      expect(visible, "no name of the place on screen").toBe(true);
    });
  }
});
