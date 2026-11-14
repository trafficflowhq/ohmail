/**
 * THE KIT'S COLOUR SCHEME IS THE CHOSEN ONE UNDER THE FRAME'S STAMP, IN A REAL BROWSER. The design's tokens say
 * `color-scheme` on their light and dark blocks, keyed by the frame's `data-scheme` on the document's root; today's
 * tokens key it by `data-theme` and the system. The browser's own parts (scroll bars, form controls, the native date
 * and time fields) follow it.
 *
 * Under the stamp, every choice (light, dark, the system's) under either system scheme, with today's sheets before
 * the kit's or after them, gives the chosen scheme. A document that loads the kit's tokens WITHOUT the stamp is
 * found here: it gives the wrong one where the kit's blocks and today's disagree. That is why every document of the
 * product that loads the kit's tokens stamps its root before it paints (the frame's `@ohmail/app/frame/boot`), and
 * why the kit lands with the frame or after it, never before.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { entryCss } from "../compare/harness.js";

const ROOT = process.cwd();
const require_ = createRequire(resolve(ROOT, "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

/** Today's sheets, as `@ohmail/ui`'s own entry brings them. */
async function todaysSheets(): Promise<string> {
  const out = await build({
    entryPoints: [resolve(ROOT, "packages/ui/src/index.ts")],
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime"],
    loader: { ".woff2": "dataurl" },
  });
  return out.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n");
}

type Scheme = "light" | "dark";
type Order = "kit-first" | "today-first";
const CHOICES = [null, "light", "dark"] as const;
const SYSTEMS: Scheme[] = ["light", "dark"];
const ORDERS: Order[] = ["kit-first", "today-first"];

let browser: Awaited<ReturnType<typeof launch>> | null = null;
let KIT = "";
let TODAY = "";
beforeAll(async () => {
  [KIT, TODAY] = await Promise.all([entryCss("base"), todaysSheets()]);
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/** The scheme the root and a part of the kit compute, in a document as the product's are: today's body class. */
async function schemeOf(
  choice: Scheme | null,
  system: Scheme,
  order: Order,
  stamp: Scheme | null,
): Promise<{ root: string; part: string }> {
  const attrs = Object.entries({
    "data-theme": choice,
    "data-scheme": stamp,
    "data-device": "desktop",
    "data-touch": "0",
  })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const sheets = order === "kit-first" ? [KIT, TODAY] : [TODAY, KIT];
  const tab = await browser!.newPage({ viewport: { width: 800, height: 600 }, colorScheme: system });
  try {
    await tab.setContent(`<!doctype html><html lang="en"${attrs}><head><meta charset="utf-8">
${sheets.map((s) => `<style>${s}</style>`).join("\n")}</head>
<body class="mo-canvas app-body"><div class="oh-root"><input type="date" value="2026-11-15"></div></body></html>`);
    return await tab.evaluate(() => ({
      root: getComputedStyle(document.documentElement).colorScheme,
      part: getComputedStyle(document.querySelector("input")!).colorScheme,
    }));
  } finally {
    await tab.close();
  }
}

/** Every choice under every system scheme in both orders, as `<choice> under <system>, <order>`. */
const cases = CHOICES.flatMap((choice) =>
  SYSTEMS.flatMap((system) => ORDERS.map((order) => ({ choice, system, order, meant: choice ?? system }))),
);
const said = (c: (typeof cases)[number]) => `${c.choice ?? "system"} under ${c.system}, ${c.order}`;

describe("the colour scheme the kit's parts stand in", () => {
  it("under the frame's stamp it is the chosen one, for every choice, system scheme and order of sheets", async () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const seen = await schemeOf(c.choice, c.system, c.order, c.meant);
      if (seen.root !== c.meant || seen.part !== c.meant)
        wrong.push(`${said(c)}: ${seen.root} / ${seen.part}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("a document that loads the kit's tokens without the stamp is found: a chosen scheme there is not kept", async () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const seen = await schemeOf(c.choice, c.system, c.order, null);
      if (seen.root !== c.meant || seen.part !== c.meant)
        wrong.push(`${said(c)}: ${seen.root} / ${seen.part}`);
    }
    /* What the kit's check saw (CHECK-23): a chosen light under a dark system turns dark, and a chosen dark under a
       light system turns light where today's sheets come first. A document of the product is never left so. */
    expect(wrong).toEqual([
      "light under dark, kit-first: dark / dark",
      "light under dark, today-first: dark / dark",
      "dark under light, today-first: light / light",
    ]);
  }, 120_000);
});
