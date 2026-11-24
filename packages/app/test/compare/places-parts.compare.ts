import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comparePictures,
  compareScenes,
  type PictureReading,
  type Reading,
} from "../../../../test/compare/compare.js";
import { referenceIn } from "../../../../test/compare/fetch.mjs";
import { decode } from "../../../../test/compare/png.mjs";
import type { Picture } from "../../../../test/compare/png.d.mts";
import { fileOf } from "../../../../test/compare/registry.mjs";
import type { Manifest, Registry } from "../../../../test/compare/registry.d.mts";
import { launch, shoot, TOLERANCE } from "../../../../test/compare/render.mjs";
import type { Scene, SceneNode, Variant } from "../../../../test/compare/scene.d.mts";
import { cutScene } from "../../../ui/test/compare/cut.mjs";
import { openPlacesPage } from "../states/places-pages.js";
import { comparedKeys, PLACE_SCREENS } from "../states/places-states.mjs";

/**
 * THE PLACES' PARTS of the eleven screens news to address, each against the same part of the reference's picture and
 * data file (`node test/compare/fetch.mjs --from <the shards>`, then
 * `npx vitest run --config test/compare/vitest.compare.config.ts packages/app/test/compare/places-parts.compare.ts`). The shards
 * are named to the fetch by `test/compare/subjects/<screen>.ts`, the tool's rule; a shard not in build/reference is
 * red here, never a skip, as in the kit's comparison.
 *
 * The reference stands each place between the frame's rail and a reading column. The rail, the dock and what the frame
 * draws around the columns are the frame's (held by `frame-parts`); the reading column of a place that hands it to
 * the reader (the piles, History, Tags, a folder, an address) is the reader's (held by `reader-parts`). What is the
 * place's own is cut out of both sides alike with the kit's `cutScene` and held by the comparison's own four
 * questions, none softened:
 *
 * - the head: the banner at the top of the place's list column, in the window's coordinates;
 * - the list: everything in the list column under the head, from its own corner (its place follows the head's height);
 * - the reading column of News, Receipts, Trash and Drafts, which they draw themselves, in the window's coordinates,
 *   where the window has room for two columns.
 *
 * Words outside every node carry no box in a whole page's data file, so they cannot be cut to a part: they are left
 * out on both sides. The differences that stay are the rows of `places-declared.json` beside this file, each of a
 * class named in its reason: nodes left out of both sides, nodes the reference does not name, a pair of names, or a
 * part a key does not draw; never a whole state. What a part that is not green drew is written to
 * build/compare/places-parts/.
 */

const ROOT = process.cwd();
const COMPARE = resolve(ROOT, "test/compare");
const REFERENCE = resolve(ROOT, "build/reference");
const OUT = resolve(ROOT, "build/compare/places-parts");
const SHARDS: readonly string[] = PLACE_SCREENS;
/** The places that draw their own reading column; the others hand it to the reader. */
const OWN_READING = new Set(["news", "receipts", "trash", "drafts"]);

type Box = [number, number, number, number];
type PartName = "head" | "list" | "reading";
const PARTS: readonly PartName[] = ["head", "list", "reading"];

/** A row of `places-declared.json`. */
interface DeclaredRow {
  keys: string[];
  /** The class of the difference first, then why, so a person can check it against the design. */
  reason: string;
  since: string;
  removedBy: string;
  /** Left out of both sides whole, with what they paint. */
  out?: { role: string; name: string }[];
  /** Nodes the reference does not name: they leave as nodes, and their words and paint stand loose. */
  unnamed?: { role: string; name: string }[];
  /** The reference's node of this role and name reads as `as`: its box, its state and its drawing still bind. */
  pairs?: { role: string; name: string; as: string }[];
  /** What these keys do not draw, said in the reason with the task or the ask that draws it. */
  notDrawn?: PartName[] | "state";
}

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const registry = json<Registry>(join(COMPARE, "registry.json"));
const manifest = json<Manifest>(join(COMPARE, "manifest.json"));
const declared = json<DeclaredRow[]>(resolve(ROOT, "packages/app/test/compare/places-declared.json"));
const KEYS: readonly { key: string; shard: string }[] = SHARDS.flatMap((shard) =>
  comparedKeys(shard).map((key: string) => ({ key, shard })),
);
const ALL_KEYS = new Set(KEYS.map((k) => k.key));

const said = (n: SceneNode): string => `${n.role} "${n.name}"`;
const inside = (box: number[], at: number[], slack = 0.5): boolean =>
  box[0]! >= at[0]! - slack &&
  box[1]! >= at[1]! - slack &&
  box[0]! + box[2]! <= at[0]! + at[2]! + slack &&
  box[1]! + box[3]! <= at[1]! + at[3]! + slack;

/** The reference of one key, read as the tool reads it: its manifest row, both checksums, the shard's files. */
function referenceOf(key: string, shard: string): { variant: Variant; scene: Scene; png: Buffer } {
  const state = registry.states.find((s) => s.key === key);
  const row = manifest.rows.find((r) => r.key === key);
  if (!state || state.screen !== shard) throw new Error(`${key} is not a registered state of ${shard}`);
  if (!row || row.shard !== shard) throw new Error(`${key} has no picture in shard ${shard} (manifest.json)`);
  const at = join(REFERENCE, shard, fileOf(key));
  if (!existsSync(`${at}.png`) || !existsSync(`${at}.json`))
    throw new Error(
      `the reference archive is not in build/reference (shard ${shard}); run: node test/compare/fetch.mjs`,
    );
  const png = readFileSync(`${at}.png`),
    scene = readFileSync(`${at}.json`);
  if (sha256(png) !== row.png.sha256 || sha256(scene) !== row.scene.sha256)
    throw new Error(`${key}: the picture in build/reference is not the one the manifest names`);
  const { scale } = row.png;
  return {
    variant: { ...state.variant, width: row.png.w / scale, height: row.png.h / scale, scale },
    scene: JSON.parse(scene.toString("utf8")) as Scene,
    png,
  };
}

const rowsOf = (key: string): DeclaredRow[] => declared.filter((d) => d.keys.includes(key));

/** A scene with the nodes `gone` names left out as nodes: what they hold of words and paint stands loose. */
function lessNodes(s: Scene, gone: (n: SceneNode) => boolean): Scene {
  const out = s.nodes.filter(gone);
  return {
    ...s,
    nodes: s.nodes.filter((n) => !gone(n)),
    loose: {
      text: [...s.loose.text, ...out.flatMap((n) => n.text ?? [])],
      surfaces: [...s.loose.surfaces, ...out.flatMap((n) => n.surfaces ?? [])],
    },
  };
}

/** The declared rows applied: a row's nodes left out of both sides, its pairs read on the reference's side. */
function declaredOn(key: string, reference: Scene, actual: Scene): { reference: Scene; actual: Scene } {
  const rows = rowsOf(key);
  const holds = (s: Scene, role: string, name: string) =>
    s.nodes.some((n) => n.role === role && n.name === name);
  for (const d of rows) {
    const bites =
      d.notDrawn !== undefined ||
      d.out?.some((o) => holds(reference, o.role, o.name) || holds(actual, o.role, o.name)) ||
      d.unnamed?.some((o) => holds(reference, o.role, o.name) || holds(actual, o.role, o.name)) ||
      d.pairs?.some((p) => holds(reference, p.role, p.name));
    if (!bites) throw new Error(`${key}: the declared row "${d.reason}" names nothing either side holds`);
  }
  const named = (list: "out" | "unnamed") => (n: SceneNode) =>
    rows.some((d) => d[list]?.some((o) => o.role === n.role && o.name === n.name));
  const gone = named("out");
  const loose = named("unnamed");
  const without = (s: Scene): Scene => lessNodes({ ...s, nodes: s.nodes.filter((n) => !gone(n)) }, loose);
  const less = without(reference);
  return {
    reference: {
      ...less,
      nodes: less.nodes.map((n) => {
        const pair = rows.flatMap((d) => d.pairs ?? []).find((p) => p.role === n.role && p.name === n.name);
        return pair ? { ...n, name: pair.as } : n;
      }),
    },
    actual: without(actual),
  };
}

/** A part as each side holds it: the scene cut to its box, and the box its picture is held by. */
interface Part {
  scene: Scene;
  box: Box;
  nodes: SceneNode[];
  /** Its nodes' boxes are from its own corner. */
  fromCorner: boolean;
}

const only = (s: Scene, box: Box, place: "window" | "block" = "window"): Part => {
  const cut = cutScene(s, box, place);
  return {
    scene: { ...cut, loose: { text: [], surfaces: cut.loose.surfaces } },
    box,
    nodes: cut.nodes,
    fromCorner: place !== "window",
  };
};

/**
 * The place's columns on one side: the head is the left-most banner that holds a heading, right of an upright rail;
 * the list column runs from it to the window's foot (to the dock's top where the rail lies along the foot); the
 * reading column is what stands right of it.
 */
function columnsOf(s: Scene): { head: Box; list: Box; reading: Box | null } | null {
  const { width, height } = s.variant;
  const rail = s.nodes.find((n) => n.role === "navigation" && n.name === "Places");
  const upright = rail !== undefined && rail.box[3] > height / 2;
  const left = upright ? rail.box[0] + rail.box[2] : 0;
  const foot = rail !== undefined && !upright ? rail.box[1] : height - (left > 0 ? 12 : 0);
  const heads = s.nodes
    .filter(
      (n) =>
        n.role === "banner" &&
        n.box[0] >= left - 0.5 &&
        s.nodes.some((h) => h.role === "heading" && inside(h.box, n.box, 1)),
    )
    .sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
  const head = heads[0];
  if (!head) return null;
  const [x, y, w, h] = head.box as Box;
  const right = x + w;
  return {
    head: [x, y, w, h],
    list: [x, y + h, w, Math.max(1, foot - y - h)],
    reading: width - right > 240 ? [right + 12, 12, width - right - 24, height - 24] : null,
  };
}

/** Every part of one side. */
function partsOf(s: Scene, shard: string): Map<PartName, Part> {
  const parts = new Map<PartName, Part>();
  const cols = columnsOf(s);
  if (!cols) return parts;
  parts.set("head", only(s, cols.head));
  parts.set("list", only(s, cols.list, "block"));
  if (OWN_READING.has(shard) && cols.reading) parts.set("reading", only(s, cols.reading));
  return parts;
}

/** A box of a picture, in CSS pixels, at the given size. */
function crop(p: Picture, box: Box, size: [number, number], scale: number): Picture {
  const x0 = Math.round(box[0] * scale),
    y0 = Math.round(box[1] * scale);
  const w = Math.max(1, Math.round(size[0] * scale)),
    h = Math.max(1, Math.round(size[1] * scale));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (y0 + y < 0 || y0 + y >= p.height) continue;
    const from = ((y0 + y) * p.width + Math.max(0, x0)) * 4;
    data.set(p.data.subarray(from, from + Math.max(0, Math.min(w, p.width - x0)) * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

interface PartVerdict {
  part: string;
  green: boolean;
  names: Reading;
  boxes: Reading;
  drawn: Reading;
  picture: PictureReading;
}

function describe_(key: string, v: PartVerdict, most = 12): string {
  const head = `COMPARE ${v.green ? "green" : "RED"} ${key} [${v.part}] names=${v.names.verdict} boxes=${v.boxes.verdict} drawn=${v.drawn.verdict} picture=${v.picture.verdict} ratio=${v.picture.ratio.toFixed(6)}`;
  const lines: string[] = [];
  for (const [q, r] of [
    ["names", v.names],
    ["boxes", v.boxes],
    ["drawn", v.drawn],
    ["picture", v.picture],
  ] as const) {
    for (const f of r.findings.slice(0, most)) lines.push(`  ${q}: ${f}`);
    if (r.findings.length > most) lines.push(`  ${q}: … and ${r.findings.length - most} more`);
  }
  return [head, ...lines].join("\n");
}

const missing = (what: string): PictureReading => ({
  verdict: "red",
  ratio: 1,
  worst: null,
  mark: null,
  sized: false,
  findings: [what],
});

/** One part held by all four questions: the scenes as cut, and the pictures in each side's own box. */
function holdPart(
  part: string,
  ref: Part | undefined,
  got: Part | undefined,
  pictures: { reference: Picture; actual: Picture },
  scale: number,
): PartVerdict {
  if (!ref || !got) {
    const none: Reading = {
      verdict: "red",
      findings: [`${ref ? "the product" : "the reference"} has no ${part}`],
    };
    return { part, green: false, names: none, boxes: none, drawn: none, picture: missing(`no ${part}`) };
  }
  const scenes = compareScenes(ref.scene, got.scene, TOLERANCE);
  const size: [number, number] = [Math.min(ref.box[2], got.box[2]), Math.min(ref.box[3], got.box[3])];
  const regions = ref.nodes.map((n) => ({
    node: said(n),
    box: (ref.fromCorner ? n.box : [n.box[0] - ref.box[0], n.box[1] - ref.box[1], n.box[2], n.box[3]]) as Box,
  }));
  const picture = comparePictures(
    crop(pictures.reference, ref.box, size, scale),
    crop(pictures.actual, got.box, size, scale),
    regions,
    scale,
    TOLERANCE,
  );
  const green = [scenes.names, scenes.boxes, scenes.drawn, picture].every((r) => r.verdict !== "red");
  return { part, green, names: scenes.names, boxes: scenes.boxes, drawn: scenes.drawn, picture };
}

function keep(key: string, part: string, drew: { png: Buffer; scene: Scene }, v: PartVerdict): void {
  mkdirSync(OUT, { recursive: true });
  const at = join(OUT, `${fileOf(key)}.${part}`.replace(/[^A-Za-z0-9._@-]+/g, "_"));
  writeFileSync(`${at}.actual.png`, drew.png);
  writeFileSync(`${at}.actual.json`, JSON.stringify(drew.scene));
  if (v.picture.diff) writeFileSync(`${at}.diff.png`, v.picture.diff);
}

describe("the places' parts of the screens news to address, against the reference's", () => {
  /* As the kit's comparison: a part held against nothing is no comparison, so a missing shard is red, never a skip. */
  const reference = referenceIn(REFERENCE, [...SHARDS], true);
  if (reference.fail) {
    it("finds the reference in build/reference", () => {
      throw new Error(reference.line);
    });
    return;
  }

  it("declares by node, by a pair of names or by a part not drawn, never a whole state, and only its own keys", () => {
    for (const d of declared) {
      expect(d.keys.length, d.reason).toBeGreaterThan(0);
      expect(
        d.keys.filter((k) => !ALL_KEYS.has(k)),
        d.reason,
      ).toEqual([]);
      expect(
        [d.out, d.unnamed, d.pairs, d.notDrawn].some((list) => Boolean(list?.length)),
        `${d.reason}: names no node, no pair and no part`,
      ).toBe(true);
      expect(d.notDrawn, `${d.reason}: a whole state is never declared`).not.toBe("state");
      if (Array.isArray(d.notDrawn))
        expect(d.notDrawn.length, `${d.reason}: a row leaves out a part, never every part`).toBeLessThan(
          PARTS.length - 1,
        );
      expect([d.reason, d.since, d.removedBy].every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    }
  });

  const require_ = createRequire(resolve(ROOT, "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  beforeAll(async () => {
    browser = await launch(chromium);
  });
  afterAll(async () => {
    await browser?.close();
  });

  /* One case a key, named by the key whole, so that a run can be narrowed to a screen by `-t "screen=<screen>(&|$)"`. */
  for (const { key, shard } of KEYS)
    it(key, async () => {
      const ref = referenceOf(key, shard);
      const drew = await shoot(browser!, ref.variant, (page) => openPlacesPage(page, key));
      const sides = declaredOn(key, ref.scene, drew.scene);
      const pictures = { reference: decode(ref.png), actual: decode(drew.png) };
      const notDrawn = new Set(rowsOf(key).flatMap((d) => (Array.isArray(d.notDrawn) ? d.notDrawn : [])));
      const theirs = partsOf(sides.reference, shard);
      const mine = partsOf(sides.actual, shard);
      const verdicts: PartVerdict[] = [];
      for (const part of PARTS) {
        if (notDrawn.has(part)) {
          console.log(`COMPARE not drawn ${key} [${part}]`);
          continue;
        }
        if (!theirs.has(part) && !mine.has(part)) continue;
        verdicts.push(holdPart(part, theirs.get(part), mine.get(part), pictures, ref.variant.scale));
      }
      for (const v of verdicts) {
        console.log(describe_(key, v));
        if (!v.green) keep(key, v.part, drew, v);
      }
      expect(
        verdicts.filter((v) => !v.green).map((v) => describe_(key, v, 40)),
        `${key}: a part of the place differs from the reference`,
      ).toEqual([]);
    });
});
