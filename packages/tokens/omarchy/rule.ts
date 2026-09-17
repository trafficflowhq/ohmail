/**
 * THE ONE WRITER OF THE LIVE THEME'S SELECTOR FORMS, and the fence that decides which pairs
 * reach a stylesheet at all.
 *
 * Two callers write this rule: the desktop window's theme feed (`apps/desktop/src/omarchy.ts`,
 * over a LIVE theme) and the landing demo's theme explorer (`DemoSection.tsx`, over the
 * committed fixture set). They were two spellings of one rule and the demo's lacked the scheme
 * axis, so a dark theme picked on a light page rendered dark. One writer, and the axis is a
 * property of the rule rather than of whoever remembered it.
 *
 * Pure text and no imports: the desktop's pre-paint block is a BLOCKING script, and everything
 * it reaches is paint-blocking with it.
 */

/** The appearance attribute the live rule is scoped under; the face machinery stamps it. */
export const OMARCHY_FACE_ATTRIBUTE = "data-face";
export const OMARCHY_FACE_VALUE = "ohmarchy";

/** A token name: a custom property, or the one standard property the mapping emits. */
const TOKEN_NAME = /^(--[a-z0-9-]{1,64}|color-scheme)$/;
/** Characters that could restructure a stylesheet - close the block, open a rule, start
 *  an at-rule, escape, open a comment, or leave a bracket hanging - banned from values
 *  wholesale, control characters included. `/` goes as a CHARACTER because no real token
 *  value carries one and an embedded comment-opener would swallow every later declaration
 *  in the rule; square brackets likewise. */
// eslint-disable-next-line no-control-regex
const VALUE_BANNED = /[{}<>;@\\/[\]\x00-\x1f\x7f]/;
const VALUE_MAX = 512;
const TOKENS_MAX = 200;

/** Parens must pair and nest: CSS error recovery inside an unmatched opening paren ignores
 *  semicolons, so a value ending rgba( would eat the rest of the rule - the whole theme,
 *  not one slot. Parens are not simply banned because they are real: the tag washes are
 *  rgba(...) values. */
function parensBalanced(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** The fence: names to the token grammar, values free of structural characters, the set
 *  bounded. Dropping is correct - the mapping's real outputs never trip this, so anything
 *  that does was never a token value. */
export function fencedTokens(tokens: Record<string, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (out.length >= TOKENS_MAX) break;
    if (!TOKEN_NAME.test(name)) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > VALUE_MAX) continue;
    if (VALUE_BANNED.test(value) || !parensBalanced(value)) continue;
    out.push([name, value]);
  }
  return out;
}

/** The face, as every form below starts. `:root` because the feed writes on <html> alone. */
const FACE = `:root[${OMARCHY_FACE_ATTRIBUTE}="${OMARCHY_FACE_VALUE}"]`;
/**
 * The scheme forms, `packages/tokens/src/ohmarchy.css`'s own. The no-explicit-theme form is
 * written with the two `:not()`s rather than `:not([data-theme])` so it matches the static
 * stylesheet's arity and import order keeps deciding exactly as it did before this axis
 * existed. The DESCENDANT form is what lets a subtree be forced light inside a dark page (the
 * dark reader's per-message light rendering) - dropping it would leave those subtrees on the
 * static palette.
 */
const AUTO_FORM = `${FACE}:not([data-theme="light"]):not([data-theme="dark"])`;
const schemeForms = (scheme: "light" | "dark"): string =>
  `${FACE}[data-theme="${scheme}"],\n${FACE} [data-theme="${scheme}"]`;

const OTHER: Record<"light" | "dark", "light" | "dark"> = { light: "dark", dark: "light" };

/** One block: the fenced set as `!important` declarations under the given selector list. */
function block(selector: string, tokens: Record<string, string>): string {
  /* `!important` per declaration - a cascade decision, not emphasis: the static
     follow-the-system dark block's selector has specificity (0,3,0) and outranks this rule's
     (0,2,0), so on a dark desktop the static values would silently win. A live theme is by
     design the top of the token cascade, and no token stylesheet declares importance itself. */
  const lines = fencedTokens(tokens).map(([name, value]) => `  ${name}: ${value} !important;`);
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/**
 * The rule text for one theme: its own scheme under the no-explicit-theme form and under its
 * own `[data-theme]` pair, and the counterpart under the other pair. A null counterpart emits
 * nothing for the other scheme and the static face block for it stands - which is readable and
 * on-brand, and is the law's own answer for a scheme it could not derive within the floors.
 */
export function omarchyRuleText(
  native: Record<string, string>,
  mode: "light" | "dark",
  counterpart: Record<string, string> | null,
): string {
  const blocks = [block(AUTO_FORM, native), block(schemeForms(mode), native)];
  if (counterpart !== null) blocks.push(block(schemeForms(OTHER[mode]), counterpart));
  return blocks.join("\n");
}
