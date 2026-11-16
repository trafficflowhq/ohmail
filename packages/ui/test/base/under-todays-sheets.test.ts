/**
 * TODAY'S SHEETS REACH NOTHING THE KIT DRAWS, IN A REAL BROWSER. A screen of the new design stands in the
 * product's document, which also loads today's sheets (`@ohmail/ui`'s own entry: today's tokens, its base sheet
 * and every component sheet of today's) and puts `mo-canvas` on the body. A rule of theirs that is unlayered
 * wins over the kit's layer whatever its specificity, so an element rule of today's (`kbd`, `button`, `h1`, `p`,
 * `input`, `:focus-visible`) would draw a key hint at rest, strip an ink button of its fill, or ring a focused
 * control in today's colour.
 *
 * Every state the comparison draws, of the three entries, is laid out twice in Chromium: under the kit's sheets
 * alone, and under today's beside them with the product's body class. Every element computes the same, and so
 * does the ring of every control the keys reach. Both orders are read: today's sheets before the kit's, and after
 * them (with the design's values said once more last, as the screen's root does, so that only today's rules and
 * not its values for a shared name are what is read).
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { DEVICES, entryCss, type Entry, type KitSubject, type Look } from "../compare/harness.js";
import { subjects as baseSubjects } from "../compare/subjects/base.js";
import { subjects as calendarSubjects } from "../compare/subjects/calendar.js";
import { subjects as mailSubjects } from "../compare/subjects/mail.js";

const ROOT = process.cwd();
const require_ = createRequire(resolve(ROOT, "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

async function cssOf(entry: string): Promise<string> {
  const out = await build({
    entryPoints: [resolve(ROOT, entry)],
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

const ENTRIES: Record<Entry, KitSubject[]> = {
  base: baseSubjects,
  mail: mailSubjects,
  calendar: calendarSubjects,
};
const LOOK: Look = { face: "paper", scheme: "light", device: "desktop" };

/** Every state of an entry, each in its own box, inside the new design's root. */
function partsOf(subjects: KitSubject[], look: Look): string {
  return subjects
    .map((s) => {
      let markup = "";
      try {
        markup = renderToStaticMarkup(s.render(look));
      } catch {
        return "";
      }
      return `<section data-key="${s.key}" style="position:relative;display:block;width:${s.width ?? 600}px">${markup}</section>`;
    })
    .join("\n");
}

type Order = "alone" | "today-first" | "today-after";

function documentOf(order: Order, kit: string, today: string, tokens: string, parts: string, look: Look) {
  const root = Object.entries({
    "data-face": look.face,
    "data-scheme": look.scheme,
    ...DEVICES[look.device].root,
    "data-icons": "1",
    "data-rm": "1",
  })
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const sheets = order === "alone" ? [kit] : order === "today-first" ? [today, kit] : [kit, today, tokens];
  return `<!doctype html><html lang="en"${root}><head><meta charset="utf-8">
${sheets.map((s) => `<style>${s}</style>`).join("\n")}</head>
<body${order === "alone" ? "" : ' class="mo-canvas"'}><div class="oh-root">${parts}</div></body></html>`;
}

interface Read {
  styles: { at: string; style: Record<string, string> }[];
  rings: { at: string; style: Record<string, string> }[];
}

/** Every element's computed values, and the ring of each of the first controls the keys reach. */
async function readAt(html: string, look: Look): Promise<Read> {
  const [width, height] = DEVICES[look.device].window;
  const tab = await browser!.newPage({ viewport: { width, height } });
  try {
    await tab.setContent(html, { waitUntil: "load" });
    /* A part that rises as it opens is read where it comes to rest. */
    await tab.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    const styles = await tab.evaluate(() => {
      const keyOf = (el: Element) =>
        `${el.closest("[data-key]")?.getAttribute("data-key") ?? "?"} ${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").trim().replace(/\s+/g, ".")}`;
      return [...document.querySelectorAll<Element>(".oh-root *")].map((el, i) => {
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of Array.from(cs))
          if (!prop.startsWith("--")) style[prop] = cs.getPropertyValue(prop);
        /* Selected words inside a part: the background only (Chromium's computed ink of a selection is
           unreliable). A bare box that holds a part (the staging's own) is the screen's, and keeps today's. */
        if (el.closest(':is([class^="oh-"], [class*=" oh-"]):not(.oh-root)'))
          style["::selection background-color"] = getComputedStyle(el, "::selection").backgroundColor;
        return { at: `${i} ${keyOf(el)}`, style };
      });
    });
    const rings: Read["rings"] = [];
    for (let i = 0; i < 60; i++) {
      await tab.keyboard.press("Tab");
      const ring = await tab.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of [
          "outline-style",
          "outline-width",
          "outline-color",
          "outline-offset",
          "border-top-left-radius",
          "box-shadow",
          "background-color",
        ])
          style[prop] = cs.getPropertyValue(prop);
        return {
          at: `${el.closest("[data-key]")?.getAttribute("data-key") ?? "?"} ${el.tagName.toLowerCase()}`,
          style,
        };
      });
      if (ring) rings.push(ring);
    }
    return { styles, rings };
  } finally {
    await tab.close();
  }
}

/** What an element computes otherwise beside today's sheets: `<index> <state> <tag.class> { prop: alone -> beside }`. */
function differences(alone: Read, beside: Read): string[] {
  const out: string[] = [];
  const pairs = [
    [alone.styles, beside.styles, ""],
    [alone.rings, beside.rings, "keys on "],
  ] as const;
  for (const [a, b, said] of pairs) {
    if (a.length !== b.length) out.push(`${said}the tree differs: ${a.length} against ${b.length}`);
    a.forEach((x, i) => {
      const y = b[i];
      if (!y || y.at !== x.at) return;
      for (const [prop, value] of Object.entries(x.style))
        if (y.style[prop] !== value) out.push(`${said}${x.at} { ${prop}: ${value} -> ${y.style[prop]} }`);
    });
  }
  return out;
}

let browser: Awaited<ReturnType<typeof launch>> | null = null;
let TODAY = "";
let TOKENS = "";
beforeAll(async () => {
  [TODAY, TOKENS] = await Promise.all([
    cssOf("packages/ui/src/index.ts"),
    cssOf("packages/tokens/src/design/tokens.css"),
  ]);
  browser = await launch(chromium);
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe("the kit's parts under every sheet of today's", () => {
  for (const entry of ["base", "mail", "calendar"] as Entry[]) {
    it(`${entry}: every state computes as under the kit's sheets alone, today's sheets before the kit's or after them`, async () => {
      const kit = await entryCss(entry);
      const parts = partsOf(ENTRIES[entry], LOOK);
      const alone = await readAt(documentOf("alone", kit, TODAY, TOKENS, parts, LOOK), LOOK);
      expect(alone.styles.length).toBeGreaterThan(200);
      expect(alone.rings.length).toBeGreaterThan(20);
      for (const order of ["today-first", "today-after"] as Order[]) {
        const beside = await readAt(documentOf(order, kit, TODAY, TOKENS, parts, LOOK), LOOK);
        expect(differences(alone, beside).slice(0, 40), order).toEqual([]);
      }
    }, 240_000);
  }

  it("today's views that a screen of the new design stands inside its root keep today's key, ring, resets and selection", async () => {
    const views = `<kbd>c</kbd><button type="button">Compose</button><h2>Ohbox</h2><p>Three new</p><input value="a">`;
    const probe = async (html: string) => {
      const tab = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await tab.setContent(
          `<!doctype html><html lang="en"><head><style>${TODAY}</style></head>${html}</html>`,
        );
        return await tab.evaluate(() =>
          [...document.querySelectorAll("[data-views] > *")].map((el) => {
            const cs = getComputedStyle(el);
            return [
              cs.fontFamily,
              cs.borderTopWidth,
              cs.backgroundColor,
              cs.marginTop,
              cs.paddingLeft,
              cs.textAlign,
              getComputedStyle(el, "::selection").backgroundColor,
            ].join(" | ");
          }),
        );
      } finally {
        await tab.close();
      }
    };
    const today = await probe(`<body class="mo-canvas"><div data-views>${views}</div></body>`);
    expect(today).toHaveLength(5);
    for (const inside of [
      `<body class="mo-canvas today"><div class="oh-root"><div class="today" data-views>${views}</div></div></body>`,
      `<body class="mo-canvas"><div class="oh-root" data-views>${views}</div></body>`,
      /* As the frame stands them: its columns, then today's view, no part of the kit between. */
      `<body class="mo-canvas"><div class="oh-root"><div class="fr-columns"><div class="fr-wide"><div class="today" data-views>${views}</div></div></div></div></body>`,
    ])
      expect(await probe(inside)).toEqual(today);
  }, 120_000);

  it("CONTROL: an unlayered element rule of today's kind is read", async () => {
    const kit = await entryCss("base");
    const parts = partsOf(
      baseSubjects.filter((s) => s.key.startsWith("KeyHint/")),
      LOOK,
    );
    const alone = await readAt(documentOf("alone", kit, TODAY, TOKENS, parts, LOOK), LOOK);
    const planted = await readAt(
      documentOf("today-first", kit, `${TODAY}\nkbd{letter-spacing:3px}`, TOKENS, parts, LOOK),
      LOOK,
    );
    expect(differences(alone, planted).some((s) => s.includes("letter-spacing"))).toBe(true);
  }, 120_000);

  it("CONTROL: a scheme today's sheets say of the document is read on the kit's parts", async () => {
    const kit = await entryCss("base");
    const parts = partsOf(
      baseSubjects.filter((s) => s.key.startsWith("KeyHint/")),
      LOOK,
    );
    const alone = await readAt(documentOf("alone", kit, TODAY, TOKENS, parts, LOOK), LOOK);
    const planted = await readAt(
      documentOf("today-first", kit, `${TODAY}\n.mo-canvas{color-scheme:dark}`, TOKENS, parts, LOOK),
      LOOK,
    );
    expect(differences(alone, planted).some((s) => s.includes("color-scheme"))).toBe(true);
  }, 120_000);
});
