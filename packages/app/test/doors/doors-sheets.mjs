#!/usr/bin/env node
/**
 * The new design's sheets as the doors bring them: what the bundler collects from what the doors' entries import, in
 * their order (the design's tokens and the kit's layer through the kit, the seam through the stage, the doors' own).
 * Run alone, it writes them to its output; a browser case reads them from there (the bundler does not run in jsdom).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Every door's entry: the stage and each page's own. */
const entries = () =>
  readdirSync(join(ROOT, "packages/app/src/doors"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `./packages/app/src/doors/${e.name}/index.ts`);

export async function doorsSheets() {
  const out = await build({
    absWorkingDir: ROOT,
    stdin: {
      contents: entries()
        .map((entry) => `import ${JSON.stringify(entry)};`)
        .join("\n"),
      resolveDir: ROOT,
    },
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "browser",
    conditions: ["ohmail-source"],
    jsx: "automatic",
    loader: { ".woff2": "dataurl", ".svg": "text" },
    logLevel: "silent",
  });
  return out.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(await doorsSheets());
