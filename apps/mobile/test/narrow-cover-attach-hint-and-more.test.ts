/**
 * ═══ AT 353 DP: THE ATTACH HINT AND MORE'S FOLDED DESTINATION ═════════════════════════════
 *
 * At 480 dpi the cover is 353 dp wide: the composer's "Up to … total" wrapped alone, right-aligned,
 * under the attach buttons; and the dock folded Receipts into More, where it stood as a lone
 * one-row card above the piles. The hint now starts its own line on the left when the row cannot
 * hold it (decided from widths, never from its own position); the folded destinations head More's
 * one card.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { attachHintFits, attachHintStyle } from "../src/ui/attach-hint";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

describe("the attach hint", () => {
  it("inline while the buttons and the hint fit the row, on its own line on the left once they do not", () => {
    // At 353 dp the row is ~321 dp; the frames measured the two buttons at ~120 and ~120 dp.
    expect(attachHintFits(321, [120, 120], 98)).toBe(false);
    expect(attachHintFits(372, [120, 120], 98)).toBe(true);
    expect(attachHintFits(120 + 8 + 120 + 8 + 98, [120, 120], 98), "the gaps are counted").toBe(true);
    expect(attachHintFits(0, [120, 120], 98), "an unmeasured row keeps the hint inline").toBe(true);
    expect(attachHintStyle(true)).toEqual({ marginLeft: "auto" });
    expect(attachHintStyle(false)).toEqual({ marginLeft: 0 });
  });
  it("the composer decides from widths, which the hint's margin never moves", () => {
    const sheet = src("../src/ui/MessageActions.tsx");
    const at = sheet.indexOf("{Copy.attachCap(sizeLabel(attachCap))}");
    const hint = sheet.slice(sheet.lastIndexOf("<Txt", at), at);
    expect(hint).toContain("style={attachHintStyle(attachHintFits(attachRow.row, [attachRow.files, attachRow.photos], attachRow.hint))}");
    expect(hint).toContain('onLayout={(e) => measureAttach("hint", e.nativeEvent.layout.width)}');
    const row = sheet.slice(sheet.lastIndexOf("columnGap: ATTACH_ROW_GAP", at), at);
    for (const k of ['measureAttach("row"', 'measureAttach("files"', 'measureAttach("photos"']) expect(row).toContain(k);
    expect(row, "a position read feeds the margin back into the wrap").not.toMatch(/layout\.(x|y)\b/);
  });
});

describe("More's folded destinations", () => {
  it("head the one card, never a card of their own", () => {
    const more = src("../app/(tabs)/more.tsx");
    const panels = [...more.matchAll(/<Panel\b/g)];
    expect(panels.length, "More draws a second card").toBe(1);
    const card = more.slice(panels[0]!.index!, more.indexOf("</Panel>"));
    expect(card.indexOf("{folded.map(")).toBeGreaterThan(-1);
    expect(card.indexOf("{folded.map(")).toBeLessThan(card.indexOf("<MoreNav "));
  });
});
