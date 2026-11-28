import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { SHEET_TOP_ROOM, sheetPanelBounds } from "../src/ui/sheet-bounds";

/**
 * A SHEET FITS THE WINDOW AND SCROLLS INSIDE IT (MOBILE-SHEET-PANEL-IS-BOUNDED-IN-POSE-UNITS, ruling
 * 159: the modal belongs to the whole window). The panel was bounded only beside a horizontal
 * hinge, so a sheet of more verbs than the window holds put its last verbs and its Cancel below the
 * screen. Every posture is bounded now, the rows scroll, and the way out stays outside the scroller.
 */
const ROW_PT = 48;

describe("the panel's bound", () => {
  it("twelve rows in a 600 pt window: the panel stops at the window, Cancel stays on screen", () => {
    const b = sheetPanelBounds(400, 600, 24, null, null);
    expect(b.maxHeight).toBe(576);
    const rows = 12 * ROW_PT + ROW_PT;
    expect(rows, "the case needs more rows than the window holds").toBeGreaterThan(576);
  });
  it("every posture is bounded by the window", () => {
    expect(sheetPanelBounds(1800, 1100, 30, null, { x: 880, y: 0, w: 40, h: 1100 }).maxHeight).toBe(1070);
    expect(sheetPanelBounds(1100, 1800, 30, null, { x: 0, y: 880, w: 1100, h: 40 }).maxHeight).toBe(880);
    expect(sheetPanelBounds(400, 300, 30, null, { x: 0, y: 200, w: 400, h: 40 }).maxHeight, "the hinge floor never passes the window").toBe(270);
  });
});

/* ON TWO PANES THE PANEL IS A CARD IN THE PANE (iPad, the Fold landscape): it ran to the window's foot,
   past the pane's own, with square bottom corners. It ends a gutter above the foot, rounded all round. */
describe("a pane-anchored panel ends at the pane's foot", () => {
  const PANE = { x: 420, w: 740 };
  const FOOT = { gutter: 16, radius: 22 };
  it("a gutter under it, four round corners, the gutter paid out of its height", () => {
    const b = sheetPanelBounds(1180, 820, 24, PANE, null, FOOT);
    expect(b.marginBottom).toBe(16);
    expect(b.borderBottomLeftRadius).toBe(22);
    expect(b.borderBottomRightRadius).toBe(22);
    expect(b.maxHeight).toBe(820 - 24 - SHEET_TOP_ROOM - 16);
    expect(b.marginLeft).toBe(420);
    expect(b.width).toBe(740);
  });
  it("CONTROL: one pane keeps the thumb sheet on the window's foot", () => {
    const b = sheetPanelBounds(390, 844, 47, null, null, FOOT);
    expect(b.marginBottom).toBeUndefined();
    expect(b.borderBottomLeftRadius).toBeUndefined();
  });
});

describe("the sheet scrolls and its way out does not", () => {
  const SHEET = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/Sheet.tsx", import.meta.url)), "utf8"));
  it("the rows are in a ScrollView, and the CancelRow comes after it, outside", () => {
    const open = SHEET.indexOf("<ScrollView");
    const close = SHEET.indexOf("</ScrollView>");
    const cancel = SHEET.indexOf("<CancelRow onPress={onClose} />");
    expect(open, "the panel does not scroll").toBeGreaterThan(-1);
    expect(SHEET.slice(open, close)).toContain("{children}");
    expect(cancel, "Cancel scrolls away with the rows").toBeGreaterThan(close);
  });
});

/* A LIST INSIDE A SHEET STILL SCROLLS once the sheet scrolls (REVIEW-026-PHONE-SAYS-EVERY-PRESS-2 L4):
   on Android a same-direction inner ScrollView needs `nestedScrollEnabled`, or the outer takes the
   gesture. Measured on the AVD at a 900 px window: the time list stopped at its first screen. */
function scrollViews(source: string) {
  const file = ts.createSourceFile("sheet.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const opens: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === "ScrollView") {
      opens.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return opens;
}

function nestedScrollEnabled(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  const attr = node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText() === "nestedScrollEnabled");
  return attr !== undefined && (attr.initializer === undefined ||
    (ts.isJsxExpression(attr.initializer) && attr.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword));
}

describe("the scrollers inside the reader's sheets", () => {
  const ACTIONS = readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8");
  it("every ScrollView in the sheets passes nestedScrollEnabled", () => {
    const control = scrollViews(`<>\n      <ScrollView ref={ref as Ref<ScrollView>} nestedScrollEnabled />\n      <ScrollView accessibilityLabel="nestedScrollEnabled" />\n      <ScrollView nestedScrollEnabled={false} />\n    </>`);
    expect(control.map(nestedScrollEnabled)).toEqual([true, false, false]);
    const opens = scrollViews(ACTIONS);
    expect(opens.length, "the sheets' scrollers moved; this census reads nothing").toBeGreaterThanOrEqual(5);
    expect(opens.filter((node) => !nestedScrollEnabled(node)).map((node) => node.getText()),
      "an inner list that stops scrolling on Android").toEqual([]);
  });
});
