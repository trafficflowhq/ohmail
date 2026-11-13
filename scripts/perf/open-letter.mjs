#!/usr/bin/env node
/**
 * OPENING A LETTER — from the press on a row of the Ohbox to that letter's first lines on screen,
 * over planted mail, in a real browser. The goal is `latency.open-message` of
 * `test/contracts/perf-budgets.json` (p95), and the figure asked of it is the p95 over every open.
 *
 *   node scripts/perf/open-letter.mjs [--size 5k|25k|large] [--viewport 1440x900] [--engine chromium|webkit]
 *                                     [--reps 5] [--dist DIR] [--out FILE.json] [--trace FILE.json] [--body-ms 0]
 *   node scripts/perf/open-letter.mjs build --out DIR      the page alone, for --dist
 *
 * A rep is a fresh page and twelve opens, each of a letter not opened before: four of each kind the
 * page plants (`plain` text held in the mirror, a short `prose` HTML letter, a 50 KB `designed`
 * one, the last two fetched from the adapter). On a narrow viewport the reader covers the list, so
 * each open is followed by Escape. `--size` is a size class of the budgets file (5k when absent; the
 * row names no class, so its goal is asked of any); `--trace` keeps
 * Chromium's own performance recording of the run. The last line is the verdict
 * (`speed-check.mjs` has the rules): OPEN_LETTER: RECORDED | GREEN | RED | REFUSED.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, openPage, stats } from "./speed-check.mjs";

const KINDS = ["plain", "prose", "designed"];
const PER_KIND = 4;
/** The reader as a narrow window shows it: a sheet over the list, which Escape closes. */
const SHEET = '.reader[role="dialog"]';

/** The next row of the Ohbox that holds a letter of `kind` not opened yet, scrolled to where a press reaches it. */
const nextRow = (page, kind, opened) => page.evaluate(([k, done]) => {
  const rows = [...document.querySelectorAll(".view-ohbox button.row[data-id]")];
  const row = rows.find((r) => !done.includes(r.dataset.id) && window.__speed.kindOf(r.dataset.id) === k);
  if (row === undefined) {
    document.querySelector(".view-ohbox .scroller")?.scrollBy(0, 600);
    return null;
  }
  row.scrollIntoView({ block: "center" });
  return row.dataset.id;
}, [kind, opened]);

/** One arm: `reps` fresh pages, twelve opens each. Every open is in `opens`; one that never showed its letter has `ms: null`. */
export async function runOpens({ dist, engine, viewport, messages, bodyMs = 0, trace = null, reps = 5 }) {
  const opens = [];
  const errors = [];
  let bootMs = 0;
  let uiVitals = null;
  for (let r = 0; r < reps; r++) {
    const visit = await openPage({ dist, engine, viewport, messages, bodyMs, trace: r === 0 ? trace : null });
    const { page } = visit;
    bootMs = Math.max(bootMs, visit.bootMs);
    const opened = [];
    for (let k = 0; k < PER_KIND * KINDS.length; k++) {
      const kind = KINDS[k % KINDS.length];
      let id = null;
      for (let tries = 0; id === null && tries < 40; tries++) {
        id = await nextRow(page, kind, opened);
        await page.waitForTimeout(id === null ? 150 : 250);
      }
      if (id === null) {
        opens.push({ rep: r, kind, id: null, ms: null, why: "no row of this kind left in the Ohbox" });
        continue;
      }
      opened.push(id);
      const wait = visit.arm("letter", id, 10000);
      await page.waitForTimeout(30);
      await page.click(`.view-ohbox button.row[data-id="${id}"]`);
      opens.push({ rep: r, kind, id, ...((await wait) ?? { ms: null, why: "the letter's first lines never came on screen" }) });
      /* Past the moment an opened letter turns read, so that its own bookkeeping is not the next open's. */
      await page.waitForTimeout(1000);
      if (await page.isVisible(SHEET)) {
        await page.keyboard.press("Escape");
        await page.waitForSelector(SHEET, { state: "hidden", timeout: 10000 }).catch(() => {});
      }
    }
    const v = await page.evaluate(() => window.__speed.vitals());
    if (r === reps - 1) uiVitals = { openP50Ms: v.openP50Ms ?? null, openP95Ms: v.openP95Ms ?? null, openCount: v.openCount ?? null };
    errors.push(...visit.errors);
    await visit.close();
  }
  return { opens, errors: errors.slice(0, 8), bootMs, uiVitals, reps };
}

/** The run as the verdict reads it: the p95 over every open, `null` unless every open was read. */
export function summarizeOpens(run) {
  const ms = (rows) => rows.map((o) => o.ms).filter((v) => typeof v === "number");
  const missed = run.opens.filter((o) => typeof o.ms !== "number");
  const all = stats(ms(run.opens));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, stats(ms(run.opens.filter((o) => o.kind === k)))]));
  const readingMs = missed.length > 0 || all.n === 0 ? null : all.p95Ms;
  const what = readingMs === null
    ? (missed.length > 0 ? `${missed.length} of ${run.opens.length} opens were not read (${missed[0].why})` : "no open was made")
    : `p95 ${all.p95Ms} ms, median ${all.medianMs} ms over ${all.n} opens`;
  const detail = [
    ...KINDS.map((k) => `  ${k.padEnd(9)} median ${byKind[k].medianMs ?? "-"} ms · p95 ${byKind[k].p95Ms ?? "-"} ms · max ${byKind[k].maxMs ?? "-"} ms · ${byKind[k].n} opens`),
    `  the window's own ui_vitals over the last page: open p50 ${run.uiVitals?.openP50Ms ?? "-"} ms · p95 ${run.uiVitals?.openP95Ms ?? "-"} ms · ${run.uiVitals?.openCount ?? 0} opens`,
    `  longest frame gap in an open ${Math.round(Math.max(0, ...run.opens.map((o) => o.maxGapMs ?? 0)))} ms · page ready in ${run.bootMs} ms at most`,
  ];
  return { readingMs, what, detail, summary: { all, byKind } };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main({
    tag: "OPEN_LETTER", budgetKey: "open-message", goalField: "p95Ms",
    usage: "open-letter.mjs [--size 5k|25k|large] [--viewport WxH] [--engine chromium|webkit] [--reps N] [--dist DIR] [--out FILE] [--trace FILE] | build --out DIR",
    measure: async (options) => {
      const run = await runOpens(options);
      return { ...run, ...summarizeOpens(run) };
    },
  }));
}
