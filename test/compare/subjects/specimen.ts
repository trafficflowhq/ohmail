import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subject } from "../subject.js";

/**
 * The new design's values, drawn with no letter in sight: its colours, its radii and its gaps, straight
 * from the token sheet, in the light and the dark scheme. No text means no font, so two machines with the
 * same browser draw this page alike; it is the subject that says whether they do.
 */

const COLOURS = ["ground", "sheet", "ink", "ink2", "hot", "hot-ink", "wash", "solid", "soft", "hover", "off", "line", "focus"];
const RADII = ["r-sq", "r-row", "r-sheet", "r-pill"];
const GAPS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

const mark = (name: string, style: string): string => `<i role="img" aria-label="${name}" style="${style}"></i>`;

const page = (scheme: string): string => `<!doctype html><html data-scheme="${scheme}"><head><meta charset="utf-8">
<style>${readFileSync(resolve(process.cwd(), "packages/tokens/src/design/tokens.css"), "utf8")}</style>
<style>html,body{margin:0;background:var(--ground)} main{display:grid;gap:var(--s4);padding:var(--s5)}
section{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--s3)} i{display:block;box-sizing:border-box}</style></head>
<body><main>
<section aria-label="Colours">${COLOURS.map((c) => mark(c, `width:48px;height:48px;background:var(--${c});border:1px solid var(--line)`)).join("")}</section>
<section aria-label="Radii">${RADII.map((r) => mark(r, `width:96px;height:48px;background:var(--hot);border-radius:var(--${r})`)).join("")}</section>
<section aria-label="Gaps">${GAPS.map((s) => mark(s, `padding:var(--${s});background:var(--solid);border-radius:var(--r-sq)`)).join("")}</section>
</main></body></html>`;

export const subjects: Subject[] = ["light", "dark"].map((scheme) => ({
  key: `own:specimen@${scheme}`,
  open: async (p) => { await p.setContent(page(scheme)); },
}));
