import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineUnitFiles } from "../../../test/support/engine-unit.js";

/**
 * NO MODULE THE ENGINE BUNDLES MAY RUN A COMMAND WHEN IT IS MERELY IMPORTED.
 *
 * The engine ships as one bundled file. A bundler rewrites every module's `import.meta.url` to the
 * URL of the OUTPUT it produced, so inside the bundle every module claims to be the file the user
 * ran — and the ordinary Node idiom for "was I run directly?", comparing `import.meta.url` with
 * `process.argv[1]`, is therefore TRUE for every module in the bundle that carries it.
 *
 * That is not a theoretical hazard. The `organize-here` command's guard sat at the bottom of the
 * module that also holds the takeover logic the engine imports. The day the engine started
 * importing that logic, the command began running inside the engine on every launch: it opened the
 * local database and took the data directory's exclusive lock before the engine's own startup
 * could, so startup then refused — correctly, since that lock is what stops two writers on one
 * mirror — and the engine never served on any platform. Its success path was `process.exit`, which
 * would have ended a packaged app's engine at launch instead.
 *
 * The remedy is a shape, not a patch: the half that RUNS lives in a file of its own that nothing
 * imports (`*-cli.ts`), and the half that is importable holds no guard. This test holds the tree to
 * that shape, because the engine's import closure grows and the next module to join it is the one
 * nobody will think to check.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const ROOT = join(HERE, "..", "..", "..");

/**
 * Comments are stripped BEFORE the search, and that is load-bearing rather than tidy: the prose in
 * this package explains the very idiom being banned (`main.ts` names it), so a raw search would
 * report the explanation as the defect and the only way to quiet it would be to stop explaining.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The two ways a module asks "was I run directly?" — the shared helper, and the idiom by hand. */
function entryGuardsIn(text: string): string[] {
  const body = code(text);
  const hits: string[] = [];
  for (const line of body.split("\n")) {
    if (/\bisCliEntry\s*\(/.test(line)) hits.push(line.trim());
    else if (/import\.meta\.url/.test(line) && /\bargv\b/.test(line)) hits.push(line.trim());
  }
  return hits;
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SIDECAR_SOURCES = sourcesUnder(SRC);
const isCliFile = (p: string): boolean => p.endsWith("-cli.ts");

describe("the engine's import closure runs no command", () => {
  /**
   * THE DETECTOR IS CHECKED AGAINST THE DEFECT IT EXISTS TO CATCH, because a search that silently
   * matches nothing is indistinguishable from a tree that is clean. This is the exact text that
   * shipped, and the exact comment shape that must NOT count.
   */
  it("the detector sees the guard that shipped, and does not see prose about it", () => {
    const asItShipped = 'if (isCliEntry(import.meta.url)) {\n  void runOrganizeHere();\n}\n';
    expect(entryGuardsIn(asItShipped)).toHaveLength(1);

    const byHand = 'if (import.meta.url === pathToFileURL(process.argv[1]).href) { main(); }\n';
    expect(entryGuardsIn(byHand)).toHaveLength(1);

    expect(entryGuardsIn("// isCliEntry(import.meta.url) is why this file exists\n")).toEqual([]);
    expect(entryGuardsIn("/*\n * isCliEntry(import.meta.url) compares argv[1].\n */\n")).toEqual([]);
  });

  it("looks at the whole package, not at nothing", () => {
    // A file list that quietly came back empty would make every assertion below vacuous.
    expect(SIDECAR_SOURCES.length).toBeGreaterThan(25);
    const names = SIDECAR_SOURCES.map((p) => relative(SRC, p));
    expect(names).toContain("main.ts");
    for (const unit of engineUnitFiles()) expect(names).toContain(relative(SRC, unit));
    expect(names).toContain("organize-here.ts");
    expect(names).toContain("organize-here-cli.ts");
  });

  it("no importable engine source carries an entry guard", () => {
    const offenders = SIDECAR_SOURCES.filter((p) => !isCliFile(p) && entryGuardsIn(readFileSync(p, "utf8")).length > 0)
      .map((p) => relative(ROOT, p));
    // Named rather than counted: the failure has to say which file, because the fix is to move
    // that file's running half into a `*-cli.ts` beside it.
    expect(offenders).toEqual([]);
  });

  it("nothing imports a command entry point", () => {
    const cliNames = SIDECAR_SOURCES.filter(isCliFile).map((p) => relative(SRC, p).replace(/\.ts$/, ".js"));
    expect(cliNames.length).toBeGreaterThan(0);
    const importers: string[] = [];
    for (const p of SIDECAR_SOURCES) {
      const body = code(readFileSync(p, "utf8"));
      for (const name of cliNames) {
        if (body.includes(`./${name}`)) importers.push(`${relative(ROOT, p)} → ${name}`);
      }
    }
    expect(importers).toEqual([]);
  });

  /**
   * THE CLOSURE ITSELF, when it has been built. `build/engine.meta.json` is esbuild's own record of
   * the files that became the shipped bytes — the only authority on what is actually in the bundle,
   * as opposed to what the source tree suggests. It is absent on a checkout that has not built the
   * engine, so the assertions above stand alone and this one adds the workspace modules the sidecar
   * reaches through package exports.
   */
  it("no workspace module in the built bundle carries an entry guard", () => {
    const metafile = join(ROOT, "build", "engine.meta.json");
    if (!existsSync(metafile)) return;
    const meta = JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> };
    const workspace = Object.keys(meta.inputs).filter((k) => !k.includes("node_modules"));
    expect(workspace.length).toBeGreaterThan(50);
    const offenders = workspace.filter((k) => {
      const p = join(ROOT, k);
      return existsSync(p) && entryGuardsIn(readFileSync(p, "utf8")).length > 0;
    });
    expect(offenders).toEqual([]);
  });
});
