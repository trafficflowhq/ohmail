/**
 * A PACKAGE'S BORDERS, READ OFF WHAT IT BUILDS TO.
 *
 * Every file under a package's `src` is bundled once, with the packages its row allows left
 * outside the bundle, and the bundle's inputs are listed. What is left is the package's own files
 * and whatever else it reached: an input under another package or an app is an import its row
 * does not name. An import of types alone is erased before the bundler sees it, so it never
 * appears, which is what "types only" means.
 *
 * This reads a built thing, not the source's text: a comment that names a path changes nothing.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { build } from "esbuild";
import { ROOT } from "./ci-shards.mjs";

export interface Borders {
  /** The package's folder, from the repository's root: `packages/app-logic`. */
  readonly folder: string;
  /** The product's packages its row allows, by name. They stay outside the bundle. */
  readonly mayImport: readonly string[];
  /** Libraries it must never reach, by the folder name under `node_modules`. */
  readonly neverLibraries?: readonly string[];
  /** File endings it must never hold or reach (`.css`, `.tsx`). */
  readonly neverEndings?: readonly string[];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const slashed = (path: string) => path.split(sep).join("/");

async function inputsOf(borders: Borders, entry: { files: string[] } | { planted: string }): Promise<string[]> {
  const outside = ["react", ...borders.mayImport].flatMap((name) => [name, `${name}/*`]);
  const result = await build({
    absWorkingDir: ROOT,
    ...("files" in entry
      ? { entryPoints: entry.files, outdir: "out" }
      : { stdin: { contents: entry.planted, resolveDir: join(ROOT, borders.folder, "src"), loader: "ts" as const } }),
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    conditions: ["ohmail-source"],
    external: outside,
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map(slashed).sort();
}

/** The inputs of the package's bundle that its borders refuse; empty when the borders hold. */
export function refusedInputs(borders: Borders, inputs: readonly string[]): string[] {
  const own = `${borders.folder}/src/`;
  const libraries = (borders.neverLibraries ?? []).map((name) => `node_modules/${name}/`);
  return inputs.filter((input) => {
    if ((borders.neverEndings ?? []).some((ending) => input.endsWith(ending))) return true;
    if (libraries.some((library) => input.includes(library))) return true;
    if (input.includes("node_modules/") || input === "<stdin>") return false;
    return !input.startsWith(own);
  });
}

/** Every file of the package, bundled: `inputs` is what the bundle holds, `refused` what it may not. */
export async function readBorders(borders: Borders): Promise<{ inputs: string[]; refused: string[] }> {
  const files = sourceFiles(join(ROOT, borders.folder, "src")).map((file) => slashed(relative(ROOT, file)));
  const inputs = await inputsOf(borders, { files });
  return { inputs, refused: refusedInputs(borders, inputs) };
}

/** The same reading over one planted file, written as if it stood in the package's `src`. */
export async function readPlanted(borders: Borders, planted: string): Promise<{ inputs: string[]; refused: string[] }> {
  const inputs = await inputsOf(borders, { planted });
  return { inputs, refused: refusedInputs(borders, inputs) };
}
