import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";

/**
 * Today's shell at the three widths its layout turns at: the phone's edge (700), the two-pane band (821)
 * and the last width before the desktop (1023). The page is the one the width ladder's geometry test
 * measures (`apps/webapp/test/width-ladder-geometry.test.tsx`): the shipped cascade over the shell's own
 * shapes. It leaves with the old shell.
 */

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade the shell renders under, in the order the app loads it. */
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/rail.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/reader.css",
  "packages/ui/src/primitives/waterline.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/shell/column-handles.css",
];

const page = (): string => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHEETS.map(css).join("\n")}</style>
<style>html,body{margin:0;height:100%}</style></head>
<body class="mo-canvas"><div class="app-root"><div class="shell">
  <div class="topbar"><button type="button" class="tb-btn">Menu</button><b>Ohbox</b><button type="button" class="tb-btn">Find</button></div>
  <div class="deck">
    <nav class="rail" aria-label="Main"><div class="wordmark"><b><em>oh</em>mail</b></div><div class="rgroup"><button type="button" class="ritem on">Ohbox</button></div></nav>
    <main class="stage"><section class="view split view-ohbox">
      <div class="list-col"><div class="vhead"><h1>Ohbox</h1></div><div class="scroller"><div class="rows"></div></div></div>
      <div class="read-col" role="region" aria-label="Open message" tabindex="-1">
        <button type="button" class="read-col-close" aria-label="Close"></button>
        <article class="msg"><h2>A subject</h2><p>Body</p></article>
      </div>
    </section></main>
  </div>
</div></div></body></html>`;

export const subjects: Subject[] = [700, 821, 1023].map((width) => ({
  key: `own:geometry@${width}`,
  open: async (p) => { await p.setContent(page()); },
}));
