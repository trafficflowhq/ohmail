import { describe, expect, it } from "vitest";
import { buildMailDocument } from "../app/components/MessageBody";

/**
 * ── THE LINK'S HOST, SHOWN WITHOUT MOVING THE LETTER ─────────────────────────────────────
 *
 * Hovering a link in a framed letter shows where it goes. That hint used to be drawn IN the
 * line, so it widened the link: in a newsletter whose links are buttons in a row, every button
 * after the hovered one moved sideways under the pointer. The hint now floats under the link.
 *
 * jsdom performs no layout, so this file pins what the frame's stylesheet SAYS: the hover and
 * focus hint is taken out of flow, and a marked link keeps the label it shows at rest.
 */

/** Every rule of the frame's stylesheet whose selector names the hover hint, with its body. */
function hoverHintRules(doc: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  const re = /([^{}]*?):hover::after[^{}]*\{([^}]*)\}/g;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    rules.push({ selector: m[0].slice(0, m[0].indexOf("{")), body: m[2] });
  }
  return rules.filter((r) => r.selector.includes("data-ohmail-host"));
}

describe("the hover hint naming a link's host", () => {
  it("is taken out of flow, so hovering a link moves nothing beside it", () => {
    // Mutation: drop `position:absolute` from the hint → RED (the hint is in the line again).
    const rules = hoverHintRules(buildMailDocument("<p>x</p>"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.body).toMatch(/(^|;)\s*position:\s*absolute/);
      expect(rule.body).toMatch(/pointer-events:\s*none/);
    }
  });

  it("anchors on the link at zero specificity, so a sender's own position on an anchor wins", () => {
    // Mutation: `a[data-ohmail-host]{position:relative}` without :where() → RED.
    const doc = buildMailDocument("<p>x</p>");
    expect(doc).toContain(":where(a[data-ohmail-host]){position:relative}");
    expect(doc).not.toMatch(/(^|[\s}])a\[data-ohmail-host\]\s*\{[^}]*position:\s*relative/);
  });

  it("leaves a marked link's label alone on hover", () => {
    // Mutation: drop the :not([data-ohmail-elsewhere]) guard → RED (the hover rule would out-rank
    // the marked label and swap it for a floating chip while hovered).
    for (const rule of hoverHintRules(buildMailDocument("<p>x</p>"))) {
      expect(rule.selector).toContain(":not([data-ohmail-elsewhere])");
    }
  });
});
