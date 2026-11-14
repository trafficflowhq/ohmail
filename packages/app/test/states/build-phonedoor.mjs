#!/usr/bin/env node
/**
 * The phone's ways in's states page as one HTML document: `phonedoor-page.tsx` bundled with the sheets its imports
 * bring (the new design's tokens, the kit's layer, the seam the doors' stage stands on, the pages' placement), under
 * today's sheets as a door's page loads them beside those, as the doors' page
 * is built (`build-doors.mjs`). `phoneDoorPage()` returns the document; run alone, it writes it to the path given.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sheetsUnder = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      e.isDirectory()
        ? e.name === "base"
          ? []
          : sheetsUnder(`${dir}/${e.name}`)
        : e.name.endsWith(".css")
          ? [`${dir}/${e.name}`]
          : [],
    );
/** Today's sheets, unlayered, in the order the product page loads them. */
const TODAY = () => [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  ...sheetsUnder("packages/ui/src"),
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
];
const sheet = (file) => readFileSync(join(ROOT, file), "utf8").replace(/@import[^;]+;/g, "");

/** The typefaces with their files inlined: without them every word is drawn in another face, so their absence refuses. */
async function faces() {
  const file = join(ROOT, "packages/tokens/src/design/fonts.css");
  if (!existsSync(file)) throw new Error(`phone door page: the typefaces are not here (${file})`);
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

export async function phoneDoorPage() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["packages/app/test/states/phonedoor-page.tsx"],
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
<style>${await faces()}</style><style>${text(".css")}</style><style>${TODAY().map(sheet).join("\n")}</style>
</head><body class="mo-canvas app-body today"><div id="root"></div><script type="module">${text(".js").replace(/<\/script/g, "<\\/script")}</script></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const to = process.argv[2];
  if (!to) throw new Error("usage: build-phonedoor.mjs <out.html>");
  writeFileSync(to, await phoneDoorPage());
}
