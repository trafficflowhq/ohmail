import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SETTINGS AT 390 — THE RULES PANE MAY NOT SET THE SHEET'S WIDTH.
 *
 * ── THE DEFECT, MEASURED ────────────────────────────────────────────────────────────────
 *
 * At 390×844 the whole settings sheet panned horizontally to 604px the moment the Rules pane
 * held real rules: Change/Revoke, the filter pills and "Revoke all N" sat off-canvas with no
 * affordance, and the section nav stretched with the sheet so the active "Rules" pill was
 * itself off-screen. Every other pane reflowed fine.
 *
 * The mechanism (bisected in a live browser against the production demo, 2026-08-12, by
 * toggling one candidate rule at a time):
 *
 *   `.rules-item .what` / `.meta` are `white-space: nowrap`, so a rule row's MIN-CONTENT
 *   width is the width of its longest unwrappable sentence. That intrinsic width propagates
 *   up through the list into the `.set-pane`, and the pane is a GRID ITEM of `.set-layout`,
 *   whose `1fr` track means `minmax(auto, 1fr)` — and the `auto` minimum of a grid item with
 *   `min-width: auto` is its min-content size. So one long rule address widened the TRACK,
 *   the track widened the nav sitting in it, and the sheet panned. `min-width: 0` anywhere
 *   INSIDE the pane changes nothing (measured: pane stayed 527px); it has to be on the grid
 *   items themselves, which is the rule this file pins.
 *
 * With the grid minimum released, everything inside already behaves: `.rules-item .body` has
 * `min-width: 0` and ellipsizes, the toolbar wraps, and the buttons stay on-canvas.
 * Re-measured with the rule applied: document scrollWidth 390 at 390, rows/pills/nav all
 * inside the viewport, both themes.
 *
 * MUTATION WATCH: restoring `white-space: nowrap` on `.rules-confirm .what` turns the
 * confirm's case red. (Today's settings grid's `.set-layout > *` case left with today's
 * Settings view; the kit's setting line holds its own.)
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const RULES_CSS = bare("apps/webapp/app/views/rules.css");

/** The declarations of the first `selector { … }` block in `css`, or null. */
function blockOf(css: string, selector: string): string | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

describe("SET-H1/M4 — the confirm is the one place a rule is read in full", () => {
  it("rules.css lets .rules-confirm .what wrap instead of ellipsizing", () => {
    const block = blockOf(RULES_CSS, ".rules-confirm .what");
    expect(block, ".rules-confirm .what styling is gone").toBeTruthy();
    // The row may ellipsize — it is a scannable list. The CONFIRM is where somebody checks a
    // rule character by character before acting on it, so the sentence must be whole at every
    // width, including the 140px-wide text column a 390 viewport leaves.
    expect(block!).not.toContain("nowrap");
    expect(block!.replace(/\s/g, "")).toContain("overflow-wrap:anywhere");
  });
});

/**
 * SET-H1/M5 — A FIELD'S VERB DROPS TO ITS OWN LINE RATHER THAN CRUSHING THE FIELD.
 *
 * ── THE DEFECT, MEASURED ────────────────────────────────────────────────────────────────
 *
 * `.set-field-row` is a field with its verb beside it — the AI key and its "Save key and test".
 * It was `display:flex` with `flex:1 1 auto` on the field and `flex:none` on the button, which
 * gives the field no floor at all: at the narrow width the row is 290px and the German label
 * ("Gespeicherten Schlüssel testen") is 255px of it, so the key input rendered about 40px wide
 * — a password field too narrow to show that anything had been pasted into it. Measured in
 * Chromium at 390/760/1440 × en/de against the real pane.
 *
 * The fix is a FLEX BASIS, not a media query: 200px is the floor at which the field would
 * rather wrap the button than shrink further. Re-measured with it applied — 390: field 290px
 * with the button on its own line, both languages; 760 and 1440: both on one line, field
 * 259-479px. No width is special-cased, so a third language is handled by the same rule.
 *
 * MUTATION WATCH: restore `flex: 1 1 auto` (or drop `flex-wrap`) and this goes red.
 */
describe("SET-H1/M5 — the key field keeps a floor at every width", () => {
  it("settings.css gives .set-field-row's field a basis and lets the row wrap", () => {
    const form = bare("apps/desktop/src/AiProviderForm.tsx");
    expect(form).toMatch(/<div className="set-field-row">\s*<input\s+id="ai-key"/);
    const css = bare("packages/ui/src/composites/settings.css");
    const row = blockOf(css, ".set-field-row{");
    expect(row, "no `.set-field-row` rule — a field with a verb beside it has no layout").toBeTruthy();
    expect(
      row!.replace(/\s/g, ""),
      "the row cannot wrap, so the verb can only take its width out of the field",
    ).toContain("flex-wrap:wrap");

    const field = blockOf(css, ".set-field-row > :first-child");
    expect(field, "no rule sizing the field inside .set-field-row").toBeTruthy();
    const flex = /flex:\s*1\s+1\s+(\d+)px/.exec(field!);
    expect(
      flex,
      "the field has no flex BASIS, so a long button label shrinks it without limit — " +
        `got \`${field!.trim()}\``,
    ).toBeTruthy();
    expect(Number(flex![1]), "the field's floor is too small to read a pasted key in").toBeGreaterThanOrEqual(200);
  });
});
