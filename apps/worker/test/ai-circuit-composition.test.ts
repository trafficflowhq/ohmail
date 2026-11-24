import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * THE TWO HALVES OF THE CIRCUIT TAKE THE SAME MAILBOX ID.
 *
 * `meter(id, port)` records THIS mailbox's charge; `port(id)` clears THIS mailbox's record on a
 * success. Two different ids, or one omitted where the other is given, and a mailbox's charge is
 * recorded under a name nothing ever clears — or, worse, cleared by another mailbox's success,
 * which is the defect the scoping closed. Both spellings compile, both run, and the ledger row
 * looks identical either way: only the refund that never happens is different.
 *
 * A comment cannot hold that. This is a census over `apps/worker/src`: for every `meter(` call
 * on the circuit, the enclosing function calls `port(` with the SAME argument text.
 *
 * SCANNED ROOT: `apps/worker/src`.
 */

const HERE = resolve(import.meta.dirname ?? ".");
const ROOT = resolve(HERE, "../src");
/** The organizer's package: the passes the worker runs that moved out of it (ruling:organizer-cut). */
const ROOTS = [ROOT, resolve(HERE, "../../../packages/organizer/src")];
const REPO = resolve(HERE, "../../..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...tsFiles(p)); continue; }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The nearest enclosing function node, or the source file at module scope. */
function enclosing(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
      || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n;
  }
  return node.getSourceFile();
}

/** Every `<something>.<name>(…)` call under `node`, with its first argument's source text. */
function callsOf(sf: ts.SourceFile, node: ts.Node, name: string): { arg: string; line: number }[] {
  const out: { arg: string; line: number }[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === name
    ) {
      out.push({
        arg: n.arguments[0]?.getText(sf) ?? "<none>",
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

interface Finding { file: string; line: number; metered: string; ports: string[] }

function disagreements(): Finding[] {
  const out: Finding[] = [];
  for (const file of ROOTS.flatMap((r) => tsFiles(r))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const metered of callsOf(sf, sf, "meter")) {
      // Locate the `meter(` node again to take its enclosing function.
      const walk = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && n.expression.name.text === "meter"
          && sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 === metered.line
        ) {
          const ports = callsOf(sf, enclosing(n), "port").map((p) => p.arg);
          if (!ports.includes(metered.arg)) {
            out.push({ file: relative(REPO, file), line: metered.line, metered: metered.arg, ports });
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
  }
  return out;
}

describe("the circuit's two halves are composed with one mailbox id", () => {
  it("finds a `meter(` call at all — a census over nothing cannot fire", () => {
    let n = 0;
    for (const file of ROOTS.flatMap((r) => tsFiles(r))) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      n += callsOf(sf, sf, "meter").length;
    }
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("every metered mailbox is also the wrapper's mailbox", () => {
    expect(disagreements()).toEqual([]);
  });
});
