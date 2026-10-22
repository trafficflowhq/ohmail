import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * NO SERVICE PATH WRITES TO THE PROCESS OUTPUT BUT THROUGH THE STRUCTURED LOGGER.
 *
 * `console.error(msg, err)` prints a thrown value whole: its message, stack, enumerable fields (a
 * driver's `detail`) and its `cause`, so what reached the drain was whatever a database, TLS or model
 * error happened to carry. `createLogger` reduces `err` to class and code (`packages/core/src/log.ts`).
 * Read from the AST, so prose can neither trip the census nor hide a site. The operator CLIs keep
 * their terminal output: they are listed, each must still write, and nothing in `src` imports one.
 */

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));
const SRC = join(REPO, "packages/services/src");

/** Run by an operator's hand, never imported by a service path. */
const CLI_OUTPUT: readonly string[] = [
  "attachment-flag-backfill-cli.ts",
  "inferred-press-repair-cli.ts",
  "inline-cid-backfill-cli.ts",
  "invite-cli.ts",
  "sensitive-rescreen-cli.ts",
];

const GLOBALS = new Set(["globalThis", "global", "window", "self"]);
const PROPERTY_NAME = (p: ts.Node, n: ts.Node): boolean =>
  (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
    || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p)
    || ts.isSetAccessorDeclaration(p)) && p.name === n;

/** The lines that reach `console`, `process.stdout` or `process.stderr` in any spelling. */
function rawOutputSites(text: string, file = "subject.ts"): number[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const at = (n: ts.Node): void => { lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1); };
  const walk = (n: ts.Node): void => {
    const p = n.parent;
    if (ts.isIdentifier(n) && n.text === "console" && p) {
      const member = ts.isPropertyAccessExpression(p) && p.name === n && !GLOBALS.has(p.expression.getText(sf));
      if (!member && !PROPERTY_NAME(p, n)) at(n);
    } else if (ts.isPropertyAccessExpression(n) && (n.name.text === "stdout" || n.name.text === "stderr")
      && /(^|\.)process$/.test(n.expression.getText(sf))) {
      at(n);
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
      && ["console", "stdout", "stderr"].includes(n.argumentExpression.text)) {
      at(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return lines;
}

/** The `src` modules a file imports or re-exports, by base name without extension. */
function importedStems(text: string, file: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) ? n.moduleSpecifier
      : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword ? n.arguments[0] : undefined;
    if (spec && ts.isStringLiteralLike(spec) && spec.text.startsWith(".")) {
      out.push(basename(spec.text).replace(/\.(js|ts)$/, ""));
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.[cm]?tsx?$/.test(e) && !e.endsWith(".d.ts") ? [p] : [];
  });
}

const FILES = new Map(sourceFiles(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")]));

describe("raw output on a service path", () => {
  it("reads every source file, the subdirectories included", () => {
    expect(FILES.size).toBeGreaterThan(100);
    for (const f of ["screener-service.ts", join("auth", "auth-service.ts"), join("mail", "mail-service.ts")]) {
      expect(FILES.has(f), `${f} was not read`).toBe(true);
    }
  });

  it("finds a raw write in every spelling, and none in prose or a property name", () => {
    expect(rawOutputSites([
      "console.error(\"x\", err);",
      "console[\"warn\"](err);",
      "globalThis.console.log(err);",
      "const out = console;",
      "process.stderr.write(\"x\");",
      "const bag = { console };",
      "globalThis[\"console\"].info(err);",
    ].join("\n"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rawOutputSites([
      "// console.error(err)",
      "/* console.log(err) */",
      "const s = \"console.error(err)\";",
      "const t = `console.log`;",
      "const o = { console: 1 };",
      "const u = o.console;",
      "const consoleUrl = \"\";",
      "type T = { console: string };",
    ].join("\n"))).toEqual([]);
  });

  it("no service path writes to the process output", () => {
    const found = [...FILES].filter(([f]) => !CLI_OUTPUT.includes(f))
      .flatMap(([f, text]) => rawOutputSites(text, f).map((line) => `${f}:${line}`));
    expect(found, "these print a thrown value whole; log it with `createLogger` and `err`").toEqual([]);
  });

  it("every listed CLI exists and still writes, and nothing in src imports one", () => {
    for (const cli of CLI_OUTPUT) {
      const text = FILES.get(cli);
      expect(text, `${cli} is listed and gone`).toBeDefined();
      expect(rawOutputSites(text!, cli).length, `${cli} is listed and writes nothing`).toBeGreaterThan(0);
    }
    const stems = new Set(CLI_OUTPUT.map((c) => c.replace(/\.ts$/, "")));
    const importers = [...FILES].flatMap(([f, text]) =>
      importedStems(text, f).filter((s) => stems.has(s)).map((s) => `${f} -> ${s}`));
    expect(importers, "a CLI imported by src is a service path").toEqual([]);
  });
});
