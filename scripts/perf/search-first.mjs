#!/usr/bin/env node
/**
 * FIRST SEARCH RESULTS — from the question to the first result row on screen, over planted mail, in
 * a real browser. The goal is `latency.search-first` of `test/contracts/perf-budgets.json`.
 *
 *   node scripts/perf/search-first.mjs [--size large|25k|5k] [--viewport 1440x900] [--engine chromium|webkit]
 *                                      [--reps 10] [--dist DIR] [--out FILE.json] [--trace FILE.json]
 *   node scripts/perf/search-first.mjs build --out DIR      the page alone, for --dist
 *
 * ohmail searches as you type; there is no Enter to time from. So the question lands in the box in
 * one event, as a paste does, and the clock runs from that event to the first result row painted.
 * A rep is a fresh page and five questions. The `first` one is asked the moment `/` has opened the
 * box, before the index over the mirror can have been built: the first search of a session. The four
 * `later` ones (a rare word, a sender, two words, the common word again) follow with the box cleared
 * between them. The figure asked of the goal is the worse of the two p95s, because a search is
 * inside its goal only when both are. The row's goal is for "the rig's full corpus", the budgets
 * file's `large` class: that is the class read when `--size` is absent, and a run over a smaller
 * one prints its reading with no distance to the goal. The last line is the verdict (`speed-check.mjs` has the
 * rules): SEARCH_FIRST: RECORDED | GREEN | RED | REFUSED.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, openPage, stats } from "./speed-check.mjs";

const BOX = '.view-search input[type="text"], input[aria-label="Search"]';

/** One arm: `reps` fresh pages, five questions each. Every question is in `searches`; one with no row has `ms: null`. */
export async function runSearches({ dist, engine, viewport, messages, bodyMs = 0, trace = null, reps = 10 }) {
  const searches = [];
  const errors = [];
  let bootMs = 0;
  let uiVitals = null;
  for (let r = 0; r < reps; r++) {
    const visit = await openPage({ dist, engine, viewport, messages, bodyMs, trace: r === 0 ? trace : null });
    const { page } = visit;
    bootMs = Math.max(bootMs, visit.bootMs);
    const words = await page.evaluate(() => window.__speed.words);
    const ask = async (phase, q) => {
      const wait = visit.arm("hits", null);
      await page.waitForTimeout(30);
      await page.keyboard.insertText(q);
      /* A question with no row says what the box held, so a lost input is told from a search with no answer. */
      const read = (await wait) ?? { ms: null, why: `no result row came on screen for "${q}" (the box held "${await page.locator(BOX).first().inputValue().catch(() => "?")}")` };
      const rows = await page.locator(".view-search [data-hit]").count();
      searches.push({ rep: r, phase, q, rows, ...read });
    };
    await page.keyboard.press("/");
    await page.waitForSelector(BOX, { state: "visible", timeout: 10000 });
    await ask("first", words.common);
    for (const q of [words.rare, words.sender, words.two, words.common]) {
      await page.waitForTimeout(400);
      await page.fill(BOX, "");
      await page.waitForSelector(".view-search [data-hit]", { state: "detached", timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(250);
      await ask("later", q);
    }
    const v = await page.evaluate(() => window.__speed.vitals());
    if (r === reps - 1) uiVitals = { searchP50Ms: v.searchP50Ms ?? null, searchP95Ms: v.searchP95Ms ?? null, searchCount: v.searchCount ?? null };
    errors.push(...visit.errors);
    await visit.close();
  }
  return { searches, errors: errors.slice(0, 8), bootMs, uiVitals, reps };
}

/** The run as the verdict reads it: the worse p95 of the first and the later questions, `null` unless every one was read. */
export function summarizeSearches(run) {
  const ms = (rows) => rows.map((s) => s.ms).filter((v) => typeof v === "number");
  const missed = run.searches.filter((s) => typeof s.ms !== "number");
  const first = stats(ms(run.searches.filter((s) => s.phase === "first")));
  const later = stats(ms(run.searches.filter((s) => s.phase === "later")));
  const read = missed.length === 0 && first.n > 0 && later.n > 0;
  const readingMs = read ? Math.max(first.p95Ms, later.p95Ms) : null;
  const what = read
    ? `first search p95 ${first.p95Ms} ms (median ${first.medianMs}, ${first.n} asked) · later p95 ${later.p95Ms} ms (median ${later.medianMs}, ${later.n} asked)`
    : (missed.length > 0 ? `${missed.length} of ${run.searches.length} questions were not read (${missed[0].why})` : "no question was asked");
  const detail = [
    `  first     median ${first.medianMs ?? "-"} ms · p95 ${first.p95Ms ?? "-"} ms · max ${first.maxMs ?? "-"} ms · ${first.n} questions`,
    `  later     median ${later.medianMs ?? "-"} ms · p95 ${later.p95Ms ?? "-"} ms · max ${later.maxMs ?? "-"} ms · ${later.n} questions`,
    `  the window's own ui_vitals over the last page: search p50 ${run.uiVitals?.searchP50Ms ?? "-"} ms · p95 ${run.uiVitals?.searchP95Ms ?? "-"} ms · ${run.uiVitals?.searchCount ?? 0} searches`,
    `  longest frame gap in a search ${Math.round(Math.max(0, ...run.searches.map((s) => s.maxGapMs ?? 0)))} ms · page ready in ${run.bootMs} ms at most`,
  ];
  return { readingMs, what, detail, summary: { first, later } };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main({
    tag: "SEARCH_FIRST", budgetKey: "search-first", goalField: "ceilingMs", goalSize: "large",
    usage: "search-first.mjs [--size large|25k|5k][--viewport WxH] [--engine chromium|webkit] [--reps N] [--dist DIR] [--out FILE] [--trace FILE] | build --out DIR",
    measure: async (options) => {
      const run = await runSearches(options);
      return { ...run, ...summarizeSearches(run) };
    },
  }));
}
