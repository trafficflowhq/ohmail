import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ═══ A LIST IN THE EDITOR STANDS ON THE TEXT'S OWN LINES — MEASURED IN A REAL ENGINE ══════════
 *
 * A letter is written in lines: an empty line is one line tall, and nothing else stands between two
 * lines of text. A list used to bring its own air: a third of a line over it and under it on top of
 * the empty line a person had left, and a little between its items. Read here off headless Chromium
 * over the app's real stylesheets, on the shape the editor holds after a paste (lines in one
 * paragraph, an empty last line before a list, an empty first line after it):
 *
 *   · a list after an empty line starts exactly one empty line under the text, and the text after it
 *     starts exactly one empty line under the list;
 *   · a list that follows a line directly starts on the next line;
 *   · the items of a list stand one line apart, like the lines of the text;
 *   · a quote and a code block keep the air they had.
 *
 * The RED CONTROL re-applies the spacing this replaced on the same page, and the same measurement
 * must then find the list off the lines.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = ["packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/ui/src/base.css", "apps/webapp/app/app.css"]
  .map(css)
  .join("\n");

/** The spacing this replaced, said again after the app's sheet: a third of a line round a list, a little between its items. */
const BEFORE = `.rte-surface p:has(+ :is(ul, ol)), .rte-surface :is(ul, ol):has(+ p) { margin-bottom: 0.7em }
.rte-surface li { margin: 0.15em 0 }`;

/** What the editor holds after a paste of lines with two lists: an invented letter. */
const LETTER = `
<p>Hello all<br><br>The third quarter is booked.<br>Could you take a short look?<br><br></p>
<ul><li><p>All entries carry a number.</p></li><li><p>The transfers are booked.</p></li><li><p>The bank agrees with the statement.</p></li></ul>
<p><br>The figures:</p>
<ol><li><p>Line 303: 100.00</p></li><li><p>Line 400: 20.00</p></li></ol>
<p><br>One question: shall I pay in full?<br><br>Thanks<br>Anna</p>
<blockquote><p>A quoted line.</p></blockquote>
<p>After the quote.</p>
<pre><code>a code line</code></pre>`;

/** The editor's box as each place that mounts it wraps it: a new letter, a reply, and the editor alone. */
const PLACES = ["rte compose-editor", "rte reply-editor", "rte"] as const;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** Where the line that starts with each of `starts` begins, from the page's top, in the order asked. */
async function linesOf(place: string, more: string, starts: readonly string[]): Promise<number[]> {
  const page = await browser!.newPage({ viewport: { width: 900, height: 1200 } });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}</style><style>${more}</style></head>
<body class="mo-canvas"><div class="${place}" style="width:640px"><div class="rte-body"><div class="rte-surface" contenteditable="true">${LETTER}</div></div></div></body></html>`);
    return await page.evaluate((wanted) => {
      const tops = new Map<string, number>();
      const walk = document.createTreeWalker(document.querySelector(".rte-surface")!, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const text = node.textContent ?? "";
        const start = wanted.find((w) => text.startsWith(w));
        if (!start) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        tops.set(start, range.getBoundingClientRect().top);
      }
      return wanted.map((w) => tops.get(w) ?? Number.NaN);
    }, starts);
  } finally {
    await page.close();
  }
}

const STARTS = [
  "The third",
  "Could you",
  "All entries",
  "The transfers",
  "The bank",
  "The figures",
  "Line 303",
  "Line 400",
  "One question",
  "Anna",
  "A quoted",
  "After the quote",
  "a code line",
] as const;

/** The distances that matter, each in lines of the text (the pitch of two lines of one paragraph). */
async function measured(place: string, more = "") {
  const [third, could, entries, transfers, bank, figures, l303, l400, question, anna, quoted, after, code] = await linesOf(
    place,
    more,
    STARTS,
  );
  const pitch = could! - third!;
  const lines = (from: number, to: number) => (to - from) / pitch;
  return {
    pitch,
    aboveList: lines(could!, entries!),
    items: [lines(entries!, transfers!), lines(transfers!, bank!), lines(l303!, l400!)],
    belowList: [lines(bank!, figures!), lines(l400!, question!)],
    rightAfterALine: lines(figures!, l303!),
    quote: lines(anna!, quoted!),
    code: lines(after!, code!),
  };
}

describe.each(PLACES)("a list in the editor (%s)", (place) => {
  it("stands one empty line from the text around it, its items one line apart", async () => {
    const m = await measured(place);
    expect(m.pitch).toBeGreaterThan(10);
    /* An empty line between: the next text starts two lines on. */
    expect(m.aboveList).toBeCloseTo(2, 1);
    for (const below of m.belowList) expect(below).toBeCloseTo(2, 1);
    for (const item of m.items) expect(item).toBeCloseTo(1, 1);
    expect(m.rightAfterALine).toBeCloseTo(1, 1);
  });

  it("leaves a quote and a code block the air they had", async () => {
    const [now, was] = [await measured(place), await measured(place, BEFORE)];
    expect(now.quote).toBeGreaterThan(1.2);
    expect(now.quote).toBeCloseTo(was.quote, 2);
    expect(now.code).toBeCloseTo(was.code, 2);
  });

  it("RED CONTROL: under the spacing this replaced, the same measurement finds the list off the lines", async () => {
    const was = await measured(place, BEFORE);
    expect(was.aboveList).toBeGreaterThan(2.3);
    expect(was.belowList[0]!).toBeGreaterThan(2.3);
    expect(was.items[0]!).toBeGreaterThan(1.05);
    expect(was.rightAfterALine).toBeGreaterThan(1.3);
  });
});
