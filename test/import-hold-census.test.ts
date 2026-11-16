import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * THE IMPORT HOLD REACHES ROUTING ONLY AS `importHoldNow()` ANSWERED IT. `{ kind: "unreadable" }`
 * is the one blanket hold left; a host porting the old boolean as `open ? { kind: "unreadable" } :
 * undefined` would keep every stranger in the INBOX with the core suite green. Two
 * parsed claims over every `apps/*\/src` and `packages/*\/src` file: an `importHold` property is a
 * pass-through, `undefined` or a call of `importHoldNow`; and a file naming the hold builds no
 * `kind: "unreadable"` literal unless it is the producer. SCANNED ROOTS: run it by name.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCER = "packages/organizer/src/profile.ts";

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "build"].includes(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path.join(dir, entry.name));
    }
  };
  for (const group of ["apps", "packages"]) {
    for (const pkg of readdirSync(path.join(REPO, group))) {
      const src = path.join(REPO, group, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src here */ }
    }
  }
  return out;
}

const unwrap = (e: ts.Expression): ts.Expression[] => {
  if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)) return unwrap(e.expression);
  if (ts.isConditionalExpression(e)) return [...unwrap(e.whenTrue), ...unwrap(e.whenFalse)];
  return [e];
};

/** A value `importHold` may carry: a pass-through, `undefined`, or `…importHoldNow()`. */
function admittedValue(e: ts.Expression): boolean {
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return true;
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
    && e.expression.name.text === "importHoldNow";
}

const isUnreadableLiteral = (n: ts.Node): boolean => ts.isObjectLiteralExpression(n) && n.properties.some((p) =>
  ts.isPropertyAssignment(p) && p.name.getText() === "kind"
  && ts.isStringLiteralLike(p.initializer) && p.initializer.text === "unreadable");

interface Reading { sites: number; unreadable: number; refusals: string[] }

/** One file's reading — the unit the planted controls below drive. */
function classify(rel: string, text: string): Reading {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const r: Reading = { sites: 0, unreadable: 0, refusals: [] };
  const literals: ts.Node[] = [];
  let namesHold = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && /^(importHold|importHoldNow|ImportHold)$/.test(n.text)) namesHold = true;
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "importHold") r.sites += 1;
    if (ts.isPropertyAssignment(n) && n.name.getText() === "importHold") {
      r.sites += 1;
      const bad = unwrap(n.initializer).filter((v) => !admittedValue(v));
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (bad.length > 0) r.refusals.push(`${rel}:${line} importHold carries ${bad.map((b) => b.getText()).join(" | ")}`);
    }
    if (isUnreadableLiteral(n)) literals.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (namesHold) {
    r.unreadable = literals.length;
    if (rel !== PRODUCER) {
      for (const n of literals) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        r.refusals.push(`${rel}:${line} builds kind "unreadable" outside ${PRODUCER}`);
      }
    }
  }
  return r;
}

const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

describe("the import hold reaches routing only as importHoldNow answered it", () => {
  it("the tree: every importHold is a pass-through or importHoldNow, and only the producer builds unreadable", () => {
    let sites = 0;
    let produced = 0;
    const refusals: string[] = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const r = classify(rel, readFileSync(file, "utf8"));
      sites += r.sites;
      if (rel === PRODUCER) produced = r.unreadable;
      refusals.push(...r.refusals);
    }
    // The premise, so a parse that saw nothing cannot pass: the hosts thread the hold at six
    // sites (sync.ts twice, reconcile-cron.ts twice, index.ts, engine.ts) and the producer builds it.
    expect(sites, "the parse found almost no importHold sites").toBeGreaterThanOrEqual(6);
    expect(produced, "the producer's unreadable answer was not seen").toBeGreaterThanOrEqual(1);
    expect(refusals).toEqual([]);
  });

  it("a host that ports the old boolean as `unreadable` is refused — planted in the engine", () => {
    const rel = "apps/sidecar/src/engine.ts";
    const real = read(rel);
    const call = "importHold: await profileSync.importHoldNow(),";
    expect(real.split(call).length - 1, "the engine's threading site moved").toBe(1);
    expect(classify(rel, real).refusals, "the real engine is admitted").toEqual([]);

    const ported = real.replace(call,
      "importHold: (await profileSync.importDecisionOpen()) ? { kind: \"unreadable\" } : undefined,");
    const got = classify(rel, ported).refusals;
    expect(got.some((l) => l.includes("importHold carries { kind: \"unreadable\" }")), got.join("\n")).toBe(true);
    expect(got.some((l) => l.includes("builds kind \"unreadable\"")), got.join("\n")).toBe(true);

    const aside = real.replace(call, "importHold: held,")
      .replace("export async function createSidecar(", "const held = { kind: \"unreadable\" } as const;\nexport async function createSidecar(");
    expect(classify(rel, aside).refusals.some((l) => l.includes("builds kind \"unreadable\"")),
      "a literal built beside the site and passed by name").toBe(true);
  });
});
