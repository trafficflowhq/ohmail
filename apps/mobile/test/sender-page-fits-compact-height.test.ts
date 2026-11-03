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
import { decisionPanelShape, scopeFitsRow, SENDER_TITLE_LINES, senderTitleVariant } from "../src/ui/sender-fit";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const page = src("../src/ui/SenderDetail.tsx");
const bar = page.slice(page.indexOf("function DecisionBar("), page.indexOf("function DecisionCapsule("));

describe("the decision panel at compact height (DECISION_PANEL_TALL)", () => {
  it("under 480 dp of height: one scrolling row, the scope at its end, no explainer", () => {
    expect(decisionPanelShape(heightClassOf(403))).toEqual({ row: "scroll", scopeInRow: true, explainer: false });
    expect(decisionPanelShape(heightClassOf(479)).row).toBe("scroll");
    expect(decisionPanelShape(heightClassOf(480))).toEqual({ row: "wrap", scopeInRow: false, explainer: true });
    expect(decisionPanelShape(heightClassOf(905))).toEqual({ row: "wrap", scopeInRow: false, explainer: true });
  });

  it("the panel stays under 40 % of the cover held sideways: one 44 dp row and its paddings", () => {
    // paddingTop 14, one capsule row (44), paddingBottom 12 and a gesture inset of up to 24 dp.
    expect(14 + 44 + 12 + 24).toBeLessThanOrEqual(120);
    expect((14 + 44 + 12 + 24) / 403).toBeLessThan(0.4);
  });

  it("the bar renders what the shape says: a horizontal scroller, the scope inside it, the sentence gated", () => {
    expect(bar).toContain("const shape = decisionPanelShape(usePosture().heightClass);");
    const scroll = bar.slice(bar.indexOf('shape.row === "scroll" ? ('), bar.indexOf(") : (", bar.indexOf('shape.row === "scroll" ? (')));
    expect(scroll).toContain("<ScrollView");
    expect(scroll).toContain("horizontal");
    expect(scroll).toContain("{scopeInRow ? scopeControl : null}");
    expect(bar).toContain("{scopeInRow ? null : scopeControl}");
    expect(bar).toContain("const scopeInRow = shape.scopeInRow && scopeFitsRow(fit.row, fit.capsules, fit.scope);");
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

  it("the explainer the panel drops is still said, as every capsule's hint", () => {
    // While nothing organizes a mailbox the hint says so instead of promising a filing.
    expect(bar).toContain("hint={nobody ? Copy.screeningNoteNobody : ruleLine}");
    const capsule = page.slice(page.indexOf("function DecisionCapsule("));
    expect(capsule).toContain("accessibilityHint={hint}");
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
