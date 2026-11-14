/**
 * THE WIRE EXPORTS NO VALUE AND IMPORTS NO PACKAGE.
 *
 * Every package of the product may import `@ohmail/wire` because importing it costs nothing: it
 * is erased at build. That holds only while the package is types and nothing else, so it is held
 * here by what the package DOES. Loaded, no module of it has an export. Compiled, every module
 * comes out empty, and the program is the package's own files and the language's library: no file
 * of another package is in it.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import tsconfig from "../tsconfig.json" with { type: "json" };

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");
const modules = readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort();

/**
 * Compile one directory as this package is compiled and say what is in it that is not a type:
 * a module that comes out with code, and a file the program reached outside the directory.
 */
function notTypes(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
  const program = ts.createProgram(files.map((f) => join(dir, f)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: true, noEmitOnError: false, types: [], removeComments: true,
  });
  const out: string[] = [];
  const within = (f: string) => f.replace(/\\/g, "/").startsWith(`${dir.replace(/\\/g, "/")}/`);
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf) || within(sf.fileName)) continue;
    out.push(`reaches ${sf.fileName.replace(/\\/g, "/").split("/").slice(-2).join("/")}`);
  }
  program.emit(undefined, (name, text) => {
    if (!name.endsWith(".js")) return;
    const code = text.replace(/^export \{\};?\s*$/gm, "").replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim();
    if (code !== "") out.push(`${name.slice(name.replace(/\\/g, "/").lastIndexOf("/") + 1)} emits code`);
  });
  return out.sort();
}

const scratch = mkdtempSync(join(tmpdir(), "wire-types-only-"));
const planted = join(scratch, "planted");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("@ohmail/wire is types only", () => {
  it("has modules to read", () => {
    expect(modules.length).toBeGreaterThanOrEqual(15);
    expect(modules).toContain("index.ts");
  });

  it("every module, loaded, exports nothing", async () => {
    const withExports: string[] = [];
    for (const f of modules) {
      const loaded = await import(pathToFileURL(join(SRC, f)).href) as Record<string, unknown>;
      if (Object.keys(loaded).length > 0) withExports.push(`${f}: ${Object.keys(loaded).join(", ")}`);
    }
    expect(withExports).toEqual([]);
  });

  it("compiles to nothing, from its own files and the language's library alone", () => {
    expect(notTypes(SRC)).toEqual([]);
  }, 60_000);

  it("REFUSES a planted value, a planted enum and a planted import from outside the package", () => {
    mkdirSync(planted);
    mkdirSync(join(scratch, "elsewhere"));
    writeFileSync(join(scratch, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(scratch, "elsewhere", "thing.ts"), "export type Thing = 1;\n");
    writeFileSync(join(planted, "fine.ts"), "export type Fine = 1;\nexport interface AlsoFine { a: Fine }\n");
    writeFileSync(join(planted, "value.ts"), 'export const KINDS = ["a"] as const;\n');
    writeFileSync(join(planted, "enumerated.ts"), "export enum Kind { A }\n");
    writeFileSync(join(planted, "reaching.ts"), 'import type { Thing } from "../elsewhere/thing.js";\nexport type Reached = Thing;\n');
    expect(notTypes(planted)).toEqual([
      "enumerated.js emits code",
      "reaches elsewhere/thing.ts",
      "value.js emits code",
    ]);
  }, 60_000);

  it("can build declarations and nothing else, and offers types and no entry to run", () => {
    // `types` alone: no condition a bundler or Node matches, so nothing can import the package at
    // run time, and no source file is ever Node's target (test/node-consumers-avoid-src-leaves).
    expect(tsconfig.compilerOptions.emitDeclarationOnly).toBe(true);
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(manifest.exports["."]).toEqual({ types: "./src/index.ts" });
    expect(manifest.dependencies).toEqual({});
    expect(manifest.sideEffects).toBe(false);
  });
});
