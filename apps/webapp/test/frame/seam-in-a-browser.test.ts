/**
 * TWO DESIGNS ON ONE PAGE, IN A REAL BROWSER. Today's sheets and the new design's both write the same seven names on
 * `:root`, with different meanings: `--float` is a colour to today's views and a shadow to the frame. The two seam
 * sheets declare each meaning again under its own root, so it holds whatever order the sheets load in and whatever
 * `:root` resolves to. jsdom has no cascade; Chromium does. Read in the four looks, with today's sheets loaded last.
 */
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
  "apps/webapp/app/shell/today-tokens.generated.css",
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
      const sheets = [...NEW, ...TODAY].map(css).join("\n");
      await page.setContent(`<!doctype html><html data-face="${look.face}" data-theme="${look.theme}" data-scheme="${look.theme}"><head><style>${sheets}</style></head>
        <body class="today"><div class="oh-root"><i id="frame"></i><div class="today"><i id="views"></i></div></div></body></html>`);
      const read = (id: string) => page.$eval(`#${id}`, (el) => getComputedStyle(el).getPropertyValue("--float").trim());
      const frame = await read("frame");
      const views = await read("views");
      await page.close();
      // A shadow has an offset and a blur; a colour is one value.
      expect(frame, "the frame's --float is not a shadow").toMatch(/px/);
      expect(views, "today's --float is not a colour").not.toMatch(/px/);
      expect(views.length).toBeGreaterThan(0);
    });
  }
});

/**
 * TODAY'S VIEWS NAME THEIR PLACE AT EVERY WIDTH. Under 1024px `app.css` hid each view's own heading because the old top
 * bar carried the name; inside the frame, which has no top bar, the adapter's sheet shows it again. Read on a phone's
 * and a fold's width with the sheets the product page loads.
 */
describe("a view's own heading inside the frame", () => {
  const SHEETS = ["packages/ui/src/composites/list-pane.css", "apps/webapp/app/app.css", "apps/webapp/app/shell/today.css"];
  for (const [width, height] of [[390, 844], [719, 781], [1440, 900]] as const) {
    it(`stands on screen at ${width} by ${height}`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.setContent(`<!doctype html><html><head><style>${SHEETS.map(css).join("\n")}</style></head>
        <body class="today"><div class="fr-wide"><div class="today"><div class="stage"><section class="view view-trash">
        <div class="vhead"><h1>Trash</h1></div></section></div></div></div></body></html>`);
      const visible = await page.getByRole("heading", { name: "Trash" }).isVisible();
      await page.close();
      expect(visible, "no name of the place on screen").toBe(true);
    });
  }
});
