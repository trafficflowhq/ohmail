import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ THE OVERRIDE HAS ONE PREDICATE AND ONE OWNER ════════════════════════════════════════════
 *
 * A person's own placement outranks a graduated route from then on. Three things have to stay
 * true for that to be a property of the code rather than of one function:
 *
 *  1. **Every adoption arm feeds it.** An externally observed move is the only evidence that
 *     settles a route, and it is observed in `adopt_external` arms. An arm that adopts without
 *     feeding the override is a place where the person's hand is silently forgotten — and it
 *     looks exactly like an arm that does, because the adoption itself still works.
 *  2. **Every auto-apply site consults the predicate.** The demotion works by clearing
 *     `graduations.graduated`; a second site that auto-applies on some other reading would keep
 *     filing mail the person has already overruled, with this whole seam green.
 *  3. **The demotion effect has one owner.** It disables a promoted rule and clears the flag.
 *     Two spellings of that pair is how a route ends up demoted by one reading and not the
 *     other; there were two until this lane, and the second was two lines from the first.
 *
 * SCANNED ROOTS: `packages/core/src`, `packages/services/src`, `apps/worker/src`. Rule 3 also
 * scans `packages/db/src`, where the effect lives.
 */

const HERE = resolve(import.meta.dirname ?? ".");
const REPO = resolve(HERE, "../../..");
const ROOTS = [
  "packages/core/src", "packages/services/src", "apps/worker/src", "packages/db/src",
] as const;

/**
 * Adoption arms that deliberately do NOT feed the override, each with the reason. Empty: the one
 * that did not (the reconcile writer's) had no caller and is gone (gap row
 * RECONCILE-RUNNER-ADOPT-DOES-NOT-FEED-THE-OVERRIDE). An entry that matches nothing is refused.
 */
const EXEMPT_ADOPT_ARMS: Record<string, string> = {};

interface Site { file: string; fn: string; line: number }

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...tsFiles(p)); continue; }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => tsFiles(join(REPO, r)));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The nearest named function/method enclosing a node, or `<module>`. */
function enclosingFn(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)
    ) return n.parent.name.text;
  }
  return "<module>";
}

function site(sf: ts.SourceFile, node: ts.Node): Site {
  return {
    file: relative(REPO, sf.fileName),
    fn: enclosingFn(node),
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  };
}

/** Is `name` CALLED anywhere under `node`? A mention, an import or a type is not a call. */
function callsName(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const callee = ts.isPropertyAccessExpression(c) ? c.name.text
        : ts.isIdentifier(c) ? c.text
        : null;
      if (callee === name) { found = true; return; }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Every `case "adopt_external":` clause in the scanned roots. */
function adoptArms(): { arm: ts.CaseClause; sf: ts.SourceFile }[] {
  const arms: { arm: ts.CaseClause; sf: ts.SourceFile }[] = [];
  for (const file of FILES) {
    const sf = parse(file);
    const walk = (n: ts.Node): void => {
      if (
        ts.isCaseClause(n) && ts.isStringLiteral(n.expression)
        && n.expression.text === "adopt_external"
      ) arms.push({ arm: n, sf });
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return arms;
}

/** The arm feeds it itself, or through the shared adoption door, which must feed it (asserted below). */
const feeds = (arm: ts.Node): boolean =>
  callsName(arm, "recordExternalOverride") || callsName(arm, "adoptExternalPlacement");

describe("rule 1 — every adoption arm feeds the override", () => {
  const arms = adoptArms();

  it("the shared adoption door feeds it", () => {
    const sf = parse(join(REPO, "packages/core/src/pipeline.ts"));
    let door: ts.Node | undefined;
    const find = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "adoptExternalPlacement") door = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    expect(door !== undefined && callsName(door, "recordExternalOverride")).toBe(true);
  });

  it("finds the adoption arm at all — a census over nothing is a census that cannot fire", () => {
    expect(arms.map(({ arm, sf }) => site(sf, arm).fn)).toEqual(["commitChange"]);
  });

  it("every arm calls `recordExternalOverride`, or is exempt BY NAME with a reason", () => {
    const unguarded = arms
      .map(({ arm, sf }) => ({ ...site(sf, arm), feeds: feeds(arm) }))
      .filter((s) => !s.feeds && EXEMPT_ADOPT_ARMS[s.fn] === undefined);
    expect(unguarded).toEqual([]);
  });

  it("every exemption still matches an arm — a stale exemption is a hole that reads as a decision", () => {
    const exemptFns = new Set(
      arms.filter(({ arm }) => !feeds(arm))
        .map(({ arm, sf }) => site(sf, arm).fn),
    );
    const stale = Object.keys(EXEMPT_ADOPT_ARMS).filter((fn) => !exemptFns.has(fn));
    expect(stale).toEqual([]);
  });

  it("at least one arm DOES feed it — the exemption list cannot swallow the whole rule", () => {
    const feeding = arms.filter(({ arm }) => feeds(arm));
    expect(feeding.length).toBeGreaterThanOrEqual(1);
  });
});

describe("rule 2 — every auto-apply site consults the graduation predicate", () => {
  /** Functions that read the auto-apply confidence bar. */
  function autoApplySites(): Site[] {
    const out: Site[] = [];
    for (const file of FILES) {
      const sf = parse(file);
      const walk = (n: ts.Node): void => {
        // The DECLARATION is not a site; a read of it is.
        const isDecl = ts.isVariableDeclaration(n.parent)
          && ts.isIdentifier(n.parent.name) && n.parent.name.text === "AUTO_APPLY_CONFIDENCE_BAR";
        if (ts.isIdentifier(n) && n.text === "AUTO_APPLY_CONFIDENCE_BAR" && !isDecl
          && !ts.isImportSpecifier(n.parent) && !ts.isExportSpecifier(n.parent)) {
          out.push(site(sf, n));
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
    return out;
  }

  it("finds the auto-apply site", () => {
    expect(autoApplySites().length).toBeGreaterThanOrEqual(1);
  });

  it("each reading function also calls `isGraduated`", () => {
    const bad: Site[] = [];
    for (const file of FILES) {
      const sf = parse(file);
      const walk = (n: ts.Node): void => {
        if (
          ts.isIdentifier(n) && n.text === "AUTO_APPLY_CONFIDENCE_BAR"
          && !ts.isImportSpecifier(n.parent) && !ts.isExportSpecifier(n.parent)
          && !(ts.isVariableDeclaration(n.parent) && n.parent.name.getText(sf) === n.text)
        ) {
          const fn = fnBody(n);
          if (fn && !callsName(fn, "isGraduated")) bad.push(site(sf, n));
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
    expect(bad).toEqual([]);
  });

  /** The body of the nearest enclosing function, or `undefined` at module scope. */
  function fnBody(node: ts.Node): ts.Node | undefined {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
        || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n;
    }
    return undefined;
  }
});

describe("rule 3 — the demotion effect has exactly one owner", () => {
  /**
   * Every `.set({ … enabled … demotions … })` — the disable-and-count pair, as a WRITE.
   *
   * Scoped to a `.set()` argument on purpose: the two schema modules declare both names as
   * COLUMNS in one object literal, and a rule that counted those would be red at every tip and
   * say nothing about writers.
   */
  function demotionWrites(): Site[] {
    const out: Site[] = [];
    for (const file of FILES) {
      const sf = parse(file);
      const walk = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && n.expression.name.text === "set" && n.arguments.length === 1
          && ts.isObjectLiteralExpression(n.arguments[0]!)
        ) {
          const names = n.arguments[0]!.properties
            .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
            .filter((x): x is string => x !== null);
          if (names.includes("enabled") && names.includes("demotions")) out.push(site(sf, n));
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
    return out;
  }

  it("is written in `demoteRoute`, the demotions' one post-commit door, and nowhere else", () => {
    expect(demotionWrites().map((s) => `${s.fn} (${s.file})`)).toEqual([
      "demoteRoute (packages/db/src/learning-signal.ts)",
    ]);
  });
});
