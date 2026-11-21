#!/usr/bin/env node
/**
 * Bundle `harness.tsx` into `build/list-view-frames/` (ignored; a bundle carries absolute paths).
 *
 *   node apps/webapp/test/list-view-frames/build-harness.mjs [--out <dir>]   → prints the html path
 *
 * `--out` builds a mutation arm's bundle beside the tip's, never over it. The reader-frame rig's
 * shape: esbuild, `next-intl` as `use-intl`, the app's stylesheets bundled beside the script.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(repo, argOut >= 0 ? process.argv[argOut + 1] : "build/list-view-frames");
const useIntl = resolve(repo, "apps/desktop/node_modules/use-intl");
const requireFromDesktop = createRequire(resolve(repo, "apps/desktop/package.json"));
if (!existsSync(useIntl)) {
  console.error(`build-harness: ${useIntl} is absent — install the workspace's dependencies first`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(here, "harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  sourcemap: "inline",
  outfile: resolve(out, "harness.js"),
  alias: { "next-intl": resolve(here, "../editor-feel/intl-shim.mjs"), "use-intl": useIntl, "use-intl/core": requireFromDesktop.resolve("use-intl/core") },
  banner: { js: "window.process = window.process || { env: {} };" },
  define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
  loader: { ".json": "json", ".css": "css", ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file", ".webp": "file" },
  logLevel: "warning",
});

writeFileSync(
  resolve(out, "harness.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>list-view frames</title>
<link rel="stylesheet" href="./harness.css"></head>
<body><div id="app"></div><script src="./harness.js"></script></body></html>
`,
);
console.log(resolve(out, "harness.html"));
