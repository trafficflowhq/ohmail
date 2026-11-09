/**
 * ═══ THE SENDER PAGE ON A SHORT WINDOW, AND ITS NAME ON A NARROW PANE ═══════════════════════════
 *
 * on the cover screen held sideways (905 x 403 dp) the decision panel wrapped its five capsules,
 * the scope control and the explainer onto ~230 dp and left the held message a 173 dp strip. At
 * compact height it is one sideways-scrolling row with the scope control at its end and no
 * explainer (the capsules carry it as their hint). the name takes the reader's title role (29)
 * on a pane of 480 dp or more, the view title (22) below, three lines at most.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { heightClassOf } from "../src/ui/posture/derive";
import { type } from "../src/theme/type";
import { decisionPanelShape, scopeEndsRow, scopeFitsRow, SENDER_TITLE_LINES, senderTitleVariant, suggestedRowOffset } from "../src/ui/sender-fit";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const page = src("../src/ui/SenderDetail.tsx");
const bar = page.slice(page.indexOf("function DecisionBar("), page.indexOf("function DecisionCapsule("));

describe("the decision panel at compact height (DECISION_PANEL_TALL)", () => {
  it("under 480 dp of height: one scrolling row, the scope at its end, no explainer", () => {
    expect(decisionPanelShape(heightClassOf(403), 403)).toEqual({ row: "scroll", scopeInRow: true, explainer: false, padTop: 8 });
    expect(decisionPanelShape(heightClassOf(479), 479).row).toBe("scroll");
    expect(decisionPanelShape(heightClassOf(480), 480).row, "past compact, a window under 740 dp still takes the row (L-16)").toBe("scroll");
    expect(decisionPanelShape(heightClassOf(905), 905)).toEqual({ row: "wrap", scopeInRow: false, explainer: true, padTop: 14 });
  });

  it("the panel stays under 40 % of the cover held sideways: one 44 dp row and its paddings", () => {
    // paddingTop 8, one capsule row (44), paddingBottom 12 and a gesture inset of up to 24 dp.
    const top = decisionPanelShape(heightClassOf(403), 403).padTop;
    expect(top + 44 + 12 + 24).toBeLessThanOrEqual(120);
    expect((top + 44 + 12 + 24) / 403).toBeLessThan(0.4);
  });

  it("the bar renders what the shape says: a horizontal scroller, the scope inside it, the sentence gated", () => {
    expect(bar).toContain("const shape = decisionPanelShape(usePosture().heightClass, useWindowDimensions().height);");
    const scroll = bar.slice(bar.indexOf('shape.row === "scroll" ? ('), bar.indexOf(") : (", bar.indexOf('shape.row === "scroll" ? (')));
    expect(scroll).toContain("<ScrollView");
    expect(scroll).toContain("horizontal");
    expect(scroll).toContain("{scopeInRow ? scopeControl : null}");
    expect(bar).toContain("{scopeInRow ? null : scopeControl}");
    expect(bar).toContain("const scopeInRow = scopeEndsRow(shape, scope, fit.row, fit.capsules, fit.scope);");
    // Also gated on `nobody`: while nothing organizes a mailbox the sentence would promise filing nothing does.
    expect(bar).toMatch(/\{shape\.explainer && !nobody \? \(\s*<Txt variant="hint"[^>]*>\s*\{ruleLine\}/);
  });

  it("the scope control ends the row only when the whole row fits; else its own row, never scrolled off", () => {
    // The cover held sideways: a ~905 dp row, five capsules ~640 dp, the control ~230 dp.
    expect(scopeFitsRow(905, 640, 230), "the measured cell: 28 + 640 + 8 + 230 = 906").toBe(false);
    expect(scopeFitsRow(906, 640, 230)).toBe(true);
    expect(scopeFitsRow(0, 640, 230), "unmeasured starts on its own row").toBe(false);
    expect(scopeFitsRow(905, 640, 0)).toBe(false);
    // A second row stays inside the ruled bound: 14 + 44 + 8 + 40 + 12 + a 24 dp inset.
    expect(14 + 44 + 8 + 40 + 12 + 24).toBeLessThanOrEqual(150);
    expect((14 + 44 + 8 + 40 + 12 + 24) / 403).toBeLessThan(0.4);
  });

  /* Phone landscape: the scope on a second row left one line of mail above the bar. The person's sender-only
     scope (the default) ends the scrolling row whatever its width; a whole-domain scope widens what a press
     files, so it ends the row only when the row fits, never scrolled off while in force. */
  it("at compact height the sender-only scope always ends the row; a whole-domain scope only when the row fits", () => {
    const compact = decisionPanelShape(heightClassOf(403), 403);
    expect(scopeEndsRow(compact, "sender", 905, 640, 230), "the measured cell, row overfull").toBe(true);
    expect(scopeEndsRow(compact, "sender", 0, 0, 0), "unmeasured").toBe(true);
    expect(scopeEndsRow(compact, "domain", 905, 640, 230)).toBe(false);
    expect(scopeEndsRow(compact, "domain", 906, 640, 230)).toBe(true);
    expect(scopeEndsRow(decisionPanelShape(heightClassOf(905), 905), "sender", 2000, 640, 230), "a tall window wraps").toBe(false);
  });

  it("the explainer the panel drops is still said, as every capsule's hint", () => {
    // While nothing organizes a mailbox the hint says so instead of promising a filing.
    expect(bar).toContain("hint={nobody ? Copy.screeningNoteNobody : ruleLine}");
    const capsule = page.slice(page.indexOf("function DecisionCapsule("));
    expect(capsule).toContain("accessibilityHint={hint}");
  });
});

/* L-16: on the iPhone SE (375 x 667) the wrapped bar stood three capsule rows, the scope and a
   three-line explainer tall, ~55 % of the screen, and left two lines of the held mail. */
describe("the decision panel on a short phone (L-16)", () => {
  const wrap = { row: "wrap", scopeInRow: false, explainer: true, padTop: 14 };
  const scroll = { row: "scroll", scopeInRow: true, explainer: false, padTop: 8 };
  it("under 740 dp of window height it is the one sideways row; the 812, 914 and 956 phones keep the wrap", () => {
    expect(decisionPanelShape(heightClassOf(667), 667), "iPhone SE").toEqual(scroll);
    expect(decisionPanelShape(heightClassOf(739), 739).row).toBe("scroll");
    expect(decisionPanelShape(heightClassOf(740), 740).row).toBe("wrap");
    expect(decisionPanelShape(heightClassOf(812), 812), "iPhone mini").toEqual(wrap);
    expect(decisionPanelShape(heightClassOf(914), 914), "Pixel 7").toEqual(wrap);
    expect(decisionPanelShape(heightClassOf(956), 956), "iPhone 17 Pro Max").toEqual(wrap);
    expect(decisionPanelShape("compact", 2000), "compact height decides alone").toEqual(scroll);
  });

  it("on the SE the bar is at most 20 % of the height, the person's scope at the row's end", () => {
    const se = decisionPanelShape(heightClassOf(667), 667);
    // The SE has no home indicator: paddingTop, one 44 dp capsule row, paddingBottom 12.
    expect((se.padTop + 44 + 12) / 667).toBeLessThanOrEqual(0.2);
    expect(scopeEndsRow(se, "sender", 375, 640, 230), "sender-only ends the overfull row").toBe(true);
    // A whole-domain scope in force that does not fit takes a second 40 dp row, still within the bound.
    expect(scopeEndsRow(se, "domain", 375, 640, 230)).toBe(false);
    expect((se.padTop + 44 + 8 + 40 + 12) / 667).toBeLessThanOrEqual(0.2);
  });
});

describe("the scrolling row opens on the suggestion", () => {
  it("scrolls just far enough for the suggested capsule and the row's padding, never past its left edge", () => {
    expect(suggestedRowOffset(375, 520, 120), "Spam at the strip's end").toBe(14 + 520 + 120 + 14 - 375);
    expect(suggestedRowOffset(375, 0, 110), "already whole").toBe(0);
    expect(suggestedRowOffset(375, 200, 147), "ends exactly at the padding").toBe(0);
    expect(suggestedRowOffset(375, 300, 400), "wider than the row: its start stays on screen").toBe(300);
    expect(suggestedRowOffset(0, 520, 120), "unmeasured row").toBe(0);
    expect(suggestedRowOffset(375, 520, 0), "unmeasured capsule").toBe(0);
  });
});

describe("the sender's name on the pane it is given", () => {
  it("the reader's title role at a pane of 480 dp or more, the view title below or unmeasured", () => {
    expect(senderTitleVariant(480)).toBe("readerTitle");
    expect(senderTitleVariant(821)).toBe("readerTitle");
    expect(senderTitleVariant(479)).toBe("h1");
    expect(senderTitleVariant(null)).toBe("h1");
    expect(type.readerTitle.fontSize, "the wide role moved off the ruling's ~28").toBeGreaterThanOrEqual(28);
    expect(type.h1.fontSize).toBe(22);
  });
  it("the title reads the measured header width and stops at three lines", () => {
    expect(SENDER_TITLE_LINES).toBe(3);
    expect(page).toContain("<Txt variant={senderTitleVariant(paneWidth)} numberOfLines={SENDER_TITLE_LINES}>");
    expect(page).toContain("onLayout={(e) => setPaneWidth(Math.round(e.nativeEvent.layout.width))}");
  });
});
