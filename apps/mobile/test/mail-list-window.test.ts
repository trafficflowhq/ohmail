/**
 * THE PHONE'S LISTS ARE A WINDOW. Every mail list mounted every row, and a fold relayout of a
 * large Ohbox re-mounted them all at once and ran the Android heap out; the fix is `MailList`, a
 * `SectionList` under a bounded window. This suite has no React Native renderer (RN's entry is
 * Flow-typed source it cannot load), so what is measured is the design's arithmetic in
 * `mail-list-plan.ts` and the shape of the primitive that reads it, the way `safe-area.ts` and
 * `row-swipe.ts` are measured; the mounted count itself is a device reading. Mutations watched
 * red: `windowSize` widened past the list's length admits the whole list (in-process, case 2); a `.map(`
 * producing an element in `MailList.tsx` turns case 3 red; a screen mapping rows is the census's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import {
  FIRST_GROUP_TOP,
  LIST_WINDOW,
  isSection,
  mountedRowsBound,
  planSections,
} from "../src/ui/mail-list-plan";
import { size } from "../src/theme/type";

const MAILLIST = fileURLToPath(new URL("../src/ui/MailList.tsx", import.meta.url));
const src = withoutComments(readFileSync(MAILLIST, "utf8"));

/** A MailRow's floor: 12+12 padding, three lines at the smallest line height RN's default fonts draw. */
const LINE = 1.15;
const ROW_FLOOR_PT =
  24 + Math.floor(size.body * LINE) + 2 + Math.floor(size.bodyL * LINE) + 1 + Math.floor(size.bodyS * LINE);
const VIEWPORT_PT = 800;
const ROWS = 3000;

const rows = Array.from({ length: ROWS }, (_, i) => ({ id: `m${i}` }));

describe("thousands of rows in one section", () => {
  it("are handed to the list as DATA, one section, none of them an element", () => {
    const planned = planSections([{ key: "all", title: "All", rows }]);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.data).toHaveLength(ROWS);
    expect(planned[0]!.data[0]).toBe(rows[0]);
  });

  it("mount within the window's bound at an 800-pt viewport — a few dozen, not the mailbox", () => {
    expect(ROW_FLOOR_PT, "the row floor is derived, not typed").toBeGreaterThan(60);
    const bound = mountedRowsBound(LIST_WINDOW, VIEWPORT_PT, ROW_FLOOR_PT);
    expect(bound).toBeLessThanOrEqual(90);
    expect(bound).toBeLessThan(ROWS / 30);
  });

  it("the bound reads the window: widened to a thousand viewports it admits the whole list", () => {
    // The in-process mutation of the deciding value — the shape the fix exists to prevent.
    const wide = mountedRowsBound({ ...LIST_WINDOW, windowSize: 1000 }, VIEWPORT_PT, ROW_FLOOR_PT);
    expect(wide).toBeGreaterThan(ROWS);
    // …and the batch alone never reaches the bound: the window is what bounds, not the batch.
    expect(LIST_WINDOW.maxToRenderPerBatch).toBeLessThan(LIST_WINDOW.initialNumToRender * 2);
  });
});

describe("the primitive reads the plan and nothing else", () => {
  it("spreads the window onto the SectionList and hands the rows as sections", () => {
    const list = src.indexOf("<SectionList");
    expect(list).toBeGreaterThan(-1);
    // The element runs to the provider's close: its header prop holds a `/>` of its own.
    const el = src.slice(list, src.indexOf("</CellRulesContext.Provider>", list));
    expect(el).toContain("{...LIST_WINDOW}");
    expect(el).toContain("sections={sections}");
    expect(el).toContain("renderItem={renderItem}");
    expect(el).toContain("CellRendererComponent={Cell}");
    expect(el).toContain('accessibilityRole="list"');
    expect(el, "iOS defaults to sticky section headers; the lists never had them").toContain(
      "stickySectionHeadersEnabled={false}",
    );
    // Android's clipping is the one platform switch, and a ledger-placed list (History) is outside
    // it: there a small swipe after a rail press blanked the viewport.
    expect(el, "Android's clipping is the one platform switch").toContain(
      'removeClippedSubviews={Platform.OS === "android" && rowLayout === undefined}',
    );
    // The list keys its window by the first row; the native hold skips the surface only once it
    // has mounted (a first ROW there let a growing head scroll the title off), and a change within
    // TOP_HOLD of the top scrolls back to 0 as the belt.
    expect(el, "the list's window follows the first row").toContain("minIndexForVisible: 1,");
    expect(src, "the native hold skips the injected surface only once it exists").toContain(
      "const anchorFrom = (surface !== null ? 1 : 0) + 1;",
    );
    expect(el).toContain("autoscrollToTopThreshold: TOP_HOLD");
    expect(src).toContain("const sections = useMemo(() => planSections(groups), [groups]);");
  });

  it("maps nothing into elements and measures rows, unless the caller hands the heights it draws", () => {
    expect(src).not.toMatch(/\.map\(/);
    // A list is measured as it lays out; the one exception is a caller that draws its rows at
    // heights it keeps (`rowLayout`), and the layout is built from those and nothing else.
    expect(src.match(/getItemLayout/g) ?? []).toHaveLength(1);
    expect(src).toContain("getItemLayout={itemLayout}");
    expect(src).toContain("rowLayout ? sectionItemLayout(sections, rowLayout, headH ?? 0) : undefined");
  });

  it("the cell is one module-scope component, so a render never remounts the window", () => {
    expect(src).toMatch(/^function Cell\(/m);
    expect(src).not.toMatch(/CellRendererComponent=\{\(/);
  });
});

describe("the sections' rules, in the plan", () => {
  it("an empty group draws nothing and the first TITLED group wears the 18", () => {
    const planned = planSections([
      { key: "resurfaced", title: "Resurfaced", rows: [] },
      { key: "fresh", title: "New", rows: rows.slice(0, 2) },
      { key: "seen", title: "Seen", rows: rows.slice(2, 5) },
    ]);
    expect(planned.map((s) => s.key)).toEqual(["fresh", "seen"]);
    expect(planned.map((s) => s.first)).toEqual([true, false]);
    expect(FIRST_GROUP_TOP).toBe(18);
  });

  it("an untitled shelf keeps its room above the first row, and is never `first`", () => {
    const planned = planSections([{ key: "waiting", rows: rows.slice(0, 3), padTop: 8 }]);
    expect(planned[0]!.title).toBeNull();
    expect(planned[0]!.padTop).toBe(8);
    expect(planned[0]!.first).toBe(false);
  });

  it("a header cell's item is the section; a row's is not", () => {
    const planned = planSections([{ key: "all", rows: rows.slice(0, 1) }]);
    expect(isSection(planned[0])).toBe(true);
    expect(isSection(rows[0])).toBe(false);
    expect(isSection(null)).toBe(false);
    expect(isSection({ key: "all", data: [] }), "a look-alike without the brand").toBe(false);
  });
});
