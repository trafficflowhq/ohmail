#!/usr/bin/env node
/**
 * Bundle `harness-reader-1.tsx` (the letter's body as the new reader mounts it) into `build/reader-frame-reader-1/`
 * (ignored; a bundle carries absolute paths), as `build-harness.mjs` bundles today's pane. The fixtures ride in as
 * `__FIXTURES__`, so the page needs no server and no loader for `.html`.
 *
 *   node apps/webapp/test/reader-frame/build-harness-reader-1.mjs [--out <dir>]   → prints the html path
 *
 * `--out` (or READER_FRAME_READER_OUT) builds a mutation arm's bundle beside the tip's, never over it.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(
  repo,
  argOut >= 0 ? process.argv[argOut + 1] : (process.env.READER_FRAME_READER_OUT ?? "build/reader-frame-reader-1"),
);
mkdirSync(out, { recursive: true });
const fixtures = Object.fromEntries(
  ["wp-report", "rigid", "rigid-abs"].map((n) => [n, readFileSync(resolve(here, `${n}.html`), "utf8")]),
);

await build({
  entryPoints: [resolve(here, "harness-reader-1.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  sourcemap: "inline",
  outfile: resolve(out, "harness.js"),
  banner: { js: "window.process = window.process || { env: {} };" },
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_API_BASE": "undefined",
    __FIXTURES__: JSON.stringify(fixtures),
  },
  loader: { ".json": "json", ".css": "css", ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  logLevel: "warning",
});

writeFileSync(
  resolve(out, "harness.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>reader-frame harness, the new reader</title>
<link rel="stylesheet" href="./harness.css">
<style>html, body { margin: 0; padding: 0; } #col { display: flex; flex-direction: column; }</style></head>
<body><div id="col" class="oh-root"></div><script src="./harness.js"></script></body></html>
`,
);
console.log(resolve(out, "harness.html"));
