/**
 * What is built from this package holds its own source, the calendar core, the address gate with its
 * pinned request, and the markup parser with what that parser declares. Nothing else: not the mail
 * core's barrel, not the invitation reader, no store.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "..", "..");
const SRC = join(PKG, "src");

/** Where a module of the bundle may live. The parser's own dependencies are named as its manifest declares them. */
const MAY_HOLD = [
  "packages/cal-providers/src/",
  "packages/cal-core/src/",
  "packages/core/src/net/",
  "node_modules/htmlparser2/",
  "node_modules/entities/",
  "node_modules/domhandler/",
  "node_modules/domutils/",
  "node_modules/domelementtype/",
  "node_modules/dom-serializer/",
];

/** Every module the bundle of `entry` is made from, by its path from the repository's root. */
async function inputsOf(entry: { file: string } | { text: string }): Promise<string[]> {
  const out = await build({
    ...("file" in entry ? { entryPoints: [entry.file] } : { stdin: { contents: entry.text, resolveDir: SRC, sourcefile: join(SRC, "planted.ts"), loader: "ts" as const } }),
    bundle: true,
    platform: "node",
    format: "esm",
    conditions: ["ohmail-source"],
    metafile: true,
    write: false,
    absWorkingDir: ROOT,
    outdir: "out",
    logLevel: "silent",
  });
  return Object.keys(out.metafile.inputs);
}
const foreign = (inputs: readonly string[]): string[] => inputs.filter((p) => !MAY_HOLD.some((dir) => p.startsWith(dir)));

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** The package's own modules as they are built, one output each and nothing of another package in them. */
async function ownCode(files: readonly string[] | { text: string }): Promise<string> {
  const out = await build({
    ...("text" in files ? { stdin: { contents: files.text, resolveDir: SRC, sourcefile: join(SRC, "planted.ts"), loader: "ts" as const } } : { entryPoints: [...files] }),
    bundle: false,
    format: "esm",
    write: false,
    absWorkingDir: PKG,
    outdir: "out",
    outbase: SRC,
    logLevel: "silent",
  });
  return out.outputFiles.map((f) => f.text).join("\n");
}
/** What the package's own code never calls: a clock, the environment, a request of the platform's, the global object. */
const AMBIENT = ["Date.now(", "new Date()", "process.env", "process.", "fetch(", "globalThis", "Math.random(", "resolvedOptions("];
const ambient = (code: string): string[] => AMBIENT.filter((call) => code.includes(call));

describe("what the package's bundle is made from", () => {
  it("holds its own source, the calendar core, the gate and the parser, and nothing else", async () => {
    const inputs = await inputsOf({ file: join(SRC, "index.ts") });
    expect(inputs).toContain("packages/cal-providers/src/index.ts");
    expect(foreign(inputs)).toEqual([]);
  });

  it("is a check that bites: the mail core's barrel and the invitation reader are named when they are imported", async () => {
    const barrel = foreign(await inputsOf({ text: `export * from "./index.js";\nexport { canonicalHost } from "@trafficflow/core";\n` }));
    expect(barrel).toContain("packages/core/src/index.ts");
    const invitation = foreign(await inputsOf({ text: `export * from "./index.js";\nexport * from "../../core/src/ics.js";\n` }));
    expect(invitation).toContain("packages/core/src/ics.ts");
  });

  it("reads no clock, no environment and makes no request of its own, in any module", async () => {
    expect(ambient(await ownCode(sourceFiles()))).toEqual([]);
  });

  it("is a check that bites: a clock, a setting of the environment and a bare request are each named", async () => {
    const planted = await ownCode({ text: "export const now = () => Date.now();\nexport const base = process.env.OHCAL_MS_GRAPH_BASE;\nexport const get = (u: string) => fetch(u);\n" });
    expect(ambient(planted)).toEqual(["Date.now(", "process.env", "process.", "fetch("]);
  });

  it("has a module behind every door, and names the calendar core, the mail core and the parser as its only dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, Record<string, string>> };
    expect(Object.keys(manifest.exports)).toEqual([".", "./port", "./refusals", "./limits", "./request", "./google", "./caldav", "./microsoft", "./ics"]);
    expect(Object.values(manifest.exports).map((to) => to["ohmail-source"]!).filter((source) => !existsSync(join(PKG, source)))).toEqual([]);
    expect(manifest.dependencies).toEqual({ "@ohmail/cal-core": "0.0.0", "@trafficflow/core": "*", htmlparser2: "12.0.0" });
  });
});
