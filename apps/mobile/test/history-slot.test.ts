/**
 * A HISTORY ROW'S SLOT HOLDS THE WHOLE ROW, FOLDER CHIP INCLUDED. The slot was the constant 84 and a History row
 * carries a fourth line (the chip naming where the message lives): a device's accessibility tree read the row box
 * [486..706] and the chip [700..706]. A slot is now its own row's measured height (`history-slot.ts`).
 *
 * CAN MEASURE: the slot rule against the device's reading of where the chip starts, the chip's box and the row's
 * padding read from the modules the row renders with, and that the screen routes every row's height into that rule
 * and every offset through the ledger. CANNOT: real line heights under a font scale (no React Native renderer here),
 * which is why the screen measures; a device pass reads it.
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
const SCREEN = read("app/history.tsx");
/** History's asks of the store: the scroll read and the press, renderer-free. */
const ASKS = read("src/ui/history-asks.ts");
const SEARCH = read("app/search.tsx");
const ROW = read("src/ui/MailRow.tsx");
const BASE = read("src/ui/base.tsx");

/** That device reading (the 0.24.0 APK on a 420 dpi emulator): px, and px per dp. */
const DEVICE = { pxPerDp: 420 / 160, rowTop: 486, rowBottom: 706, chipTop: 700 };
const dp = (px: number): number => px / DEVICE.pxPerDp;

/** A number from one style literal in a module's source — so a padding change moves this case with it. */
function literal(src: string, re: RegExp, what: string): number {
  const m = src.match(re);
  if (!m) throw new Error(`no ${what} in the source this case reads`);
  return Number(m[1]);
}
const rowPadBottom = Number.parseFloat(design.faces.paper.light.s2);
const badgePad = literal(BASE, /paddingHorizontal: 7,\s*paddingVertical: (\d+)/, "Badge padding");

/** The row's box as it lays out: the chip starts where the device read it, and is at least its text tall. */
const chipTop = dp(DEVICE.chipTop - DEVICE.rowTop);
const chipBottom = chipTop + 2 * badgePad + size.micro;
const rowNatural = chipBottom + rowPadBottom;

describe("the slot holds the row it clips", () => {
  it("the clipped row box IS the first-paint slot: without a measurement the chip is cut", () => {
    expect(Math.abs(dp(DEVICE.rowBottom - DEVICE.rowTop) - HISTORY_SLOT_FIRST_PAINT)).toBeLessThan(0.5);
    expect(chipBottom, "the case's positive control: this row does not fit the old slot").toBeGreaterThan(HISTORY_SLOT_FIRST_PAINT);
  });

  it("once a row with its folder chip lays out, the slot holds the chip and the padding under it", () => {
    expect(ROW).toMatch(/paddingBottom: receiptPaper \? \d+ : receipt \? \d+ : mailSize\.inset/);
    const h = new SlotHeights();
    h.record(0, rowNatural);
    const slot = h.heightOf(0);
    expect(slot, "the chip is clipped by its slot").toBeGreaterThanOrEqual(chipBottom);
    expect(slot).toBeGreaterThanOrEqual(rowNatural);
    expect(Number.isInteger(slot)).toBe(true);
  });

  it("follows a larger font scale, and a shorter row later never cuts the taller one", () => {
    const scaled = rowNatural * 1.3;
    const h = new SlotHeights();
    h.record(0, rowNatural);
    h.record(0, scaled);
    expect(h.heightOf(0)).toBeGreaterThanOrEqual(scaled);
    h.record(1, rowNatural);
    h.record(0, Number.NaN);
    expect(h.heightOf(0)).toBeGreaterThanOrEqual(scaled);
  });
});

/* Search draws the store's hits in History's slots, and a hit with a badge line was cut the same way. */
describe.each([["History", SCREEN, "i"], ["Search", SEARCH, "r\\.slot"]])("%s measures its rows and lays every offset on them", (_name, src, at) => {
  it("no constant decides a slot's height", () => {
    expect(src).not.toMatch(/SLOT_PX|grownSlot|setSlot/);
    expect(src).toMatch(new RegExp(`height: m === "gone" \\? 0 : heights\\.heightOf\\(${at}\\),`));
  });

  it("every drawn row reports its own laid-out height under its index, a deleted row at 0", () => {
    expect(src).toMatch(new RegExp(`onLayout=\\{\\(e\\) => onRowHeight\\(${at}, e\\.nativeEvent\\.layout\\.height\\)\\}>\\s*<MailRow`));
    expect(src).toMatch(new RegExp(`m === "gone" \\? <View onLayout=\\{\\(\\) => onRowHeight\\(${at}, 0\\)\\} />`));
    expect(src).toMatch(/if \(heights\.record\(i, height\)\) redraw\(\);/);
  });

  it("the scroll window reads the rows on screen off the same ledger", () => {
    if (src === SCREEN) {
      // History hands the offset and the viewport to its asks, which read the same ledger.
      expect(src).toContain("viewport.current = layoutMeasurement.height;");
      expect(src).toContain("asks.scrolled(h, contentOffset.y - top.current, viewport.current, h.length)");
      expect(src).toContain("new HistoryAsks(heights)");
      expect(ASKS).toMatch(/this\.heights\.indexAt\(top, length\)/);
      expect(ASKS).toMatch(/this\.heights\.indexAt\(top \+ Math\.max\(0, viewport\), length\)/);
      return;
    }
    expect(src).toMatch(/heights\.indexAt\(y, /);
    expect(src).toMatch(/heights\.indexAt\(y \+ layoutMeasurement\.height, /);
  });
});

it("History's year jump lands where the ledger puts the year's first row", () => {
  expect(SCREEN).toMatch(/scrollTo\.current\?\.\(top\.current \+ asks\.jumped\(h, start, viewport\.current, h\.length\)\);/);
  expect(ASKS).toMatch(/const y = this\.heights\.offsetOf\(start\);[\s\S]*return y;/);
});
