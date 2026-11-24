/**
 * ONE TALL ROW DOES NOT INFLATE THE REST (HISTORY-SLOT-IS-THE-TALLEST-ROW). The slot was the tallest row seen, so one
 * row whose badges wrap to a second line widened every slot and left blank space under the others. Each row is now
 * drawn at its own measured height, and a row not yet laid out at the most common one (`history-slot.ts`).
 *
 * The fixture combines a device sample with badge styles and row insets. It checks the height ledger and the sum
 * that positions a year jump. `history-slot.test.ts` checks screen wiring. A device pass measures real line heights
 * and where the native list places a row before layout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { design } from "@ohmail/tokens/design";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { size } from "../src/theme/type";
import { HISTORY_SLOT_FIRST_PAINT, SlotHeights } from "../src/ui/history-slot";

const APP = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => withoutComments(readFileSync(`${APP}/${rel}`, "utf8"));
const ROW = read("src/ui/MailRow.tsx");
const BASE = read("src/ui/base.tsx");

function literal(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  if (!m) throw new Error(`no ${what} in the source this case reads`);
  return Number(m[1]);
}
/* A History row as the device laid it out (the chip at 214 px of a 420 dpi row), and the same row with its badge
   line wrapped once: the line gap and one more chip. */
const badgePad = literal(BASE, /paddingHorizontal: 7,\s*paddingVertical: (\d+)/, "Badge padding");
const lineGap = literal(ROW, /flexDirection: "row", flexWrap: "wrap", gap: (\d+)/, "badge line gap");
const chip = 2 * badgePad + size.micro;
// Add the ordinary MailRow bottom inset after the measured chip position.
const inset = Number.parseFloat(design.faces.paper.light.s2);
const common = Math.ceil(214 / (420 / 160) + chip + inset);
const wrapped = Math.ceil(common + lineGap + chip);

/** The heights the screen draws rows 0..n-1 at — what the list stacks, so what an offset must add up. */
const drawn = (h: SlotHeights, n: number): number[] => Array.from({ length: n }, (_, i) => h.heightOf(i));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe("each row keeps its own height", () => {
  it("the height fixture uses the same inset as the ordinary History row", () => {
    expect(ROW).toMatch(/paddingBottom: receiptPaper \? \d+ : receipt \? \d+ : mailSize\.inset/);
    expect(inset).toBeGreaterThan(0);
  });

  it("one wrapped row is taller; the rows around it, laid out or not, stay at the common height", () => {
    const h = new SlotHeights();
    for (let i = 0; i < 12; i++) h.record(i, i === 5 ? wrapped : common);
    expect(wrapped, "the fixture's wrapped row is taller").toBeGreaterThan(common);
    expect(h.heightOf(5)).toBe(wrapped);
    expect(drawn(h, 40).filter((x) => x !== common)).toEqual([wrapped]);
  });

  it("the common height is the most rows' height, so a few tall rows never become it", () => {
    const h = new SlotHeights();
    for (let i = 0; i < 4; i++) h.record(i, common);
    h.record(4, wrapped);
    h.record(5, wrapped);
    expect(h.heightOf(100), "the last row laid out is not the common one").toBe(common);
    expect(h.heightOf(5)).toBe(wrapped);
  });

  it("before any row lays out, a slot is the first-paint height; a row re-measured follows its content", () => {
    const h = new SlotHeights();
    expect(h.heightOf(7)).toBe(HISTORY_SLOT_FIRST_PAINT);
    h.record(3, common);
    expect(h.record(3, common), "an unchanged height asks for no redraw").toBe(false);
    expect(h.record(3, common * 1.3)).toBe(true);
    expect(h.heightOf(3)).toBe(Math.ceil(common * 1.3));
    h.record(3, Number.NaN);
    h.record(-1, common);
    expect(h.heightOf(3)).toBe(Math.ceil(common * 1.3));
  });
});

describe("an offset is the sum of the heights drawn above it — the year jump lands on its row", () => {
  /* Holes (rows never laid out), a deleted row drawn at 0, a tall row, and a common height that moves. */
  const ledger = (): SlotHeights => {
    const h = new SlotHeights();
    for (const i of [0, 1, 2, 9, 10, 400]) h.record(i, common);
    h.record(3, wrapped);
    h.record(11, 0);
    h.record(1200, wrapped);
    return h;
  };

  it("at every row, laid out or not", () => {
    const h = ledger();
    for (const start of [0, 1, 3, 4, 9, 11, 12, 399, 401, 1200, 1201, 5000]) {
      expect(h.offsetOf(start), `row ${start}`).toBe(sum(drawn(h, start)));
    }
  });

  it("the row an offset falls in is the row drawn there, a deleted row skipped", () => {
    const h = ledger();
    for (let i = 0; i < 1300; i++) {
      const at = h.offsetOf(i);
      if (h.heightOf(i) === 0) continue;
      expect(h.indexAt(at, 5000)).toBe(i);
      expect(h.indexAt(at + h.heightOf(i) - 0.5, 5000)).toBe(i);
    }
    expect(h.indexAt(-10, 5000)).toBe(0);
    expect(h.indexAt(1e9, 5000)).toBe(4999);
    expect(h.indexAt(0, 0)).toBe(0);
  });

  it("with every row at one height it is the old arithmetic, start × slot — the positive control", () => {
    const h = new SlotHeights();
    for (let i = 0; i < 30; i++) h.record(i, common);
    expect(h.offsetOf(2021)).toBe(2021 * common);
  });

  it("stays exact when rows are laid out far beyond the first ones (the ledger grows)", () => {
    const h = ledger();
    h.record(70_000, wrapped);
    expect(h.offsetOf(70_001)).toBe(sum(drawn(h, 70_001)));
  });
});
