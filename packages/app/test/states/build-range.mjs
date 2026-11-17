#!/usr/bin/env node
/**
 * The range views' states page as one HTML document: `range-page.tsx` bundled with its stylesheets (the kit's and
 * the views' own, through their imports), under the design's tokens and its typefaces. `rangePage()` returns it.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

async function faces() {
  const file = [join(ROOT, "packages/tokens"), process.env.KIT_FONTS_FROM]
    .filter(Boolean)
    .map((d) => join(d, "src/design/fonts.css"))
    .find((f) => existsSync(f));
  if (!file)
    throw new Error(
      "range page: the typefaces are not here; name a tokens package that has them with KIT_FONTS_FROM",
    );
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    outdir: "out",
    logLevel: "silent",
    loader: { ".woff2": "dataurl" },
  });
  return out.outputFiles.map((f) => f.text).join("\n");
}

export async function rangePage() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["packages/app/test/states/range-page.tsx", "packages/tokens/src/design/tokens.css"],
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
    result.outputFiles
      .filter((f) => f.path.endsWith(ending))
      .map((f) => f.text)
      .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${await faces()}</style><style>${text(".css")}</style>
<style>html,body,#root{margin:0;height:100%}body{background:var(--ground)}</style>
</head><body><div id="root"></div><script type="module">${text(".js").replace(/<\/script/g, "<\\/script")}</script></body></html>`;
}
