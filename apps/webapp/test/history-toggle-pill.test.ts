import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE HISTORY CHIP IS A PILL, NEVER A BAR — and the flip stays a footnote.
 *
 * `.msg-history-toggle` (BodyText's fold handle) is `display:inline-flex`, which is content-width
 * in a block container — and FULL-WIDTH in `.mb`, because `.mb` (message-body.css) is a stretch
 * flex column and a flex item's outer display is blockified. That is exactly where the rich prose
 * path renders it, so the chip shipped as a bar spanning the whole letter. The rule now pins the
 * width from the item's own side (`align-self:flex-start` for flex parents, `width:fit-content`
 * for everything else) and wears the viewer prototype's pill: an inset hairline ring, a "···"
 * glyph drawn by `::before` (a pseudo — the button's text stays exactly its label, which the
 * BodyText tests assert byte-for-byte), the quietest ink until hovered.
 *
 * `.mb-flip` ("Show original") is the surface's escape hatch, rarely pressed: it must stay a bare
 * text control sized to its label, never grow back into a filled button, and never stretch. Its
 * class, element and `aria-pressed` are a located contract (the UX suite's mail lab and
 * the prose tests), guarded functionally there — this file guards only the visual register.
 *
 * The theme half: every token these two rules read must be defined for BOTH themes in
 * tokens.css, or one theme renders the chip with unset colors.
 *
 * Paths are cwd-relative like list-title-size.test.ts: the suite runs from the repo root.
 *
 * MUTATION WATCH (each applied, watched go red, reverted):
 *   · `align-self:flex-start` and `width:fit-content` removed, `width:100%` added → the
 *     content-width case, both halves.
 *   · the `::before` rule deleted → the dots case.
 *   · `box-shadow` ring swapped back to `border:1px solid var(--hair)` → the ring case.
 *   · `.mb-flip` given `background:var(--panel)` → the bare-control case.
 *   · `--hair-soft` deleted from tokens.css's dark block → the both-themes case.
 */

/** Comments stripped first — a commented-out declaration is not a declaration. */
const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const MESSAGE_CSS = bare("packages/ui/src/composites/message.css");
const BODY_CSS = bare("apps/webapp/app/letter-body/message-body.css");
const TOKENS_CSS = readFileSync(
  resolve(process.cwd(), "packages/tokens/src/tokens.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
const FACES_CSS = readFileSync(
  resolve(process.cwd(), "packages/tokens/src/faces.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the one rule whose selector list contains exactly `sel` as a full selector. */
const ruleBody = (css: string, sel: string): string | null => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) return m[2];
  }
  return null;
};

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
};

describe("the show-history chip is a content-width pill", () => {
  const body = ruleBody(MESSAGE_CSS, ".msg-history-toggle");

  /* Anchor: the selector moving sheets must go red here, not pass vacuously on a null scan. */
  it("the rule exists in the shared message composite", () => {
    expect(body, "`.msg-history-toggle` no longer has a base rule in message.css").not.toBeNull();
  });

  it("content-width from the item's own side — inline-flex alone stretches inside `.mb`", () => {
    expect(decl(body!, "display")).toBe("inline-flex");
    // The flex half: `.mb` is a stretch column, and without this the chip is a full-width bar.
    expect(decl(body!, "align-self"), "the chip stretches full-width inside `.mb`")
      .toBe("flex-start");
    // The everything-else half, and the guard's teeth against a rewrite: never full width, never block.
    expect(decl(body!, "width"), "the chip must size to its content, nothing else")
      .toBe("fit-content");
  });

  it("wears the prototype's pill: ring, radius, quiet ink, hover fill", () => {
    expect(decl(body!, "border-radius")).toBe("var(--r-pill)");
    // A ring, not a border and not a fill — a letter that ends in a chip still ends in air.
    expect(decl(body!, "box-shadow")).toBe("inset 0 0 0 1px var(--hair-soft)");
    expect(decl(body!, "border")).toBe("0");
    expect(decl(body!, "background")).toBe("none");
    expect(decl(body!, "color")).toBe("var(--ink3)");
    const hover = ruleBody(MESSAGE_CSS, ".msg-history-toggle:hover");
    expect(hover, "the chip lost its hover state").not.toBeNull();
    expect(decl(hover!, "background")).toBe("var(--tint)");
    expect(decl(hover!, "color")).toBe("var(--ink)");
  });

  it("the ··· glyph is a pseudo-element, so the button's text stays exactly its label", () => {
    const dots = ruleBody(MESSAGE_CSS, ".msg-history-toggle::before");
    expect(dots, "the chip lost its ··· glyph").not.toBeNull();
    expect(decl(dots!, "content"), "the glyph is not the prototype's three dots")
      .toContain('"···"');
    // In the DOM it would join textContent ("···Show history") and break the label contract
    // body-text.test.ts asserts byte-for-byte. The pseudo is the mechanism, so it is the claim.
    expect(dots!).not.toContain("attr(");
  });
});

describe("the show-original flip stays a bare footnote control", () => {
  const body = ruleBody(BODY_CSS, ".mb-flip");

  it("the rule exists in the message-body stylesheet", () => {
    expect(body, "`.mb-flip` no longer has a base rule in message-body.css").not.toBeNull();
  });

  it("sized to its text and tucked to the trailing edge — never a stretched or filled button", () => {
    expect(decl(body!, "align-self"), "the flip stretches full-width inside `.mb`")
      .toBe("flex-end");
    expect(decl(body!, "background"), "the flip grew a fill — it must stay bare text")
      .toBe("none");
    expect(decl(body!, "border")).toBe("0");
    expect(decl(body!, "color")).toBe("var(--ink3)");
    /* Smaller than every reading size on the surface — 12px is the bar's own size; this sits under
       it, and the RELATION is what matters rather than the number. Both carry the phone step, so
       the gap of one pixel holds at either width; re-baselined to the slot spelling rather than
       loosened to a substring, so a declaration that lost the step still fails here. */
    expect(decl(body!, "font-size")).toBe("calc(11px + var(--type-up))");
  });
});

describe("every token the two controls read resolves in both themes", () => {
  /**
   * tokens.css declares three scopes: `:root,[data-theme="light"]` (light), `[data-theme="dark"]`
   * (the explicit toggle) and the `prefers-color-scheme: dark` mirror. A token a control reads
   * must be declared in the light scope AND in the explicit dark scope, or one theme paints the
   * chip with an unset custom property — which computes to nothing, silently.
   */
  const scopeBody = (selector: RegExp): string => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(TOKENS_CSS); m; m = re.exec(TOKENS_CSS)) {
      if (selector.test(m[1].replace(/\s+/g, " ").trim())) return m[2];
    }
    return "";
  };
  const light = scopeBody(/^:root\s*,\s*\[data-theme="light"\]$/);
  const dark = scopeBody(/^\[data-theme="dark"\]$/);
  /* The NEW slots (faces.css) are FACE-INVARIANT geometry/type declared once on `:root` and
     cascading into every scheme — `--swift`'s cascades-once argument, one file over. A paint
     token still may not live there for this test's purposes: paint varies by scheme, and
     faces.css's own purity test keeps paint out of it. */
  const facesRoot = ((): string => {
    const m = /:root\s*\{([^{}]*)\}/.exec(FACES_CSS);
    return m ? m[1] : "";
  })();

  it("both theme scopes are found at all", () => {
    expect(light, "the light scope is gone from tokens.css").not.toBe("");
    expect(dark, "the dark scope is gone from tokens.css").not.toBe("");
  });

  it("each token referenced by the chip and the flip is declared in light AND dark", () => {
    const rules = [
      ruleBody(MESSAGE_CSS, ".msg-history-toggle"),
      ruleBody(MESSAGE_CSS, ".msg-history-toggle:hover"),
      ruleBody(BODY_CSS, ".mb-flip"),
      ruleBody(BODY_CSS, ".mb-flip:hover, .mb-flip:focus-visible") ??
        ruleBody(BODY_CSS, ".mb-flip:hover"),
    ].join(";");
    const used = [...new Set([...rules.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
    expect(used.length, "the scan found no tokens at all — the extraction matched nothing")
      .toBeGreaterThan(0);
    for (const token of used) {
      const lightValue = decl(light, token) ?? decl(facesRoot, token);
      expect(lightValue, `${token} is not defined in the base/light scope (tokens.css) ` +
        "or the face-invariant root (faces.css)").not.toBeNull();
      // Only PAINT varies by theme. A motion token (`--swift` is a cubic-bezier) is declared
      // once on `:root` and cascades into dark — demanding it twice would pin an invention.
      const paints = /oklch\(|#[0-9a-f]{3}|rgb\(|color-mix\(/i.test(lightValue!);
      if (paints) {
        expect(dark, `${token} paints, but is not re-declared for the dark theme`)
          .toMatch(`${token}:`);
      }
    }
  });
});

describe("the long body's Show more is the same pill at the phone tier", () => {
  /* The pager wears the history chip's pill (one selector list in message.css), so it takes the
     same 44px touch height under 640px. Read off the phone block itself, so a rule that drops
     the pager from that block goes red here. */
  it("the 640px block gives .msg-page-more the chip's 44px min-height", () => {
    const at = MESSAGE_CSS.indexOf("@media (max-width: 640px){");
    expect(at, "message.css lost its 640px block").toBeGreaterThan(-1);
    const block = MESSAGE_CSS.slice(at, MESSAGE_CSS.indexOf("\n}", at));
    expect(block).toMatch(/\.msg-history-toggle,\.msg-page-more\{min-height:44px\}/);
  });
});
