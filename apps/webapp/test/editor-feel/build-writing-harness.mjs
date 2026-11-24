import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const arg = process.argv.indexOf("--out");
const out = resolve(repo, arg < 0 ? (process.env.EDITOR_FEEL_OUT ?? "build/editor-feel") : process.argv[arg + 1]);
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(here, "writing-harness.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  outfile: resolve(out, "writing.js"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
});

writeFileSync(resolve(out, "writing.html"), `<!doctype html>
<html lang="en" data-face="paper" data-device="desktop"><head><meta charset="utf-8">
<title>Writing</title><link rel="stylesheet" href="./writing.css">
<style>
  body { margin: 16px; background: white; }
  /* The X framebuffer probe finds the window by this square and the caret by its colour. */
  #probe { width: 12px; height: 12px; background: #ff00ff; margin-bottom: 8px; }
  [role="textbox"][contenteditable] { caret-color: #ff0000; }
</style></head>
<body><div id="probe"></div><div id="root" class="oh-root"></div><script src="./writing.js"></script></body></html>`);
