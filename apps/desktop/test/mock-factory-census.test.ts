import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ═══ A RIG'S MOCK OF A MODULE CANNOT HALF-APPLY ════════════════════════════════════════════
 *
 * `vi.mock(spec, factory)` REPLACES a module: whatever the factory does not return is
 * `undefined`, not the real thing. Five rigs here mocked `../src/bridge-fetch.js` — a module with
 * nine value exports — and four of them listed the two or three they drive by name. Two of those
 * rigs carry a comment saying what that costs ("a partial mock would leave this export
 * `undefined`, which fails as a TypeError rather than as the assertion under test"), which is the
 * hazard stated and then re-entered by hand in the next rig.
 *
 * The failure is not the rig's own: it lands on whoever next makes a pane read `engineStatus`, in
 * a file they did not touch, as a TypeError three frames inside a component. Spreading
 * `vi.importActual` cannot do that — a new export is simply present, and the rig keeps overriding
 * exactly what it means to.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS A PARSE ────────────────────────────────────────────────
 *
 * Every `vi.mock` CALL in this directory that supplies a factory must, inside that factory, call
 * `vi.importActual` with the SAME specifier and spread the result. Parsed with
 * `ts.createSourceFile` and walked for call nodes, for the reason `scripts/box-files.mjs` records:
 * this repository's censuses are full of fabricated code as fixture DATA, and a regex reads inside
 * strings. The fixtures below are strings for the same reason — they are parsed on purpose, and
 * they are invisible to the directory scan that reads call nodes.
 *
 * A single-argument `vi.mock(spec)` is untouched: it asks for the automock, which mirrors the
 * module's surface by construction and cannot go stale.
 */

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** A module a rig must NOT load for real, with the reason. Empty today; it may only shrink. */
const EXEMPT: { specifier: string; why: string }[] = [];

interface Factory { file: string; specifier: string; ok: boolean; why: string }

/** Every `vi.mock(<literal>, <factory>)` in one file, judged. */
function factories(file: string, src: string): Factory[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: Factory[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "vi" &&
      node.expression.name.text === "mock" &&
      node.arguments.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      const specifier = node.arguments[0]!.text;
      const factory = node.arguments[1]!;
      const body = factory.getText(sf);
      /* The specifier must match: `importActual` of a DIFFERENT module spreads the wrong surface,
         which is a mock that silently exports somebody else's names. */
      const actual = new RegExp(
        `importActual(?:<[^>]*>)?\\(\\s*["'\`]${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`,
      ).test(body.replace(/\s*\n\s*/g, " "));
      const spread = /\.\.\.\s*[A-Za-z0-9_$]+/.test(body);
      out.push({
        file,
        specifier,
        ok: actual && spread,
        why: !actual ? "no vi.importActual of the same specifier" : !spread ? "importActual is never spread" : "",
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

const all = (): Factory[] =>
  readdirSync(DIR)
    .filter((f) => /\.test\.tsx?$/.test(f) && f !== "mock-factory-census.test.ts")
    .flatMap((f) => factories(f, readFileSync(`${DIR}${f}`, "utf8")));

describe("apps/desktop/test — a mock factory spreads importActual", () => {
  it("finds the mock factories at all", () => {
    // Anti-vacuity: the case below is a filter over this list, and a filter over nothing passes.
    // The bridge-fetch rigs are named because they are the measured subject.
    const found = all();
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.filter((f) => f.specifier === "../src/bridge-fetch.js").length).toBe(5);
  });

  it("every factory spreads the real module", () => {
    const bad = all()
      .filter((f) => !f.ok && !EXEMPT.some((e) => e.specifier === f.specifier))
      .map((f) => `${f.file} mocks ${f.specifier}: ${f.why}`);
    expect(bad, `partial mock factories:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("…and every exemption is a module some rig still mocks — the list may only shrink", () => {
    const mocked = new Set(all().map((f) => f.specifier));
    const stale = EXEMPT.filter((e) => !mocked.has(e.specifier)).map((e) => e.specifier);
    expect(stale, `exemption(s) for modules nothing mocks: ${stale.join(", ")}`).toEqual([]);
  });

  /**
   * THE PARSE ITSELF, against the shapes that tell the rule apart. A census that only reads the
   * directory has no evidence about what it would refuse, and both halves have been wrong here:
   * an `importActual` of another module, and one whose result is bound and never spread.
   */
  it("admits the spreading factory and refuses each way of half-applying one", () => {
    /* The fixture sources below carry `import(...)` as TEXT. This file is published by extension,
       and the tree-level import closure reads a literal specifier wherever it appears, template
       literals included, so a literal here reads as this file importing a module the mirror does
       not contain. The quote is interpolated instead: the fixture STRING is unchanged and the
       static scan has nothing to bind to. */
    const Q = String.fromCharCode(34);
    const cases: [string, boolean, string][] = [
      [`vi.mock("../src/m.js", async () => { const real = await vi.importActual<typeof import(${Q}../src/m.js${Q})>("../src/m.js"); return { ...real, a: 1 }; });`, true, "spread importActual"],
      [`vi.mock("../src/m.js", () => ({ a: 1, b: 2 }));`, false, "names its exports"],
      [`vi.mock("../src/m.js", async () => { const real = await vi.importActual<typeof import(${Q}../src/other.js${Q})>("../src/other.js"); return { ...real, a: 1 }; });`, false, "importActual of another module"],
      [`vi.mock("../src/m.js", async () => { const real = await vi.importActual("../src/m.js"); return { a: real.a, b: 2 }; });`, false, "importActual bound and never spread"],
    ];
    for (const [src, ok, what] of cases) {
      const f = factories("fixture.ts", src);
      expect(f.length, `${what}: the parse found no factory`).toBe(1);
      expect(f[0]!.ok, `${what} should be ${ok ? "admitted" : "refused"} (${f[0]!.why})`).toBe(ok);
    }
    // A one-argument automock is not a factory and is not judged.
    expect(factories("fixture.ts", `vi.mock("../src/m.js");`).length).toBe(0);
  });
});
