import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import assert from "node:assert/strict";

const ORIGIN = "https://app.ohmail.test";
const SUBJECTS = ["First review fixture", "Second review fixture"];

/** Chromium checks the cover and its real input and accessibility boundaries, which jsdom does not model. */
async function checkSeedReviewVisibility() {
  const root = process.cwd();
  const require_ = createRequire(join(root, "package.json"));
  const { chromium, expect: browserExpect } = require_("@playwright/test");
  const en = require_("./apps/webapp/messages/en.json");
  const output = await mkdtemp(join(tmpdir(), "ohmail-seed-review-"));
  try {
    await build({
      entryPoints: [join(root, "apps/webapp/test/frame/first-run-page/entry.tsx")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2020"],
      jsx: "automatic",
      outdir: output,
      entryNames: "page",
      alias: { "next-intl": join(root, "apps/webapp/test/editor-feel/intl-shim.mjs") },
      loader: {
        ".css": "css",
        ".woff": "dataurl",
        ".woff2": "dataurl",
        ".svg": "dataurl",
        ".png": "dataurl",
        ".webp": "dataurl",
      },
      banner: { js: "window.process = window.process || { env: {} };" },
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(ORIGIN + "/api"),
      },
      logLevel: "warning",
    });
    const [js, css] = await Promise.all(
      ["page.js", "page.css"].map((file) => readFile(join(output, file), "utf8")),
    );
    const browser = await chromium.launch();
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          serviceWorkers: "block",
        });
        try {
          const page = await context.newPage();
          await page.route("**/*", (route) => {
            const { origin, pathname } = new URL(route.request().url());
            if (origin !== ORIGIN) return route.abort();
            if (pathname === "/page.js")
              return route.fulfill({ contentType: "application/javascript", body: js });
            if (pathname === "/page.css") return route.fulfill({ contentType: "text/css", body: css });
            if (pathname === "/api/consent/seed") {
              return route.fulfill({
                json: {
                  candidates: [
                    {
                      address: "writer" + "@" + "example.invalid",
                      name: "Fixture writer",
                      messages: 3,
                      lastWrittenAt: "2026-11-16T09:00:00Z",
                      alreadyDecided: false,
                    },
                  ],
                  excluded: [],
                  scannedMessages: 3,
                  truncated: false,
                },
              });
            }
            if (pathname !== "/") return route.fulfill({ status: 404 });
            return route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
                <link rel="stylesheet" href="/page.css"><body class="mo-canvas app-body today">
                <div id="app" style="display:contents"></div><script src="/page.js"></script></body>`,
            });
          });
          await page.goto(ORIGIN + "/?seed-review#/ohbox");

          const stage = page.getByRole("dialog", { name: en.frame.landmark.stage, exact: true });
          const dismiss = stage.getByRole("button", { name: en.seed.later, exact: true });
          await browserExpect(dismiss).toBeVisible();
          const frame = page.locator(".fr-frame");
          const row = frame.locator('[role="option"]').filter({ hasText: SUBJECTS[0] });
          const railNames = [en.frame.landmark.places, en.frame.landmark.fedRail];
          const rail = frame.locator("nav").filter({ visible: true });
          await browserExpect(rail).toHaveCount(1);
          assert.ok(
            railNames.includes(await rail.getAttribute("aria-label")),
            "the rail stands around the review",
          );
          await browserExpect(frame.locator('[role="option"]')).toHaveCount(SUBJECTS.length);

          const cover = await stage.evaluate((element) => {
            const style = getComputedStyle(element);
            const points = [
              [0.1, 0.1],
              [0.5, 0.5],
              [0.9, 0.9],
            ];
            return {
              opaque: style.opacity === "1" && /^rgb\(/.test(style.backgroundColor),
              onTop: points.every(([x, y]) =>
                element.contains(document.elementFromPoint(innerWidth * x, innerHeight * y)),
              ),
            };
          });
          assert.deepEqual(
            cover,
            { opaque: true, onTop: true },
            "the stage covers the frame and its columns",
          );
          assert.equal(
            await row.evaluate((element) => {
              element.focus();
              return document.activeElement === element;
            }),
            false,
            "the background row cannot take focus",
          );

          const cdp = await context.newCDPSession(page);
          const { nodes } = await cdp.send("Accessibility.getFullAXTree");
          await cdp.detach();
          assert.equal(
            nodes.some(
              (node) =>
                !node.ignored && SUBJECTS.some((subject) => String(node.name?.value).includes(subject)),
            ),
            false,
            "mail rows are absent from the accessibility tree",
          );
          await browserExpect(frame).toHaveAttribute("inert", "");

          const box = await row.boundingBox();
          assert.ok(box, "the background row has a position covered by the stage");
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await browserExpect(page).toHaveURL(/#\/ohbox$/);
          await page.keyboard.press("g");
          await page.keyboard.press("d");
          await browserExpect(page).toHaveURL(/#\/ohbox$/);
          await browserExpect(dismiss).toBeVisible();

          await dismiss.click();
          await browserExpect(stage).toHaveCount(0);
          for (const subject of SUBJECTS)
            await browserExpect(page.getByRole("option", { name: new RegExp(subject) })).toBeVisible();
          await page.keyboard.press("g");
          await page.keyboard.press("d");
          await browserExpect(page).toHaveURL(/#\/drafts$/);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

await checkSeedReviewVisibility();
