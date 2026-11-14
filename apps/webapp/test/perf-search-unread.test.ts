import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

it("refuses a search run when a timed question has no result rows", async () => {
  const { summarizeSearches } = await import(join(ROOT, "scripts/perf/search-first.mjs"));
  const result = summarizeSearches({
    searches: [
      { phase: "first", rows: 0, ms: 32 },
      { phase: "later", rows: 1, ms: 20 },
    ],
    bootMs: 0,
  });
  expect(result.readingMs).toBeNull();
  expect(result.what).toMatch(/no result row/);
});

it("leaves a question unread if the previous result survives clearing the search box", async () => {
  const { runSearches } = await import(join(ROOT, "scripts/perf/search-first.mjs"));
  const dist = mkdtempSync(join(tmpdir(), "ohmail-search-clear-"));
  try {
    writeFileSync(join(dist, "index.html"), `
      <section class="fr-list">
        <div class="ob-list"><div role="option" data-id="letter">Letter</div></div>
        <input aria-label="Search">
        <div id="results"></div>
      </section>
      <script src="entry.js"></script>
    `);
    writeFileSync(join(dist, "entry.js"), `
      window.__speed = {
        words: { common: "common", rare: "rare", sender: "sender", two: "two words" },
        resetVitals() {},
        vitals() { return {}; },
      };
      const box = document.querySelector("input");
      const results = document.querySelector("#results");
      document.addEventListener("keydown", (event) => {
        if (event.key !== "/") return;
        event.preventDefault();
        box.focus();
      });
      let firstClear = true;
      box.addEventListener("input", () => {
        if (box.value) {
          results.innerHTML = '<div role="listitem" data-hit>Result</div>';
        } else if (firstClear) {
          firstClear = false;
          setTimeout(() => results.replaceChildren(), 12000);
        } else {
          results.replaceChildren();
        }
      });
    `);
    const run = await runSearches({ dist, engine: "chromium", messages: 1, reps: 1 });
    expect(run.errors).toEqual([]);
    expect(run.searches.map(({ phase }: { phase: string }) => phase)).toEqual(["first", "later", "later", "later", "later"]);
    expect(run.searches[0].ms).toBeGreaterThan(0);
    expect(run.searches[1]).toMatchObject({ q: "rare", rows: 0, ms: null, why: expect.stringMatching(/previous result/) });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}, 75_000);
