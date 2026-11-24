#!/usr/bin/env node
/**
 * The step-up dialog's browser harness as one HTML document (`step-up-harness.tsx`, bundled with the sheets its
 * imports bring). Run alone, it writes the document to its output; a browser case sets it as a page's content (the
 * bundler does not run in jsdom).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export async function stepUpHarness() {
  const out = await build({
    absWorkingDir: ROOT,
    entryPoints: ["packages/app/test/doors/step-up-harness.tsx"],
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "browser",
    conditions: ["ohmail-source"],
    jsx: "automatic",
    loader: { ".woff2": "dataurl", ".svg": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const text = (ending) =>
    out.outputFiles
      .filter((f) => f.path.endsWith(ending))
      .map((f) => f.text)
      .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${text(".css")}</style></head>
<body><div id="root"></div><script type="module">${text(".js").replace(/<\/script/g, "<\\/script")}</script></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(await stepUpHarness());
