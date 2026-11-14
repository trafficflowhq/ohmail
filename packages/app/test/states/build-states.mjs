#!/usr/bin/env node
/**
 * The frame's states page as one HTML document: the page bundled with its stylesheets, under BOTH designs'
 * token sheets as the product page loads them (the old sheets, then the new through the kit), so the seam
 * is read as it stands in the app. `statesPage()` returns the document; run alone, it writes it to the path
 * given (a comparison subject sets it as the page's content, with the state in the address).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** Today's token sheets, which the product page still loads before the kit's. */
const OLD = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
];
const sheetsUnder = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "base"
        ? []
        : sheetsUnder(`${dir}/${e.name}`)
      : e.name.endsWith(".css")
        ? [`${dir}/${e.name}`]
        : [],
  );
/** Today's views' own sheets, which the product page loads beside the frame's: the frame's states are read under them. */
const TODAY = () => [
  ...sheetsUnder("packages/ui/src"),
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
  "apps/webapp/app/shell/today.css",
  "apps/webapp/app/shell/today-tokens.generated.css",
];
const sheet = (file) => readFileSync(join(ROOT, file), "utf8").replace(/@import[^;]+;/g, "");

/**
 * The typefaces with their files inlined, as the kit's comparison harness reads them: from the tokens package,
 * or from the copy `KIT_FONTS_FROM` names while the files are not in this one. Without them every word is drawn
 * in another face, so their absence refuses.
 */
async function faces() {
  const from = [join(ROOT, "packages/tokens"), process.env.KIT_FONTS_FROM]
    .filter(Boolean)
    .map((d) => join(d, "src/design/fonts.css"));
  const file = from.find((f) => existsSync(f));
  if (!file)
    throw new Error(
      `states page: the typefaces are not here (${from.join(", ")}); name a tokens package that has them with KIT_FONTS_FROM`,
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

export async function statesPage() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["packages/app/test/states/states-page.tsx"],
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
<style>${await faces()}</style><style>${old}</style><style>${text(".css")}</style><style>${TODAY().map(sheet).join("\n")}</style>
<style>html,body,#root{margin:0;height:100%}.st-pane{flex:1;min-height:0;border-radius:var(--r-sheet);background:var(--sheet)}.st-fill{flex:1;min-height:0}.st-column{flex:1;min-height:0;overflow:auto;border-radius:0 0 var(--r-sheet) var(--r-sheet)}.st-phone{flex:1;min-height:0;margin-top:64px;border-radius:var(--r-sheet) var(--r-sheet) 0 0;background:var(--sheet);overflow-y:auto;scrollbar-width:none}.st-rows{height:calc(100% + 1px)}</style>
</head><body class="today"><div id="root"></div><script type="module">${text(".js").replace(/<\/script/g, "<\\/script")}</script></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const to = process.argv[2];
  if (!to) throw new Error("usage: build-states.mjs <out.html>");
  writeFileSync(to, await statesPage());
}
