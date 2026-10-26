/**
 * THE PAPER BYTE-STABILITY PIN (OHMARCHY-PLAN.md §3a: "paper = today's values EXACTLY").
 *
 * Paper is the ABSENT state of `data-face`, so the whole proof reduces to two structural
 * facts about the files this slice adds beside tokens.css:
 *
 *  1. `src/ohmarchy.css` can never match a paper document — every selector in it requires
 *     `[data-face="ohmarchy"]`. A paper page therefore computes exactly what it computed
 *     before the file existed.
 *  2. `src/faces.css` declares at `:root` ONLY the new slot names, never an existing
 *     tokens.css slot — so nothing a paper component already reads changes value — and each
 *     new slot's paper value equals the spec's paper column, which equals the literal the
 *     component carried before it was rewritten to read the slot.
 *
 * Plus the named deviation: `--danger` / `--focus` / `--accent-wash` must NOT be declared
 * under paper (the app's `var(…, fallback)` call sites carry unequal fallbacks — #b3261e vs
 * #c0392b for danger, var(--ink2) for focus — so a paper-level definition would visibly
 * change the paper face; see faces.css's header and the lane-C note in the project's design notes).
 *
 * Mutation-proven at authoring time: adding `--accent: red` to faces.css's :root went red on
 * the only-new-slots assertion; adding a bare `:root{...}` rule to ohmarchy.css went red on
 * the scoping assertion; changing `--r-ctl` to 9px went red against the spec column.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const facesCss = readFileSync(here("../src/faces.css"), "utf8");
const ohmarchyCss = readFileSync(here("../src/ohmarchy.css"), "utf8");
const tokensCss = readFileSync(here("../src/tokens.css"), "utf8");
const spec = JSON.parse(
  readFileSync(here("../spec/ohmarchy.tokens.json"), "utf8"),
) as {
  slots: { new_slots: Record<string, { paper: string }> };
};

/** Every selector (the text before each top-level `{`), media preludes skipped. */
function selectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of clean) {
    if (ch === "{") {
      const sel = buf.trim();
      if (sel && !sel.startsWith("@")) out.push(sel);
      depth++;
      buf = "";
    } else if (ch === "}") {
      depth--;
      buf = "";
    } else buf += ch;
  }
  return out;
}

function declaredProps(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
}

/** The slots this slice adds; everything else at :root belongs to tokens.css. */
const NEW_SLOTS = [
  "--r-ctl", "--r-card", "--r-overlay", "--r-pill", "--r-avatar",
  "--teach", "--focus-w", "--focus-offset", "--gap-tile", "--gap-edge", "--gap-rail",
  "--font-ui", "--font-size-base",
  "--type-up", "--input-floor",
];

describe("ohmarchy.css cannot touch a paper document", () => {
  it("every selector requires [data-face=\"ohmarchy\"]", () => {
    const sels = selectors(ohmarchyCss);
    expect(sels.length).toBeGreaterThan(0);
    for (const sel of sels) {
      // Every comma-separated alternative must carry the face guard.
      for (const alt of sel.split(",")) {
        expect(alt, `unguarded selector in ohmarchy.css: "${alt.trim()}"`).toContain(
          '[data-face="ohmarchy"]',
        );
      }
    }
  });
});

describe("faces.css declares only the new slots, at their spec paper values", () => {
  it("declares exactly the new-slot set", () => {
    expect(declaredProps(facesCss).sort()).toEqual([...NEW_SLOTS].sort());
  });
  it("each value equals the spec's paper column", () => {
    const clean = facesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const slot of NEW_SLOTS) {
      const m = clean.match(new RegExp(`${slot}\\s*:\\s*([^;}]+)`));
      expect(m, `${slot} missing from faces.css`).toBeTruthy();
      const got = m![1].replace(/\s+/g, " ").trim();
      const want = spec.slots.new_slots[slot].paper.replace(/\s+/g, " ").trim();
      expect(got, slot).toBe(want);
    }
  });
  it("the three fallback-read slots stay undeclared under paper (named deviation)", () => {
    for (const slot of ["--danger", "--focus", "--accent-wash"]) {
      expect(declaredProps(facesCss), `${slot} must not be paper-defined`).not.toContain(slot);
    }
  });
  it("re-declares no tokens.css slot", () => {
    const existing = new Set(declaredProps(tokensCss));
    for (const p of declaredProps(facesCss)) {
      expect(existing.has(p), `${p} already belongs to tokens.css`).toBe(false);
    }
  });
});
