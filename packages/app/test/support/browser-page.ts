/**
 * THE FRAME IN A REAL BROWSER. jsdom has no cascade, so a test draws the frame there, takes its markup and the root's
 * attributes, and lays them out in Chromium under every sheet the product page loads: the new design's first, today's
 * after them, unlayered, as on the product page where both are loaded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const REPO = resolve(__dirname, "../../../..");
export const { chromium } = createRequire(join(REPO, "package.json"))(
  "@playwright/test",
) as typeof import("@playwright/test");

const css = (path: string): string => readFileSync(join(REPO, path), "utf8").replace(/@import[^;]+;/g, "");
const KIT_FIRST = "packages/ui/src/base/base.css";
/** Every sheet under a folder; the kit's first sheet (its layer's name) stands first in the list and once. */
const sheetsUnder = (dir: string): string[] =>
  readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sheetsUnder(`${dir}/${e.name}`)
      : e.name.endsWith(".css") && `${dir}/${e.name}` !== KIT_FIRST
        ? [`${dir}/${e.name}`]
        : [],
  );

export const SHEETS = [
  "packages/tokens/src/design/tokens.css",
  KIT_FIRST,
  "packages/app/src/frame/placement.css",
  "packages/app/src/frame/seam.generated.css",
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  ...sheetsUnder("packages/ui/src"),
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
];

/** The page: the frame's markup under the root's attributes and every sheet, plus what a test adds after them. */
export function pageOf(
  drawn: { html: string; root: string },
  extra = "",
  extraSheets: readonly string[] = [],
): string {
  return `<!doctype html><html ${drawn.root} data-face="paper" data-theme="light"><head><style>${[...SHEETS, ...extraSheets].map(css).join("\n")}
    html, body, body > div { height: 100%; margin: 0 }${extra}</style></head><body class="today">${drawn.html}</body></html>`;
}

/**
 * The page of an entry that mounts in `#root` (the desktop window's `index.html`, the paired page's `host.html`): the
 * frame's own markup in `#root` under the documents' body, and the sheets alone. Nothing here hands a box its height.
 */
export function entryPageOf(drawn: { inner: string; root: string }): string {
  return `<!doctype html><html ${drawn.root} data-face="paper" data-theme="light"><head><style>${SHEETS.map(css).join("\n")}</style></head><body class="mo-canvas app-body today"><div id="root">${drawn.inner}</div></body></html>`;
}
