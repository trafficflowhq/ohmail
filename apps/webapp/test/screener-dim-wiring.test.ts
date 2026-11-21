import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rows = readFileSync("packages/app/src/screener/list/Rows.tsx", "utf8");
const list = readFileSync("packages/app/src/screener/ScreenerList.tsx", "utf8");
const css = readFileSync("packages/ui/src/mail/Lists/row.css", "utf8");
const shared = readFileSync("packages/ui/src/mail/Lists/Row.tsx", "utf8");

describe("the Screener's decided piles are dimmed and its queue is not", () => {
  it("the screened-out pile is dimmed, like the spam pile beside it", () => {
    expect(list).toContain("<Rows view={view} scroller={listScroller}");
    expect(rows).toContain('const waiting = view.segment === "waiting"');
    expect(rows).toContain("decided={!waiting}");
    expect(rows).toContain("const unread = !decided && sender.held.some((h) => h.unread === true)");
  });

  it("spam is still dimmed", () => {
    expect(list).toMatch(/quarantineShelf[\s\S]*?<Rows[\s\S]*?\.\.\.view/);
    expect(rows).toContain("decided={!waiting}");
    expect(rows).toContain("const unread = !decided");
  });

  it("the waiting queue is not swept — its dimming stays per-sender", () => {
    expect(rows).toContain("sender.held.some((h) => h.unread === true)");
    expect(rows).toContain("unread={unread}");
  });

  it("no screened-out row claims an unread dot", () => {
    expect(rows).toMatch(/const unread = !decided &&/);
    expect(shared).toContain("unread={unread && !tick && !stream}");
  });

  it("the prop is what quiets the ink", () => {
    expect(css).toMatch(/\.oh-row:not\(\[data-unread\], \[data-open\]\) \.oh-row-who,[\s\S]*?color: var\(--ink-read\)/);
    expect(css).toMatch(/\.oh-row-subject \{[^}]*font-weight: var\(--w-text\)/);
    expect(css).toMatch(/\.oh-row\[data-unread\] \.oh-row-who,[\s\S]*?font-weight: var\(--w-bold\)/);
  });
});
