/**
 * THE DOUBLE-CARET PROBE — headed WebKitGTK under Xvfb, frames read off the X framebuffer.
 *
 *   xvfb-run -a -s "-screen 0 1280x900x24 -ac" npx playwright test -c apps/webapp/test/editor-feel/playwright.config.ts caret-probe --project=webkit --headed
 *
 * For each key walk it takes 8 frames 150 ms apart (the caret blinks) and reports the MAX number of
 * caret bars seen in one frame inside the editor rect, with each bar's rows, beside the DOM facts.
 * Skips by name without DISPLAY (a headless run has no framebuffer to read).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";
import { carets, findProbe, grabFrame } from "./frame";
import { openHarness, read, setDoc, caretAt, posOf } from "./writing-rig";

const OUT = resolve(__dirname, "../../../../build/editor-feel");
const display = process.env.DISPLAY ?? "";

test.skip(({ browserName }) => browserName !== "webkit" || !display || process.env.PW_HEADED !== "1",
  "the caret probe reads an X framebuffer under headed webkit only");

async function sample(page: import("@playwright/test").Page, label: string) {
  const rect = await page.getByRole("textbox", { name: "Reply", exact: true }).evaluate((box) => {
    const r = box.getBoundingClientRect();
    const frame = box.closest("[data-reading-scroll]")!.getBoundingClientRect();
    const p = document.getElementById("probe")!.getBoundingClientRect();
    const left = Math.max(r.left, frame.left, 0), top = Math.max(r.top, frame.top, 0);
    const right = Math.min(r.right, frame.right, innerWidth), bottom = Math.min(r.bottom, frame.bottom, innerHeight);
    return { x: left - p.left, y: top - p.top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  });
  let max = 0, seen: string[] = [], probeMiss = 0;
  for (let i = 0; i < 8; i++) {
    const f = grabFrame(display);
    const origin = findProbe(f);
    if (!origin) { probeMiss++; await page.waitForTimeout(150); continue; }
    const cs = carets(f, { x: origin.x + Math.round(rect.x), y: origin.y + Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
    if (cs.length > max) { max = cs.length; seen = cs.map((c) => `x${c.x0}-${c.x1} y${c.y0 - origin.y}-${c.y1 - origin.y}`); }
    await page.waitForTimeout(150);
  }
  const dom = await read(page);
  const line = JSON.stringify({ label, maxCarets: max, bars: seen, probeMiss, rangeCount: dom.rangeCount, collapsed: dom.collapsed, activeIsSurface: dom.activeIsSurface, editables: dom.editables, gapcursors: dom.gapcursors, pos: dom.pos });
  console.log("CARET " + line);
  mkdirSync(OUT, { recursive: true });
  appendFileSync(resolve(OUT, "caret-probe.jsonl"), line + "\n");
  return max;
}

test("ArrowDown walks: hard-break lines, paragraphs, after a link, after a list item, a scrolling surface", async ({ page }) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await page.keyboard.type("line one");
  await sample(page, "typed-one-line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line three");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sample(page, "hardbreak-up-twice");
  await page.keyboard.press("ArrowDown");
  await sample(page, "hardbreak-down-1");
  await page.keyboard.press("ArrowDown");
  await sample(page, "hardbreak-down-2-lastline");
  await page.keyboard.press("ArrowDown");
  await sample(page, "hardbreak-down-3-at-end");

  await setDoc(page, "<p>first paragraph</p><p>second paragraph</p>", 3);
  await sample(page, "paragraphs-start");
  await page.keyboard.press("ArrowDown");
  await sample(page, "paragraphs-down-across-boundary");
  await page.keyboard.press("ArrowDown");
  await sample(page, "paragraphs-down-at-end");

  await setDoc(page, '<p>see <a href="https://x.example/p">the link</a></p><p>next line</p>');
  await caretAt(page, await posOf(page, "the link", "end"));
  await sample(page, "after-link");
  await page.keyboard.press("ArrowDown");
  await sample(page, "after-link-down");

  await setDoc(page, "<ul><li><p>item one</p></li><li><p>item two</p></li></ul><p>after</p>");
  await caretAt(page, await posOf(page, "item one", "end"));
  await page.keyboard.press("ArrowDown");
  await sample(page, "list-down-to-item-two");
  await page.keyboard.press("ArrowDown");
  await sample(page, "list-down-out-of-list");

  // A surface that SCROLLS: the reply frame at 120px with twelve hard-break lines.
  await openHarness(page, { height: 120 });
  for (let i = 1; i <= 12; i++) { await page.keyboard.type(`row ${i}`); if (i < 12) await page.keyboard.press("Enter"); }
  await page.keyboard.press("Control+Home");
  await sample(page, "scroll-top");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowDown");
    await sample(page, `scroll-down-${i + 1}`);
  }
});
