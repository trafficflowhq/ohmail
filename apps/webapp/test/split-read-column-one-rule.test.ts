import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * TRASH-VIEW-READ-COLUMN-SURVIVES-THE-PHONE-BREAKPOINT. `readColumnHidden()` asks one width
 * question and opens the sheet under it, so every split view's reading column must be hidden at
 * that width: one rule over `.view.split > .read-col`, not a list of views one of which (Trash)
 * was missing. Asked both ways: the rule is there, and every view with a column is a split view.
 */
const APP = join(__dirname, "..", "app");
const VIEWS = join(APP, "views");
/* The Ohbox's reading column stands in the shell's adapter, beside the Ohbox's own list. */
const OHBOX = join(APP, "shell", "TodaysOhbox.tsx");

/** Each `@media (<query>) { … }` block, brace-matched, joined. */
function mediaBlocks(css: string, query: string): string {
  const out: string[] = [];
  const open = `@media ${query}`;
  for (let at = css.indexOf(open); at >= 0; at = css.indexOf(open, at + 1)) {
    let depth = 0;
    let i = css.indexOf("{", at);
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(at, i + 1));
  }
  return out.join("\n");
}

describe("one rule hides every split view's reading column at phone widths", () => {
  const css = readFileSync(join(APP, "app.css"), "utf8");
  const narrow = mediaBlocks(css, "(max-width: 699.98px)");

  it("the classic narrow block hides `.view.split > .read-col` and names no view one by one", () => {
    expect(narrow).toMatch(/\.view\.split > \.read-col\s*\{\s*display:\s*none;/);
    expect(narrow, "a per-view hide rule came back beside the one rule").not.toMatch(/\.view-[a-z]+ \.read-col\s*[,{]/);
  });

  it("the Zero ladder re-shows the same column over 722px", () => {
    const zero = readFileSync(join(APP, "zero-layout.css"), "utf8");
    expect(zero).toMatch(/:root\[data-layout="zero"\] \.view\.split > \.read-col\s*\{\s*display:\s*block;/);
  });

  it("every view that renders a reading column is a split view, so the rule reaches it", () => {
    const withColumn: string[] = [];
    const files = [...readdirSync(VIEWS).filter((n) => n.endsWith(".tsx")).map((n) => join(VIEWS, n)), OHBOX];
    for (const path of files) {
      const f = basename(path);
      const src = withoutComments(readFileSync(path, "utf8")) as string;
      if (!/<(List)?ReadColumn\b|className="read-col/.test(src)) continue;
      withColumn.push(f);
      expect(src, `${f} renders a reading column outside a .view.split`).toMatch(/className=\{?[^}\n]*["`]view split /);
    }
    // The control: the census found the views it is about, Trash among them.
    expect(withColumn).toEqual(expect.arrayContaining(["TrashView.tsx", "FolderView.tsx", "HistoryView.tsx", "TodaysOhbox.tsx"]));
  });
});
