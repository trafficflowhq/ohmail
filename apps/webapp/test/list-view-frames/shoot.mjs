#!/usr/bin/env node
/**
 * The list surface's frames, at 1440 and 390, off the harness `build-harness.mjs` makes:
 *
 *   node apps/webapp/test/list-view-frames/shoot.mjs [--out <dir>] [--trash-live]
 *
 * Each cell prints one line — `FRAME <name> <width> <verdict>` — and a verdict is read off the
 * page (the sentence present or gone), never assumed from the picture. Exit 1 on any red line.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(repo, argOut >= 0 ? process.argv[argOut + 1] : "build/list-view-frames/frames");
mkdirSync(out, { recursive: true });
const PAGE = pathToFileURL(resolve(repo, "build/list-view-frames/harness.html")).href;
const EN = (await import(pathToFileURL(resolve(repo, "apps/webapp/messages/en.json")).href, { with: { type: "json" } })).default;
const TRASH = (await import(pathToFileURL(resolve(repo, "packages/app/messages/trash.en.json")).href, { with: { type: "json" } })).default.trash;
const GONE = EN.reader.gone;
const trashOnly = process.argv.includes("--trash-live");

let red = 0;
const line = (name, w, ok, note = "") => {
  if (!ok) red += 1;
  console.log(`FRAME ${name} ${w} ${ok ? "PASS" : "RED"}${note ? ` ${note}` : ""}`);
};

const browser = await chromium.launch();
async function page(w, query = "", hash = "#/ohbox") {
  const p = await browser.newPage({ viewport: { width: w, height: w > 1023 ? 900 : 844 } });
  if (query === "?view=trash-live") await p.route(/^https?:/, (route) => route.abort());
  await p.goto(`${PAGE}${query}${hash}`);
  await p.waitForFunction(() => window.__lv?.ready === true);
  await p.waitForTimeout(600);
  return p;
}
const text = (p) => p.evaluate(() => document.body.innerText);
const shot = (p, name, w) => p.screenshot({ path: resolve(out, `${name}-${w}.png`) });
const openRow = async (p, view, id) => {
  await p.locator(`.view-${view} .row[data-id="${id}"]`).first().click();
  await p.waitForTimeout(300);
};

async function liveTrash(w) {
  const p = await page(w, "?view=trash-live", "");
  await p.getByRole("region", { name: TRASH.liveHead })
    .getByRole("option", { name: /A receipt the mail server kept/ }).click({ position: { x: 20, y: 10 }, timeout: 5000 });
  const sheet = p.getByRole("dialog", { name: "Reading", exact: true });
  const reading = w <= 699 ? sheet : p.getByRole("region", { name: "Reading", exact: true });
  const article = reading.getByRole("article");
  await article.getByText("The receipt, read from the mail server's own Trash.", { exact: true })
    .waitFor({ timeout: 5000 });
  const sheets = await sheet.count();
  const { top, inset } = await article.evaluate((el) => {
    const style = getComputedStyle(el);
    return { top: style.paddingTop, inset: style.getPropertyValue("--s5").trim() };
  });
  line("trash-live", w, w > 699 ? sheets === 0 : sheets === 1 && top === "24px" && top === inset, `sheet=${sheets} read-top=${top}`);
  await shot(p, "trash-live", w);
  await p.close();
}

for (const w of [1440, 390]) {
  if (trashOnly) {
    await liveTrash(w);
    continue;
  }
  // EMPTY: a tag nothing carries, an empty pile, no drafts, an empty store, an empty Trash.
  for (const [name, hash, sentence] of [
    ["empty-tag", "#/tag/tg2", EN.tag.emptyTitle],
    ["empty-triage", "#/triage/aside", EN.triage.emptyAside],
    ["empty-drafts", "#/drafts", EN.drafts.emptyTitle],
    ["empty-history", "#/history", EN.history.emptyTitle],
    ["empty-trash", "#/trash", EN.trash.emptyTitle],
  ]) {
    const p = await page(w, name === "empty-history" ? "?world=empty" : "", hash);
    await p.waitForTimeout(400);
    let ok = (await text(p)).includes(sentence);
    let note = "";
    if (name === "empty-trash") {
      // The narrow top bar names Trash, and the end-of-list line sits on the rows' 30px gutter.
      const bar = await p.evaluate(() => document.querySelector(".topbar b")?.textContent ?? "");
      const pad = await p.evaluate(() => {
        const el = document.querySelector(".view-trash .rows .tail-row");
        return el ? getComputedStyle(el).paddingLeft : "none";
      });
      ok = ok && pad === "14px" && (w > 1023 || bar === EN.rail.trash);
      note = `topbar=${bar} tail-pad=${pad}`;
    }
    line(name, w, ok, note);
    await shot(p, name, w);
    await p.close();
  }

  // GONE: a picked message another mail client took away, in a tag and in History.
  for (const [view, hash] of [["tag", "#/tag/tg1"], ["history", "#/history"]]) {
    const p = await page(w, "", hash);
    await openRow(p, view, "m1");
    await p.evaluate(() => window.__lv.tombstone("m1"));
    await p.waitForTimeout(500);
    const t = await text(p);
    line(`gone-${view}`, w, t.includes(GONE) && !t.includes("A letter about m2 The whole"));
    await shot(p, `gone-${view}`, w);
    await p.close();
  }

  // REFILL: a News card over a Junk verdict's husk moved out says it is loading from the server.
  {
    const p = await page(w, "", "#/reads");
    await p.locator(".view-reads .sc, .view-reads [data-card], .view-reads article").first().click().catch(() => {});
    await p.waitForTimeout(600);
    line("refill-news", w, (await text(p)).includes(EN.body.withheldJunkLoading));
    await shot(p, "refill-news", w);
    await p.close();
  }

  // THE DROP: History and the open letter say the server did not answer; the first drain after
  // the connection is back clears both sentences.
  {
    const p = await page(w, "", "#/history");
    await p.evaluate(() => { window.__lv.wireDown = true; });
    await p.evaluate(() => window.__lv.go("#/ohbox"));
    await p.waitForTimeout(300);
    await p.evaluate(() => window.__lv.go("#/history"));
    await p.waitForTimeout(800);
    line("drop-history-down", w, (await text(p)).includes(EN.history.storeUnavailable));
    await shot(p, "drop-history-down", w);
    await p.evaluate(async () => { window.__lv.wireDown = false; await window.__lv.drain(); });
    await p.waitForTimeout(800);
    line("drop-history-back", w, !(await text(p)).includes(EN.history.storeUnavailable));
    await shot(p, "drop-history-back", w);
    await p.close();
  }
  {
    const p = await page(w, "", "#/ohbox");
    await p.evaluate(() => { window.__lv.wireDown = true; });
    await openRow(p, "ohbox", "m3");
    await p.waitForTimeout(800);
    const offline = "Couldn't reach ohmail — check your connection.";
    line("drop-reader-down", w, (await text(p)).includes(offline));
    await shot(p, "drop-reader-down", w);
    await p.evaluate(async () => { window.__lv.wireDown = false; await window.__lv.drain(); });
    await p.waitForTimeout(800);
    const t = await text(p);
    line("drop-reader-back", w, !t.includes(offline) && t.includes("23 KB"));
    await shot(p, "drop-reader-back", w);
    await p.close();
  }

  await liveTrash(w);
  {
    const p = await page(w, "?view=address-offline", "");
    await p.waitForTimeout(400);
    const weight = await p.evaluate(() => {
      const el = Array.from(document.querySelectorAll("strong")).find((part) => part.textContent === "this computer");
      return el ? `${getComputedStyle(el).fontWeight}/${getComputedStyle(el).display}` : "none";
    });
    line("address-offline", w, (await text(p)).includes(EN.search.addressOffline) && weight === "500/inline", `device=${weight}`);
    await shot(p, "address-offline", w);
    await p.close();
  }
}
// THE SHEET'S WAY BACK under a coarse pointer between 641 and 699px: drawn 38, hit 44.
if (!trashOnly) {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 844 }, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${PAGE}#/tag/tg1`);
  await p.waitForFunction(() => window.__lv?.ready === true);
  await p.waitForTimeout(600);
  await p.locator('.view-tag .row[data-id="m1"]').first().tap();
  await p.waitForTimeout(500);
  const strip = await p.evaluate(() => {
    const el = document.querySelector(".reader-close");
    if (!el || !matchMedia("(pointer: coarse)").matches) return "none";
    const be = getComputedStyle(el, "::before");
    return be.content === "none" ? "none" : `${be.width}x${be.height}`;
  });
  line("reader-close-coarse", 700, strip === "44pxx44px", `strip=${strip}`);
  await p.screenshot({ path: resolve(out, "reader-close-coarse-700.png") });
  await ctx.close();
}
await browser.close();
console.log(`FRAMES ${red === 0 ? "GREEN" : `RED ${red}`} → ${out}`);
process.exit(red === 0 ? 0 : 1);
