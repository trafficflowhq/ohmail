import { chromium, type Browser, type Locator } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { build } from "esbuild";
import { prepareOutboundDelivery } from "../packages/services/src/outbound-html.js";

const labels = [
  "Quartz begins",
  "Copper follows",
  "Violet returns",
  "Fold indigo",
  "Polish copper",
  "Cobalt closes",
  "Juniper Finch",
];

function measure(root: Locator) {
  return root.evaluate((element, labels) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const tops: number[] = [];
    let line = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (const label of labels) {
        const at = node.textContent!.indexOf(label);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + label.length);
        tops.push(range.getBoundingClientRect().top);
        line = parseFloat(getComputedStyle(node.parentElement!).lineHeight);
      }
    }
    return { line, tops: tops.map((top) => top - tops[0]!) };
  }, labels);
}

  describe("the spacing of written lines", () => {
    let browser: Browser;
    let html: string;
    beforeAll(async () => {
      const bundle = await build({
        entryPoints: ["apps/webapp/test/reader-frame/letter-spacing-page.tsx"],
        bundle: true,
        write: false,
        outdir: "out",
        format: "esm",
        conditions: ["ohmail-source"],
        jsx: "automatic",
        loader: { ".woff2": "dataurl", ".svg": "text" },
        define: { "process.env.NODE_ENV": '"production"' },
      });
      const js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
      const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
      html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>${css}</style><body class="today"><div id="root"></div>
        <script type="module">${js.replace(/<\/script/g, "<\\/script")}</script>`;
      browser = await chromium.launch();
    }, 120_000);
    afterAll(async () => browser?.close());

    it.each(["units", "filler", "barep", "designed", "blocks", "blanks", "gmailfold", "outlookfold", "plainfold"])(
      "renders the spacing of %s mail", async (kind) => {
        const page = await browser.newPage();
        try {
          await page.route("http://letter.invalid/**", route => route.fulfill({ contentType: "text/html", body: html }));
          await page.goto(`http://letter.invalid/?kind=${kind}`);
          const body = page.locator("[data-read-body]");
          if (kind === "filler") expect(await page.evaluate(() => document.characterSet)).toBe("UTF-8");
          if (kind === "units") {
            const lines = body.locator(".msg-p, li, .msg-line").filter({ hasText: /^(First|Second|Fourth)$/ });
            await lines.first().waitFor();
            const tops = await lines.evaluateAll(nodes => nodes.map(el =>
              (el.getBoundingClientRect().top - nodes[0]!.getBoundingClientRect().top) / parseFloat(getComputedStyle(el).lineHeight)));
            expect(tops).toEqual([0, expect.closeTo(1, 2), expect.closeTo(3, 2)]);
          } else if (kind === "barep" || kind === "designed") {
            if (kind === "barep") {
              const paragraphs = body.locator(".msg-p");
              await paragraphs.first().waitFor();
              const steps = await paragraphs.evaluateAll(nodes => nodes.slice(1).map((p, i) =>
                (p.getBoundingClientRect().top - nodes[i]!.getBoundingClientRect().bottom) / parseFloat(getComputedStyle(p).lineHeight)));
              expect.soft(steps).toEqual([expect.closeTo(1, 2), expect.closeTo(1, 2)]);
              await page.getByRole("button", { name: "Show original" }).click();
            }
            const p = body.frameLocator("iframe").locator("p").first();
            expect(await p.evaluate(el => parseFloat(getComputedStyle(el).marginBottom))).toBe(kind === "designed" ? 15 : 14.5);
          } else if (kind === "blocks") {
            for (const cls of ["msg-h", "msg-quote", "msg-table-wrap", "msg-pre-wrap"]) {
              const gap = await body.locator("." + cls).evaluate(el =>
                parseFloat(getComputedStyle(el).marginBlockStart) / parseFloat(getComputedStyle(el).lineHeight));
              expect.soft(gap, cls).toBeCloseTo(1, 2);
              const below = await body.locator("." + cls + " + *").evaluate(el =>
                (el.getBoundingClientRect().top - el.previousElementSibling!.getBoundingClientRect().bottom) / parseFloat(getComputedStyle(el).lineHeight));
              expect.soft(below, cls).toBeCloseTo(1, 2);
            }
          } else if (kind === "blanks" || kind === "filler") {
            for (const [index, label] of ["First", "Second", "Third"].entries()) {
              const step = await body.getByText(label, { exact: true }).evaluate(el =>
                (el.getBoundingClientRect().top - el.parentElement!.firstElementChild!.getBoundingClientRect().top) / parseFloat(getComputedStyle(el).lineHeight));
              expect.soft(step).toBeCloseTo([0, 1, 3][index]!, 2);
            }
          } else {
            const toggle = body.locator(".msg-history-toggle");
            const gap = await toggle.evaluate(el => {
              const text = el.parentElement!.querySelectorAll(".msg-line, .msg-p");
              return el.getBoundingClientRect().top - text[text.length - 1]!.getBoundingClientRect().bottom;
            });
            expect(gap).toBeCloseTo(8, 0);
          }
        } finally {
          await page.close();
        }
      },
    );

    it.each(["div", "p"])("uses just the typed blank %s after each structural block", async (tag) => {
      const page = await browser.newPage();
      try {
        await page.route("http://letter.invalid/**", route =>
          route.fulfill({ contentType: "text/html", body: html }));
        await page.goto(`http://letter.invalid/?kind=blocks&blank=${tag}`);
        const body = page.locator("[data-read-body]");
        for (const cls of ["msg-h", "msg-quote", "msg-table-wrap", "msg-pre-wrap"]) {
          const { height, gap } = await body.locator(`.${cls} + [data-blank-line]`).evaluate(blank => {
            const block = blank.previousElementSibling!;
            const text = blank.nextElementSibling!;
            const line = parseFloat(getComputedStyle(text).lineHeight);
            return {
              height: blank.getBoundingClientRect().height / line,
              gap: (text.getBoundingClientRect().top - block.getBoundingClientRect().bottom) / line,
            };
          });
          expect.soft(height, cls).toBeCloseTo(1, 2);
          expect.soft(gap, cls).toBeCloseTo(1, 2);
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      { kind: "columns", after: ".msg-pre-wrap" },
      { kind: "picture", after: ".msg-line:has(img) + .msg-p" },
    ])("keeps one blank line at the $kind boundary", async ({ kind, after }) => {
      const page = await browser.newPage();
      try {
        await page.route("http://letter.invalid/**", route =>
          route.fulfill({ contentType: "text/html", body: html }));
        await page.goto(`http://letter.invalid/?kind=${kind}`);
        const gap = await page.locator(`[data-read-body] ${after}`).evaluate(el => {
          const previous = el.previousElementSibling!;
          const line = parseFloat(getComputedStyle(previous).lineHeight);
          return (el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom) / line;
        });
        expect(gap).toBeCloseTo(1, 2);
      } finally {
        await page.close();
      }
    });

    it.each([1440, 390])(
      "keeps the written lines in each letter at %i px",
      async (width) => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.exposeFunction("deliverLetter", prepareOutboundDelivery);
          await page.route("http://letter.invalid/**", (route) =>
            route.fulfill({ contentType: "text/html", body: html }),
          );
          for (const kind of ["outlook", "gmail", "plain", "composer"]) {
            await page.goto(`http://letter.invalid/?kind=${kind}`);
            const body = page.locator("[data-read-body]");
            const editor = page.getByRole("textbox", { name: "Draft" });
            if (kind === "composer") {
              await editor.evaluate((el) => {
                (el as HTMLElement).focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const selection = getSelection()!;
                selection.removeAllRanges();
                selection.addRange(range);
              });
              await page.keyboard.insertText("!");
              await body.getByText(/!/).first().waitFor({ timeout: 5000 });
            } else await body.getByText("Quartz begins", { exact: false }).first().waitFor();
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            const { tops, line } = await measure(body);
            const expected =
              kind === "composer" ? (await measure(editor)).tops : [0, 1, 3, 5, 6, 8, 9].map((n) => n * line);
            console.log("geometry", width, kind, line, JSON.stringify(tops), JSON.stringify(expected));
            expect(tops).toHaveLength(labels.length);
            expect(expected).toHaveLength(labels.length);
            for (const [i, top] of tops.entries()) {
              expect
                .soft(
                  Math.abs(top - expected[i]!),
                  `${kind} at ${width}, ${labels[i]}: ${top} vs ${expected[i]}`,
                )
                .toBeLessThanOrEqual(2);
            }
          }
        } finally {
          await page.close();
        }
      },
      60_000,
    );
  });
