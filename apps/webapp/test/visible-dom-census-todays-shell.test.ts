import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const RETAINED_SHELL = join(ROOT, "apps/webapp/app/shell");

describe("the shell's document queries skip hidden piles", () => {
  it("the census bites: the queries it moved are still spelled the way it reads", () => {
    for (const [file, needle] of [
      ["packages/app-logic/src/keys/focus-follows.ts", 'queryAllVisible<HTMLElement>(".row[data-id], .oh-row[data-id]")'],
      ["packages/app-logic/src/keys/focus-follows.ts", 'return queryVisible<HTMLElement>(".view .row.sel, .view .oh-row[data-open], section.fr-list .oh-row[data-open]")'],
      ["packages/app-logic/src/place-list/live.ts", "queryAllVisible<HTMLElement>(rowsSelector).some((row) => row.dataset.id === id)"],
    ] as const) {
      expect(readFileSync(join(ROOT, file), "utf8"), `${file} no longer filters hidden rows`).toContain(needle);
    }

    // Delete confirmation belongs to the open card and is driven by its own menu state.
    const keys = readFileSync(join(ROOT, "packages/app/src/reader/keys.ts"), "utf8");
    expect(keys).toContain('run: () => open.menu("cardDelete")');
    expect(keys).toContain('verb("d", ts("key.deleteAsk"), show("cardDelete"), { when: isCardDeleteKey })');
    const bar = readFileSync(join(ROOT, "packages/app/src/reader/actions/ActionBar.tsx"), "utf8");
    expect(bar).toContain('if (menu !== "cardDelete" || !isCardDeleteKey(e.nativeEvent)) return false;');

    const messageVerbs = readFileSync(join(RETAINED_SHELL, "message-verbs.ts"), "utf8");
    expect(messageVerbs, "the retained Delete confirmation no longer asks queryVisible")
      .toContain('queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")');
    const cursor = readFileSync(join(RETAINED_SHELL, "cursor-placer.ts"), "utf8");
    expect(cursor, "the retained cursor no longer asks queryVisible")
      .toContain("queryVisible<HTMLElement>(`${host.scope} :is(.row, .oh-row)");
    expect(messageVerbs, "the retained row action no longer asks queryVisible")
      .toContain("return queryVisible<HTMLElement>(`${scope} :is(.row, [role=option])");
  });
});
