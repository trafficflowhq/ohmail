#!/usr/bin/env node
/**
 * The reader's states page as one HTML document, built as the frame's states page is (`build-states.mjs`): the page
 * bundled with its stylesheets (the body's own among them), under both designs' token sheets as the product page
 * loads them, with the typefaces inlined. Run alone, it writes the document to the path given.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OLD = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
];

async function faces() {
  const from = [join(ROOT, "packages/tokens"), process.env.KIT_FONTS_FROM]
    .filter(Boolean)
    .map((d) => join(d, "src/design/fonts.css"));
  const file = from.find((f) => existsSync(f));
  if (!file)
    throw new Error(
      `reader states page: the typefaces are not here (${from.join(", ")}); name a tokens package that has them with KIT_FONTS_FROM`,
    );
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    outdir: "out",
    logLevel: "silent",
    loader: { ".woff2": "dataurl" },
  });
  return out.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n");
}

/** The page of `entry` (the reader's states by default; `linkask-page.ts` for the ask page). */
export async function readerStatesPage(entry = "packages/app/test/states/reader-page.tsx") {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
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
  const old = OLD.map((file) => readFileSync(join(ROOT, file), "utf8")).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${await faces()}</style><style>${old}</style><style>${text(".css")}</style>
<style>html,body,#root{margin:0;height:100%}.st-pane{flex:1;min-height:0;overflow:hidden;border-radius:var(--r-sheet);background:var(--sheet)}</style>
</head><body class="today"><div id="root"></div><script type="module">${text(".js").replace(/<\/script/g, "<\\/script")}</script></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const to = process.argv[2];
  if (!to) throw new Error("usage: reader-states.mjs <out.html>");
  writeFileSync(to, await readerStatesPage());
}
