import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

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
    const menus = readFileSync(join(ROOT, "packages/app/src/reader/actions/ActionMenus.tsx"), "utf8");
    expect(menus).toContain('if (menu !== "cardDelete" || !isCardDeleteKey(e.nativeEvent)) return false;');

    const walk = readFileSync(join(ROOT, "packages/app-logic/src/place-list/walk.ts"), "utf8");
    expect(walk).toContain('useCursorPlacer(walk.place, "view")');
    expect(walk).toMatch(/input\.rowRendered\?\.\(first\) === false\)\s*return false;/);
  });
});
