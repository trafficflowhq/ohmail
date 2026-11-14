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
import type {
  Drawn,
  PaintFile,
  Scene,
  SceneNode,
  Surface,
  Variant,
} from "../../../../test/compare/scene.d.mts";
import { cutScene } from "../../../ui/test/compare/cut.mjs";
import { openFramePage } from "../states/frame-page.js";

/**
 * THE FRAME'S PARTS of the screen `states`, each against the same part of the reference's picture and data file
 * (`node test/compare/fetch.mjs --all --from <the shards>`, then
 * `npx vitest run --config vitest.compare.config.ts packages/app/test/compare`).
 *
 * The reference of `states` is the design's state browser: its columns (the head "States", the list of kinds, the
 * specimens) are the design's catalogue and no screen of the app. What is the frame's in that picture is cut out of
 * both sides alike with the kit's `cutScene` and held by the comparison's own four questions, none softened:
 *
 * - the rail: the landmark `navigation "Places"` and everything in its box, in the window's coordinates. Where the
 *   reference's rail holds the switch between ohmail and ohcal (1440 and 719), the nodes from Write down to the last
 *   entry above the foot are measured from Write's corner on both sides, and the foot (the notice, Pull new mail,
 *   the account, its tools) stays in the window's; the upright dock has no foot, and is measured from Write whole;
 * - the sheets: every painted surface at least half the window high, whichever node holds it or none, by its box
 *   and its paint; at a phone's width only the ground, where the one column draws its own sheet;
 * - the report (the reports key): the status that holds Undo on the list's sheet, its box in the window's
 *   coordinates, its inside from its corner.
 *
 * Words outside every node carry no box in a whole page's data file, so they cannot be cut to a part: they are
 * left out on both sides. No part reaches into the columns' inside, so it needs no declaration: a screen's body is
 * compared under its own screen's keys by its own task. The differences that stay are the rows of `declared.json`
 * beside this file, by node or by a pair of names, never a whole state. What a part that is not green drew is
 * written to build/compare/frame-parts/.
 *
 * Owed by the comparison's task: a subject that names the landmarks it is compared within, and a declared row that
 * pairs two names. Then this file becomes `test/compare/subjects/states.ts` and its rows move to that declared.json.
 */

const ROOT = process.cwd();
const COMPARE = resolve(ROOT, "test/compare");
const REFERENCE = resolve(ROOT, "build/reference");
const OUT = resolve(ROOT, "build/compare/frame-parts");
const REQUIRED = process.env.COMPARE_REQUIRE_REFERENCE === "1";
const SHARD = "states";

/** The frame's registered states: the seven links of `screen=states`, a notice, a connection state, a report. */
export const KEYS = [
  "screen=states",
  "device=phone&screen=states",
  "device=fold&screen=states",
  "device=foldl&screen=states",
  "face=ohmarchy&screen=states",
  "scheme=dark&screen=states",
  "face=ohmarchy&scheme=dark&screen=states",
  "screen=states&show=full",
  "kind=connection&screen=states&show=offline",
  "kind=reports&say=Parked&screen=states",
] as const;
type Key = (typeof KEYS)[number];

/** Where the reference's rail holds the switch between the two products: the rail's body is measured from Write. */
const SWITCHED: readonly Key[] = KEYS.filter((k) => !k.includes("device=") || k.includes("device=fold&"));
/** The upright dock beside the columns, which has no foot. */
const UPRIGHT: readonly Key[] = ["device=fold&screen=states", "device=foldl&screen=states"];
const PHONE: Key = "device=phone&screen=states";

/** A row of `declared.json`: nodes left out of both sides, or a reference's name read as the product's. */
interface DeclaredRow {
  keys: Key[];
  reason: string;
  since: string;
  removedBy: string;
  /** Left out of both sides whole. */
  out?: { role: string; name: string }[];
  /** The reference's node of this role and name (the `nth` of them, from 0) reads as `as`: its box, state and drawing still bind. */
  pairs?: { role: string; name: string; nth?: number; as: string; keys?: Key[] }[];
  /**
   * A property of what paints, left out on both sides (with the properties that paint only beside it): the window's
   * surface (outside every node, the whole window), or the surfaces a node of this role holds. A surface that paints
   * nothing else then leaves.
   */
  paint?: { on: "window" | { role: string }; property: string; keys?: Key[] }[];
  /** A value the node of this role is drawn with, left out on both sides. */
  drawn?: { role: string; property: keyof Drawn; keys?: Key[] }[];
  /**
   * What moves with the row's difference: boxes of a part's picture, in the coordinates of its crop (`crop`, from 0,
   * in the part's order) from the crop's corner, painted out alike on both sides.
   */
  picture?: { part: string; crop: number; box: Box; keys?: Key[] }[];
}

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const registry = json<Registry>(join(COMPARE, "registry.json"));
const manifest = json<Manifest>(join(COMPARE, "manifest.json"));
type Box = [number, number, number, number];
const declared = json<DeclaredRow[]>(resolve(ROOT, "packages/app/test/compare/declared.json"));
const paintFile = json<PaintFile>(join(COMPARE, "paint-properties.json"));
const camel = (property: string): string => property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
/** A paint's property and the properties that paint only beside it (`with`), as a paint names them. */
const withIt = (property: string): string[] => {
  const kebab = property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return [property, ...paintFile.boxes.filter((r) => r.with === kebab).map((r) => r.as ?? camel(r.property))];
};
const said = (n: SceneNode): string => `${n.role} "${n.name}"`;
const inside = (box: number[], at: Box): boolean =>
  box[0]! >= at[0] - 0.5 &&
  box[1]! >= at[1] - 0.5 &&
  box[0]! + box[2]! <= at[0] + at[2] + 0.5 &&
  box[1]! + box[3]! <= at[1] + at[3] + 0.5;

/** The reference of one key, read as the tool reads it: its manifest row, both checksums, the shard's files. */
function referenceOf(key: Key): { variant: Variant; scene: Scene; png: Buffer } {
  const state = registry.states.find((s) => s.key === key);
  const row = manifest.rows.find((r) => r.key === key);
  if (!state || state.screen !== SHARD) throw new Error(`${key} is not a registered state of ${SHARD}`);
  if (!row || row.shard !== SHARD) throw new Error(`${key} has no picture in shard ${SHARD} (manifest.json)`);
  const at = join(REFERENCE, SHARD, fileOf(key));
  if (!existsSync(`${at}.png`) || !existsSync(`${at}.json`))
    throw new Error(
      `the reference archive is not in build/reference (shard ${SHARD}); run: node test/compare/fetch.mjs --all`,
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

/** The declared rows of one key, each part of a row narrowed to the keys it names. */
function rowsOf(key: Key): DeclaredRow[] {
  const here = <T extends { keys?: Key[] }>(d: DeclaredRow, list?: T[]) =>
    list?.filter((x) => (x.keys ?? d.keys).includes(key));
  return declared
    .filter((d) => d.keys.includes(key))
    .map((d) => ({
      ...d,
      pairs: here(d, d.pairs),
      paint: here(d, d.paint),
      drawn: here(d, d.drawn),
      picture: here(d, d.picture),
    }));
}

/** The surfaces a paint row reads on one side: the window's own, or those of the nodes of its role. */
function paintedBy(s: Scene, on: "window" | { role: string }): Surface[] {
  if (on === "window")
    return s.loose.surfaces.filter(
      (x) => x.box[0] <= 0 && x.box[1] <= 0 && x.box[2] >= s.variant.width && x.box[3] >= s.variant.height,
    );
  return s.nodes.filter((n) => n.role === on.role).flatMap((n) => n.surfaces ?? []);
}

/** A scene with the declared properties of what paints left out: a surface that paints nothing else leaves. */
function withoutPaint(s: Scene, rows: DeclaredRow[]): Scene {
  const lines = rows.flatMap((d) => d.paint ?? []);
  if (!lines.length) return s;
  const paints = [...s.paints];
  const strip = (list: Surface[], hit: Set<Surface>): Surface[] =>
    list.flatMap((x) => {
      if (!hit.has(x)) return [x];
      const left = Object.fromEntries(
        Object.entries(paints[x.paint] ?? {}).filter(
          ([k]) => !lines.some((l) => withIt(l.property).includes(k)),
        ),
      );
      if (!Object.keys(left).length) return [];
      paints.push(left);
      return [{ ...x, paint: paints.length - 1 }];
    });
  const hit = new Set(lines.flatMap((l) => paintedBy(s, l.on)));
  return {
    ...s,
    paints,
    nodes: s.nodes.map((n) => (n.surfaces ? { ...n, surfaces: strip(n.surfaces, hit) } : n)),
    loose: { ...s.loose, surfaces: strip(s.loose.surfaces, hit) },
  };
}

/** A scene with the declared values its nodes are drawn with left out. */
function withoutDrawn(s: Scene, rows: DeclaredRow[]): Scene {
  const lines = rows.flatMap((d) => d.drawn ?? []);
  if (!lines.length) return s;
  return {
    ...s,
    nodes: s.nodes.map((n) => {
      const gone = lines.filter((l) => l.role === n.role).map((l) => l.property);
      return gone.length
        ? { ...n, drawn: { ...n.drawn, ...Object.fromEntries(gone.map((k) => [k, ""])) } }
        : n;
    }),
  };
}

/** The declared rows applied: a row's nodes left out, its pairs read on the reference's side. Each row must bite. */
function declaredOn(key: Key, reference: Scene, actual: Scene): { reference: Scene; actual: Scene } {
  const rows = rowsOf(key);
  const gone = (n: SceneNode) => rows.some((d) => d.out?.some((o) => o.role === n.role && o.name === n.name));
  for (const d of rows) {
    const painted = (s: Scene) =>
      d.paint?.some((l) =>
        paintedBy(s, l.on).some((x) => withIt(l.property).some((k) => k in (s.paints[x.paint] ?? {}))),
      );
    const bites =
      d.out?.some((o) => reference.nodes.some((n) => n.role === o.role && n.name === o.name)) ||
      d.pairs?.some((p) => reference.nodes.some((n) => n.role === p.role && n.name === p.name)) ||
      painted(reference) ||
      painted(actual) ||
      d.drawn?.some((l) => {
        const [r, a] = [reference, actual].map(
          (s) => s.nodes.find((n) => n.role === l.role)?.drawn[l.property],
        );
        return r !== undefined && a !== undefined && r !== a;
      });
    if (!bites) throw new Error(`${key}: the declared row "${d.reason}" names nothing the reference holds`);
  }
  const seen = new Map<string, number>();
  const nodes = reference.nodes
    .filter((n) => !gone(n))
    .map((n) => {
      const id = `${n.role}\u0000${n.name}`;
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      const pair = rows
        .flatMap((d) => d.pairs ?? [])
        .find((p) => p.role === n.role && p.name === n.name && (p.nth ?? nth) === nth);
      return pair ? { ...n, name: pair.as } : n;
    });
  return {
    reference: withoutDrawn(withoutPaint({ ...reference, nodes }, rows), rows),
    actual: withoutDrawn(
      withoutPaint({ ...actual, nodes: actual.nodes.filter((n) => !gone(n)) }, rows),
      rows,
    ),
  };
}

/** A part: its scene, and the boxes of the picture it is held by (each side's own), with the nodes read inside each. */
interface Part {
  scene: Scene;
  crops: { box: Box; nodes: SceneNode[] }[];
}

const move = (n: SceneNode, [dx, dy]: [number, number]): SceneNode => {
  const by = (b: number[]): Box => [b[0]! - dx, b[1]! - dy, b[2]!, b[3]!];
  return {
    ...n,
    box: by(n.box),
    ...(n.surfaces ? { surfaces: n.surfaces.map((s) => ({ ...s, box: by(s.box) })) } : {}),
  };
};
const only = (s: Scene, nodes: SceneNode[], surfaces: Surface[] = []): Scene => ({
  ...s,
  nodes,
  loose: { text: [], surfaces },
});

/** The one landmark of the places, on either side. */
function navOf(s: Scene, key: Key): SceneNode {
  const navs = s.nodes.filter((n) => n.role === "navigation");
  if (navs.length !== 1) throw new Error(`${key}: ${navs.length} navigation landmarks, one expected`);
  return navs[0]!;
}

function railOf(s: Scene, key: Key): Part {
  const navBox = navOf(s, key).box as Box;
  const cut = cutScene(s, navBox, "window");
  const nodes = cut.nodes;
  const scene = (list: SceneNode[]) => only(cut, list, cut.loose.surfaces);
  if (!SWITCHED.includes(key)) return { scene: scene(nodes), crops: [{ box: navBox, nodes }] };
  const nav = nodes.find((n) => n.role === "navigation")!;
  const write = nodes.find((n) => n.role === "button" && /^Write( |$)/.test(n.name));
  if (!write) throw new Error(`${key}: the rail has no Write`);
  const upright = UPRIGHT.includes(key);
  const firstFoot = upright ? -1 : nodes.findIndex((n) => n.role === "status" || n.name === "Pull new mail");
  const foot = firstFoot < 0 ? [] : nodes.slice(firstFoot);
  const body = nodes.filter((n) => n !== nav && !foot.includes(n));
  const corner: [number, number] = [write.box[0], write.box[1]];
  /* The foot starts at its first node, or at the top of a box the rail paints around the foot (ohmarchy's). */
  const first = foot.length ? Math.min(...foot.map((n) => n.box[1])) : navBox[1] + navBox[3];
  const around = (nav.surfaces ?? [])
    .map((x) => x.box)
    .filter((b) => b[1] <= first && b[1] + b[3] >= first && b[3] < navBox[3] / 2);
  /* A pixel over it too: the edge a foot draws on its top line (ohmarchy's) stands just over its box. */
  const footTop = Math.min(first, ...around.map((b) => b[1])) - (foot.length ? 1 : 0);
  return {
    scene: scene([nav, ...body.map((n) => move(n, corner)), ...foot]),
    crops: [
      { box: [navBox[0], write.box[1], navBox[2], footTop - write.box[1]], nodes: [...body] },
      ...(foot.length
        ? [{ box: [navBox[0], footTop, navBox[2], navBox[1] + navBox[3] - footTop] as Box, nodes: foot }]
        : []),
    ],
  };
}

/**
 * Every painted surface at least half the window high, whichever node holds it or none. At a phone's width the
 * ground alone: what covers the window outside every node (the one column's own sheet stands in its region).
 */
function sheetsOf(s: Scene, key: Key): Surface[] {
  const { width, height } = s.variant;
  if (key === PHONE)
    return s.loose.surfaces.filter(
      (x) => x.box[0] <= 0 && x.box[1] <= 0 && x.box[2] >= width && x.box[3] >= height,
    );
  return [...s.nodes.flatMap((n) => n.surfaces ?? []), ...s.loose.surfaces].filter(
    (x) => x.box[3] >= height / 2,
  );
}

/** The list's sheet: the first surface beside the rail that holds the window's height, from the left. */
function listSheetOf(s: Scene, key: Key): Box {
  const nav = navOf(s, key).box;
  const sheet = sheetsOf(s, key)
    .filter((x) => x.box[0] >= nav[0] + nav[2] && x.box[2] > 100 && s.paints[x.paint]?.backgroundColor)
    .sort((a, b) => a.box[0] - b.box[0])[0];
  if (!sheet) throw new Error(`${key}: no list sheet`);
  return sheet.box as Box;
}

function reportOf(s: Scene, key: Key): Part {
  const list = listSheetOf(s, key);
  const holds = s.nodes.filter(
    (n) =>
      n.role === "status" &&
      inside(n.box, list) &&
      s.nodes.some((u) => u.role === "button" && /^Undo( |$)/.test(u.name) && inside(u.box, n.box as Box)),
  );
  if (holds.length !== 1)
    throw new Error(`${key}: ${holds.length} reports with Undo on the list's sheet, one expected`);
  const status = holds[0]!;
  /* The cut scene's own tables: `cutScene` numbers the text styles and paints it keeps anew. */
  const cut = cutScene(s, status.box as Box, "window");
  const nodes = cut.nodes;
  const corner: [number, number] = [status.box[0], status.box[1]];
  return {
    scene: only(
      cut,
      nodes.map((n) => (n.role === "status" ? n : move(n, corner))),
      cut.loose.surfaces,
    ),
    crops: [{ box: status.box as Box, nodes }],
  };
}

/** A box of a picture, in CSS pixels; the size is the reference's on both sides, so the two crops can be held together. */
function crop(p: Picture, box: Box, size: [number, number], scale: number): Picture {
  const x0 = Math.round(box[0] * scale),
    y0 = Math.round(box[1] * scale);
  const w = Math.round(size[0] * scale),
    h = Math.round(size[1] * scale);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * p.width + x0) * 4;
    if (y0 + y < 0 || y0 + y >= p.height) continue;
    data.set(p.data.subarray(from, from + Math.min(w, p.width - x0) * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** The picture of the sheets: the whole window with what other parts hold painted out alike on both sides. */
function sheetsPicture(p: Picture, holes: Box[], scale: number): Picture {
  const data = new Uint8Array(p.data);
  for (const [x, y, w, h] of holes) {
    for (
      let py = Math.max(0, Math.floor(y * scale));
      py < Math.min(p.height, Math.ceil((y + h) * scale));
      py++
    ) {
      data.fill(
        0,
        (py * p.width + Math.max(0, Math.floor(x * scale))) * 4,
        (py * p.width + Math.min(p.width, Math.ceil((x + w) * scale))) * 4,
      );
    }
  }
  return { width: p.width, height: p.height, data };
}

interface PartVerdict {
  part: string;
  green: boolean;
  names: Reading;
  boxes: Reading;
  drawn: Reading;
  pictures: PictureReading[];
}

function describe_(key: string, v: PartVerdict, most = 12): string {
  const head = `COMPARE ${v.green ? "green" : "RED"} ${key} [${v.part}] names=${v.names.verdict} boxes=${v.boxes.verdict} drawn=${v.drawn.verdict} picture=${v.pictures.map((p) => p.verdict).join("+")} ratio=${v.pictures.map((p) => p.ratio.toFixed(6)).join("+")}`;
  const lines: string[] = [];
  for (const [q, r] of [
    ["names", v.names],
    ["boxes", v.boxes],
    ["drawn", v.drawn],
    ...v.pictures.map((p) => ["picture", p] as const),
  ] as const) {
    for (const f of r.findings.slice(0, most)) lines.push(`  ${q}: ${f}`);
    if (r.findings.length > most) lines.push(`  ${q}: … and ${r.findings.length - most} more`);
  }
  return [head, ...lines].join("\n");
}

/** One part held by all four questions: the scenes as cut, the pictures in each crop, every region a node of the crop. */
function holdPart(
  part: string,
  ref: Part,
  got: Part,
  pictures: { reference: Picture; actual: Picture },
  scale: number,
  pictureOf?: (side: "reference" | "actual") => Picture,
  moved: (crop: number) => Box[] = () => [],
): PartVerdict {
  const scenes = compareScenes(ref.scene, got.scene, TOLERANCE);
  const readings: PictureReading[] = [];
  if (pictureOf) {
    readings.push(comparePictures(pictureOf("reference"), pictureOf("actual"), [], scale, TOLERANCE));
  } else {
    ref.crops.forEach((c, i) => {
      const mine = got.crops[i];
      if (!mine) {
        readings.push({
          verdict: "red",
          ratio: 1,
          worst: null,
          mark: null,
          sized: false,
          findings: [`the product has no ${part} crop ${i}`],
        });
        return;
      }
      /* The same size on both sides: the smaller of the two, so a part that is longer on one side is read where both stand. */
      const size: [number, number] = [Math.min(c.box[2], mine.box[2]), Math.min(c.box[3], mine.box[3])];
      const regions = c.nodes.map((n) => ({
        node: said(n),
        box: [n.box[0] - c.box[0], n.box[1] - c.box[1], n.box[2], n.box[3]] as Box,
      }));
      readings.push(
        comparePictures(
          sheetsPicture(crop(pictures.reference, c.box, size, scale), moved(i), scale),
          sheetsPicture(crop(pictures.actual, mine.box, size, scale), moved(i), scale),
          regions,
          scale,
          TOLERANCE,
        ),
      );
    });
  }
  const green = [scenes.names, scenes.boxes, scenes.drawn, ...readings].every((r) => r.verdict !== "red");
  return { part, green, names: scenes.names, boxes: scenes.boxes, drawn: scenes.drawn, pictures: readings };
}

function keep(key: string, part: string, drew: { png: Buffer; scene: Scene }, v: PartVerdict): void {
  mkdirSync(OUT, { recursive: true });
  const at = join(OUT, `${key}.${part}`.replace(/[^A-Za-z0-9._@-]+/g, "_"));
  writeFileSync(`${at}.actual.png`, drew.png);
  writeFileSync(`${at}.actual.json`, JSON.stringify(drew.scene));
  v.pictures.forEach((p, i) => {
    if (p.diff) writeFileSync(`${at}.diff-${i}.png`, p.diff);
  });
}

describe("the frame's parts of the screen states, against the reference's", () => {
  const reference = referenceIn(REFERENCE, [SHARD], REQUIRED);
  if (reference.line) console.log(reference.line);
  if (reference.fail) {
    it("finds the reference in build/reference, as this run was told it must", () => {
      throw new Error(reference.line);
    });
    return;
  }

  it("declares by node or by a pair of names, never a whole state, and only for its own keys", () => {
    for (const d of declared) {
      expect(d.keys.length, d.reason).toBeGreaterThan(0);
      expect(
        d.keys.filter((k) => !KEYS.includes(k)),
        d.reason,
      ).toEqual([]);
      expect(
        [d.out, d.pairs, d.paint, d.drawn].some((list) => Boolean(list?.length)),
        `${d.reason}: names no node, no paint and no drawn value`,
      ).toBe(true);
      expect([d.reason, d.since, d.removedBy].every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    }
  });

  const require_ = createRequire(resolve(ROOT, "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  beforeAll(async () => {
    if (!reference.missing.length) browser = await launch(chromium);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.for([...KEYS])("%s", async (key, { skip }) => {
    if (reference.missing.length) skip();
    const ref = referenceOf(key);
    const drew = await shoot(browser!, ref.variant, (page) => openFramePage(page, key));
    const sides = declaredOn(key, ref.scene, drew.scene);
    const pictures = { reference: decode(ref.png), actual: decode(drew.png) };
    const scale = ref.variant.scale;
    /* What moves with a declared difference, by part and crop: painted out of both crops alike. */
    const moved =
      (part: string) =>
      (i: number): Box[] =>
        rowsOf(key)
          .flatMap((d) => d.picture ?? [])
          .filter((p) => p.part === part && p.crop === i)
          .map((p) => p.box);
    const verdicts: PartVerdict[] = [];

    verdicts.push(
      holdPart(
        "rail",
        railOf(sides.reference, key),
        railOf(sides.actual, key),
        pictures,
        scale,
        undefined,
        moved("rail"),
      ),
    );

    /*
     * The sheets' picture: the window with the rail's box and every column's box painted out alike on both sides, so
     * the ground, the gaps, the handles and the sheets' outer edges are read; a column's inside is the catalogue's.
     * At a phone's width the ground shows only under the catalogue's head and the dock: its box and its paint bind.
     */
    const navBox = navOf(sides.reference, key).box as Box;
    const sheets = { reference: sheetsOf(sides.reference, key), actual: sheetsOf(sides.actual, key) };
    const { width, height } = ref.variant;
    /* A column is the box of a sheet on either side, or of the frame's two column landmarks. */
    const columns = [
      ...[...sheets.reference, ...sheets.actual]
        .filter((x) => x.box[2] < width && x.box[2] > 24)
        .map((x) => x.box as Box),
      ...sides.actual.nodes
        .filter((n) => n.role === "region" && (n.name === "Messages" || n.name === "Reading"))
        .map((n) => n.box as Box),
    ];
    const holes: Box[] = key === PHONE ? [[0, 0, width, height]] : [navBox, ...columns];
    verdicts.push(
      holdPart(
        "sheets",
        { scene: only(sides.reference, [], sheets.reference), crops: [] },
        { scene: only(sides.actual, [], sheets.actual), crops: [] },
        pictures,
        scale,
        (side) => sheetsPicture(pictures[side], holes, scale),
      ),
    );

    if (key === "kind=reports&say=Parked&screen=states") {
      verdicts.push(
        holdPart("report", reportOf(sides.reference, key), reportOf(sides.actual, key), pictures, scale),
      );
    }

    for (const v of verdicts) {
      console.log(describe_(key, v));
      if (!v.green) keep(key, v.part, drew, v);
    }
    expect(
      verdicts.filter((v) => !v.green).map((v) => describe_(key, v, 40)),
      `${key}: a part of the frame differs from the reference`,
    ).toEqual([]);
  });
});
