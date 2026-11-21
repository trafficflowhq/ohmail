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
 * The revoke dialog now draws the kit's settings note. Its full rule text still has to
 * wrap when the viewport leaves a narrow text column.
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const NOTE_CSS = bare("packages/ui/src/mail/Settings/setting-note.css");

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
    const block = blockOf(NOTE_CSS, ".oh-settingnote {");
    expect(block, "the settings note styling is gone").toBeTruthy();
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
 * The AI key uses the shared field stack. The action has a row of its own, so a long
 * translated action label cannot narrow the password input.
 */
describe("SET-H1/M5 — the key field keeps a floor at every width", () => {
  it("the field stack keeps the key input wide and puts the action on its own row", () => {
    const form = bare("apps/desktop/src/AiProviderForm.tsx");
    expect(form).toMatch(/<FieldStack>\s*<Field\s+id="ai-key"[\s\S]+?\/>\s*<SettingActs>\s*<Button[^>]+type="submit"/);
    const base = "packages/ui/src/base/Primitives";
    const stack = blockOf(bare(`${base}/field-stack.css`), ".oh-fieldstack") ?? "";
    expect(stack).toMatch(/display:\s*grid/);
    expect(stack).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(stack).toMatch(/max-width:\s*var\(--oh-fieldstack-max\)/);
    const max = /--oh-fieldstack-max:\s*(\d+)px/.exec(stack);
    expect(Number(max?.[1]), "the field stack is too narrow to read a pasted key in").toBeGreaterThanOrEqual(200);
    const field = blockOf(bare(`${base}/field.css`), ".oh-field-input") ?? "";
    expect(field).toMatch(/width:\s*100%/);
  });
});
