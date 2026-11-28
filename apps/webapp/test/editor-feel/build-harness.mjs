#!/usr/bin/env node
/**
 * Bundle `harness.tsx` into `build/editor-feel/` — the ignored build tree, never under `src`
 * (an esbuild bundle carries every module's absolute path). The alias is the desktop's own:
 * the shared shell imports `next-intl`, which IS `use-intl` plus Next's server plumbing, and a
 * page with no Next resolves it to `use-intl` exactly as `apps/desktop/vite.config.ts` does.
 *
 *   node apps/webapp/test/editor-feel/build-harness.mjs [--out <dir>]   → prints the html path
 *
 * `--out` (or EDITOR_FEEL_OUT) builds elsewhere — a mutation arm builds its mutated bundle beside,
 * never over, the one a guest cell may be copying.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(repo, argOut >= 0 ? process.argv[argOut + 1] : (process.env.EDITOR_FEEL_OUT ?? "build/editor-feel"));
const useIntl = resolve(repo, "apps/desktop/node_modules/use-intl");
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
  alias: {
    "next-intl": resolve(here, "intl-shim.mjs"),
    "use-intl/core": resolve(useIntl, "dist/esm/core.js"),
    "use-intl": useIntl,
  },
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".json": "json", ".css": "css", ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  logLevel: "warning",
});

writeFileSync(
  resolve(out, "harness.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>editor-feel harness</title>
<link rel="stylesheet" href="./harness.css">
<style>
  body { margin: 16px; background: #fff; }
  /* The probe square: a pure-magenta 12px block ABOVE the editor, so a framebuffer read can find
     the page's origin without asking the window manager where the window is. */
  #probe { width: 12px; height: 12px; background: #ff00ff; margin-bottom: 8px; }
  /* Painted carets are counted by colour: pure red is a colour the stylesheet never uses. */
  .rte-surface { caret-color: #ff0000; }
</style></head>
<body><div id="probe"></div><div id="root"></div><script src="./harness.js"></script></body></html>
`,
);
console.log(resolve(out, "harness.html"));
