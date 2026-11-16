/**
 * The picture harness: one part of the kit, drawn alone, the way its reference was taken.
 *
 * A part is props in and markup out, so a state is a static render: `renderToStaticMarkup` into a
 * page that carries the design's values, the entry's stylesheets in their import order and the
 * typefaces, with the root attributes of the look it is drawn in. No script runs in that page. A
 * state a pointer or a key makes is made on the real node (`act`).
 *
 * What is compared is the part, not the page: the scene is cut to the part's own box, and the picture
 * is cut to the size the reference was. The window, the scale and the scheme come from the reference.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { build } from "esbuild";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decode, encode } from "../../../../test/compare/png.mjs";
import { shoot } from "../../../../test/compare/render.mjs";
import type { Scene, Variant } from "../../../../test/compare/scene.d.mts";
import { cutScene, folded, readAlone } from "./cut.mjs";
import { LOOKS } from "./reference.mjs";

export { BASELINE, LOOKS, looksOf, referenceKey, stateKey } from "./reference.mjs";
export type { StateRow } from "./reference.d.mts";

export type Entry = "base" | "mail" | "calendar";
export const ENTRIES: readonly Entry[] = ["base", "mail", "calendar"];

export type Face = "paper" | "ohmarchy";
export type Scheme = "light" | "dark";
export type Device = "desktop" | "phone" | "fold" | "foldl";

/** What a state is drawn in. */
export interface Look {
  face: Face;
  scheme: Scheme;
  device: Device;
}

/** The sheet's four sizes: the window a part that stands in the window is drawn in, and what the root says. */
export const DEVICES: Record<Device, { window: [number, number]; root: Record<string, string> }> = {
  desktop: { window: [1440, 900], root: { "data-device": "desktop", "data-touch": "0" } },
  phone: { window: [390, 844], root: { "data-device": "phone", "data-touch": "1" } },
  fold: { window: [719, 781], root: { "data-device": "fold", "data-touch": "1" } },
  foldl: { window: [841, 673], root: { "data-device": "fold", "data-touch": "1", "data-pose": "land" } },
};

/** A look by its id, `<face>-<scheme>-<device>`: the tail of a reference's file name. */
export function lookOf(id: string): Look {
  if (!LOOKS.includes(id)) throw new Error(`harness: "${id}" is no look (<face>-<scheme>-<device>)`);
  const [face, scheme, device] = id.split("-") as [Face, Scheme, Device];
  return { face, scheme, device };
}

/** How a part is held while it is drawn. */
export interface KitSubject {
  /** `<Component>/<state>`, the row of `states.json` this draws. */
  key: string;
  /** The state, from props alone. */
  render(look: Look): ReactNode;
  /**
   * `cell` (the default): in a row, as the sheet's specimen cell holds it. `block`: as a block, `width`
   * wide. `window`: alone in the device's window, where it keeps its own place (an overlay).
   */
  place?: "cell" | "block" | "window";
  /** The stage's width in CSS pixels, where the sheet gives the part a column. A block without one is as wide as its reference. */
  width?: number;
  /**
   * What the part stands on: the ground (the default) or a sheet. The page's body is painted so, as the
   * sheet paints its own: hidden while the part is read alone, so a part's fill of the same colour is read.
   * `screen`: a screen of the app's own, which paints the ground on the root, the window's canvas.
   */
  on?: "ground" | "sheet" | "screen" | ((look: Look) => "ground" | "sheet");
  /** Further root attributes of this state, without the `data-` (`{ icons: "0", product: "cal" }`). */
  root?: Record<string, string>;
  /** The node that is compared, as a selector inside the stage. Left out: everything the stage holds. */
  target?: string;
  /** A state a pointer or a key makes: made on the real node, after the page is drawn. */
  act?(page: Page): Promise<void>;
}

/** A reference's data file: the scene cut to the part, and what the picture shows of it. */
export interface KitReference extends Scene {
  component: string;
  state: string;
  look: string;
  /** How the part was held: its boxes are from the part's own corner, or from the window's. */
  place: "cell" | "block" | "window";
  /** The part's box in the window it was drawn in, and the part of the window the picture shows. */
  target: Box;
  clip: Box;
  studioCommit: string;
}

export type Box = [x: number, y: number, width: number, height: number];

const ROOT = process.cwd();
const TOKENS = "packages/tokens";

async function bundleCss(file: string): Promise<string> {
  const out = await build({
    entryPoints: [file],
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

const sheets = new Map<Entry, Promise<string>>();
/** The design's values and the entry's stylesheets, in the order the entry imports them. */
export function entryCss(entry: Entry): Promise<string> {
  if (!sheets.has(entry)) sheets.set(entry, bundleCss(resolve(ROOT, `packages/ui/src/${entry}/index.ts`)));
  return sheets.get(entry)!;
}

let faces: Promise<string> | null = null;
/**
 * The typefaces, as the tokens package declares them, their files inlined. Without them a page draws
 * every word in another face and no box is where it belongs, so their absence refuses: it is never a
 * skip. `KIT_FONTS_FROM` names another copy of the tokens package while the files are not in this one.
 */
export function fontsCss(): Promise<string> {
  faces ??= (async () => {
    const from = [resolve(ROOT, TOKENS), process.env.KIT_FONTS_FROM]
      .filter((d): d is string => !!d)
      .map((d) => resolve(d, "src/design/fonts.css"));
    const file = from.find((f) => existsSync(f));
    if (!file)
      throw new Error(
        `harness: the typefaces are not here (${from.join(", ")}); name a tokens package that has them with KIT_FONTS_FROM`,
      );
    return bundleCss(file);
  })();
  return faces;
}

const attributes = (map: Record<string, string>): string =>
  Object.entries(map)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`)
    .join("");

/** The stage a part is held on: the sheet's own cell, a block, or the window itself. */
function stageStyle(subject: KitSubject, wide?: number): string {
  if (subject.place === "window") return "min-height:100vh";
  /* A block without a width of its own is as wide as its reference stood. */
  const given = subject.width ?? (subject.place === "block" ? wide : undefined);
  const width = given ? `width:${given}px;` : "width:max-content;max-width:100%;";
  if (subject.place === "block") return `display:block;${width}`;
  return `display:flex;align-items:center;gap:8px;min-height:24px;${width}`;
}

/** The page one state is drawn in. It loads nothing from an address and runs no script. */
export async function pageOf(entry: Entry, subject: KitSubject, look: Look, wide?: number): Promise<string> {
  const root = {
    "data-face": look.face,
    "data-scheme": look.scheme,
    ...DEVICES[look.device].root,
    "data-icons": "1",
    "data-rm": "1",
    ...Object.fromEntries(Object.entries(subject.root ?? {}).map(([k, v]) => [`data-${k}`, v])),
  };
  /* A block nearly as wide as the window keeps less room at its sides, so the page never scrolls sideways. */
  const held = subject.width ?? (subject.place === "block" ? wide : undefined);
  const side = Math.max(0, Math.min(PAD, Math.floor((DEVICES[look.device].window[0] - (held ?? 0)) / 2)));
  const pad = subject.place === "window" ? "0" : `${PAD}px ${side}px`;
  const on = typeof subject.on === "function" ? subject.on(look) : subject.on;
  const paint =
    on === "screen"
      ? "html.oh-root{background:var(--ground)}"
      : `html.oh-root{background:none}body{background:var(--${on === "sheet" ? "sheet" : "ground"})}`;
  return `<!doctype html><html lang="en" class="oh-root"${attributes(root)}><head><meta charset="utf-8">
<style>${await fontsCss()}</style>
<style>${await entryCss(entry)}</style>
<style>html,body{margin:0}body{padding:${pad}}${paint}</style></head>
<body><div data-stage style="${stageStyle(subject, wide)}">${renderToStaticMarkup(subject.render(look))}</div></body></html>`;
}

/** The box around everything `selector` names, in the page: run inside it. */
export function boxOf(selector: string): Box | null {
  const round = (n: number): number => Math.round(n * 10000) / 10000;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  return x1 > x0 && y1 > y0 ? [round(x0), round(y0), round(x1 - x0), round(y1 - y0)] : null;
}

/** Resolves once the page's typefaces are in and every move that ends has ended: run inside the page. */
export async function stood(): Promise<void> {
  /* Every declared face, as the reference's capture loads them: a page that sets no words in a face still has it. */
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => null)));
  await document.fonts.ready;
  const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()));
  await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      .map((a) => a.finished.catch(() => null)),
  );
  await frame();
  await frame();
}

/** The part of the window a box takes, in whole CSS pixels. */
export function clipOf(target: Box, window: [number, number]): Box {
  const x = Math.max(0, Math.floor(target[0])),
    y = Math.max(0, Math.floor(target[1]));
  return [
    x,
    y,
    Math.min(window[0], Math.ceil(target[0] + target[2])) - x,
    Math.min(window[1], Math.ceil(target[1] + target[3])) - y,
  ];
}

/** `clip` of a picture taken at `scale`. What lies outside the picture comes back empty, so it reads as different. */
export function cutPicture(png: Uint8Array, clip: Box, scale: number): Buffer {
  const from = decode(png);
  const [x, y, w, h] = clip.map((n) => Math.round(n * scale)) as Box;
  if (w <= 0 || h <= 0) throw new Error(`harness: nothing to cut, the box is ${clip.join(" ")}`);
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= from.height) continue;
    const sx0 = Math.max(0, x),
      sx1 = Math.min(from.width, x + w);
    if (sx1 > sx0)
      data.set(
        from.data.subarray((sy * from.width + sx0) * 4, (sy * from.width + sx1) * 4),
        (row * w + (sx0 - x)) * 4,
      );
  }
  return encode({ width: w, height: h, data });
}

const STAGE = "[data-stage]";
/** The room around the stage, in CSS pixels. */
const PAD = 25;
const fraction = (n: number): number => n - Math.floor(n);

/**
 * A state drawn with motion on, as the sheet draws its specimens: `{ ...moving, act }`. The comparison's
 * browser asks for reduced motion, under which a press does not move at all.
 */
export const moving = (act: (page: Page) => Promise<void>): Pick<KitSubject, "act" | "root"> => ({
  root: { rm: "0" },
  act: async (page) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await act(page);
  },
});

/**
 * Puts the node `selector` names into the states a pointer or a key would: `hover`, `active`, `focus`,
 * `focus-visible`, `focus-within`. The browser is told, no pointer moves, so a press is drawn without the
 * hover a real pointer brings with it, the way the sheet shows each state on its own.
 */
export function force(
  selector: string,
  ...states: ("hover" | "active" | "focus" | "focus-visible" | "focus-within")[]
): (page: Page) => Promise<void> {
  return async (page) => {
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `${STAGE} ${selector}`,
    });
    if (!nodeId) throw new Error(`harness: nothing to put into ${states.join(" ")} at "${selector}"`);
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: states });
  };
}

/**
 * Draws one state of the kit as its reference was drawn, and cuts both readings to the part.
 * The picture is cut to the reference's size from the part's own corner, so a box that is off by a
 * pixel is a finding about the box and the pictures can still be laid over each other. `plain` names
 * the part's nodes the reference draws as plain boxes (declared): they are read so.
 */
export async function draw(
  browser: Browser,
  entry: Entry,
  subject: KitSubject,
  reference: KitReference,
  plain: string[] = [],
): Promise<{ png: Buffer; scene: Scene; target: Box }> {
  const look = lookOf(reference.look);
  const variant: Variant = reference.variant;
  const html = await pageOf(entry, subject, look, reference.target[2]);
  const selector = subject.target ? `${STAGE} ${subject.target}` : `${STAGE} > *`;
  let target: Box | null = null;
  /* The part read alone: words no node holds have no box to cut the page's reading by. */
  let alone: Scene | null = null;
  const drew = await shoot(browser, variant, async (page) => {
    await page.setContent(html, { waitUntil: "load" });
    /* A part that keeps its own place in the window stands where its reference stood, as the app sets it at its anchor. */
    if (subject.place === "window" && reference.place !== "window") {
      await page.evaluate(
        ([at, left, top]) => {
          const el = document.querySelector<HTMLElement>(at);
          if (el) {
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
          }
        },
        [selector, reference.target[0], reference.target[1]] as const,
      );
    }
    if (subject.act) await subject.act(page);
    await page.evaluate(stood);
    target = await page.evaluate(boxOf, selector);
    /* The part is set on the same fraction of a pixel as its reference stood on, so the two pictures can be laid over each other. */
    const off = (k: 0 | 1): number => (target ? fraction(reference.target[k]) - fraction(target[k]) : 0);
    if (reference.place !== "window" && (Math.abs(off(0)) > 0.001 || Math.abs(off(1)) > 0.001)) {
      await page.evaluate(
        ([top, left]) => {
          document.body.style.padding = `${top}px ${left}px`;
        },
        [PAD + off(1), PAD + off(0)],
      );
      await page.evaluate(stood);
      target = await page.evaluate(boxOf, selector);
    }
    alone = await readAlone(page, variant, { root: STAGE, selector: subject.target ?? null, plain });
  });
  if (!target || !alone) throw new Error(`harness: ${subject.key} drew nothing at "${selector}"`);
  const at: Box = target;
  const window: Box =
    reference.place === "window"
      ? reference.clip
      : [Math.floor(at[0]), Math.floor(at[1]), reference.clip[2], reference.clip[3]];
  return {
    png: cutPicture(drew.png, window, variant.scale),
    scene: cutScene(folded(alone), at, reference.place),
    target: at,
  };
}
