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
import { openAskPage, openReaderPage } from "../states/reader-pages.js";

/**
 * THE READER'S PARTS of the screens `reading` and `linkask`, each against the same part of the reference's picture
 * and data file (`node test/compare/fetch.mjs --from <the shards>`, then
 * `npx vitest run --config vitest.compare.config.ts packages/app/test/compare/reader-parts.compare.ts`). The shards
 * are named to the fetch by `test/compare/subjects/reading.ts` and `linkask.ts`, the tool's rule; a shard not in
 * build/reference is red here, never a skip, as in the kit's comparison.
 *
 * The reference of `reading` stands the reader beside the design's catalogue list and the frame's rail; the rail is
 * the frame's (held by `frame-parts`), the list is no screen of the app, and each letter's text is a designed page
 * the reader never draws (the body draws its own, in its own sandboxed frame). What is the reader's is cut out of
 * both sides alike with the kit's `cutScene` and held by the comparison's own four questions, none softened, each
 * part by its node's box in the window's coordinates:
 *
 * - the reading head: the banner that holds the conversation's subject;
 * - each letter's head: the banner that holds its sender, its menu, its stamp and to whom, with the nodes it holds;
 * - the text's notice: a status that says where a letter's text is, and its acts;
 * - the files: the tiles and their acts;
 *
 * where a part's place follows the letter's text above it (the notice, the files, a letter after the first), it is
 * measured from its own corner: the reference's text is a designed page the page cannot feed.
 *
 * - the panel: `toolbar "Actions"` with its verbs;
 * - the blank and the gone letter: the reading column while no letter is drawn, and what stands in it;
 * - on the ask page: `main`.
 *
 * Words outside every node carry no box in a whole page's data file, so they cannot be cut to a part: they are left
 * out on both sides (the blank's label is held by its picture). The differences that stay are the rows of
 * `reader-declared.json` beside this file: nodes left out of both sides, a pair of names, or a part a key does not
 * draw, with its reason and the task that removes it; never a whole state. What a part that is not green drew is
 * written to build/compare/reader-parts/.
 */

const ROOT = process.cwd();
const COMPARE = resolve(ROOT, "test/compare");
const REFERENCE = resolve(ROOT, "build/reference");
const OUT = resolve(ROOT, "build/compare/reader-parts");
const SHARDS = ["reading", "linkask"] as const;
type Shard = (typeof SHARDS)[number];

type Box = [number, number, number, number];
type PartName = "head" | "letter" | "notice" | "files" | "panel" | "blank" | "page";
const PARTS: readonly PartName[] = ["head", "letter", "notice", "files", "panel", "blank", "page"];

/** A row of `reader-declared.json`. */
interface DeclaredRow {
  keys: string[];
  reason: string;
  since: string;
  removedBy: string;
  /** Left out of both sides whole, with what they paint. */
  out?: { role: string; name: string }[];
  /** Nodes the reference does not name: they leave as nodes, and their words and paint stand loose. */
  unnamed?: { role: string; name: string }[];
  /** The reference's node of this role and name reads as `as`: its box, its state and its drawing still bind. */
  pairs?: { role: string; name: string; as: string }[];
  /**
   * What these keys do not draw, said in the reason with the task or the ask that draws it: some of its parts, or
   * the whole state where the page cannot stand it (a posture, another window over the reader).
   */
  notDrawn?: PartName[] | "state";
  /** Keys whose pictures are one: the page cannot tell them apart, each said in the reason. */
  samePicture?: true;
}

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const registry = json<Registry>(join(COMPARE, "registry.json"));
const manifest = json<Manifest>(join(COMPARE, "manifest.json"));
const declared = json<DeclaredRow[]>(resolve(ROOT, "packages/app/test/compare/reader-declared.json"));
const KEYS: readonly { key: string; shard: Shard }[] = registry.states
  .filter((s) => (SHARDS as readonly string[]).includes(s.screen))
  .map((s) => ({ key: s.key, shard: s.screen as Shard }));
const ALL_KEYS = new Set(KEYS.map((k) => k.key));

const said = (n: SceneNode): string => `${n.role} "${n.name}"`;
const inside = (box: number[], at: number[], slack = 0.5): boolean =>
  box[0]! >= at[0]! - slack &&
  box[1]! >= at[1]! - slack &&
  box[0]! + box[2]! <= at[0]! + at[2]! + slack &&
  box[1]! + box[3]! <= at[1]! + at[3]! + slack;
const meets = (a: number[], b: number[]): boolean =>
  a[0]! < b[0]! + b[2]! && b[0]! < a[0]! + a[2]! && a[1]! < b[1]! + b[3]! && b[1]! < a[1]! + a[3]!;
const union = (boxes: number[][]): Box => {
  const x = Math.min(...boxes.map((b) => b[0]!)),
    y = Math.min(...boxes.map((b) => b[1]!));
  const r = Math.max(...boxes.map((b) => b[0]! + b[2]!)),
    d = Math.max(...boxes.map((b) => b[1]! + b[3]!));
  return [x, y, r - x, d - y];
};

/** The reference of one key, read as the tool reads it: its manifest row, both checksums, the shard's files. */
function referenceOf(key: string, shard: Shard): { variant: Variant; scene: Scene; png: Buffer } {
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

/**
 * A scene with the nodes `gone` names left out as nodes: what they hold of words and paint stands loose, as where no
 * node stands at all (a landmark the reference does not name holds the words and paint the reference holds loose).
 */
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
      d.samePicture === true ||
      d.out?.some((o) => holds(reference, o.role, o.name) || holds(actual, o.role, o.name)) ||
      d.unnamed?.some((o) => holds(actual, o.role, o.name)) ||
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

/* A part stands in the window, or from its own corner where its place follows a letter's text above it. */
const only = (s: Scene, box: Box, place: "window" | "block" = "window"): Part => {
  const cut = cutScene(s, box, place);
  return {
    scene: { ...cut, loose: { text: [], surfaces: cut.loose.surfaces } },
    box,
    nodes: cut.nodes,
    fromCorner: place !== "window",
  };
};

/** The reading column: right of the list's handle where one stands, else the window. */
function columnOf(s: Scene): Box {
  const { width, height } = s.variant;
  const handle = s.nodes.find((n) => n.role === "separator" && n.name === "List width");
  if (!handle) return [0, 0, width, height];
  const x = handle.box[0] + handle.box[2];
  return [x, 0, width - x, height];
}

const isSender = (n: SceneNode): boolean => n.role === "button" && /@\S+\.\S+$/.test(n.name);
/* A tile's own acts name their file; the text's notice has a Try again of its own. */
const FILE = /^(Preview|Download|Try again:|Sign in:) /;

/** Every part of one side, in its order on the page. */
function partsOf(s: Scene, shard: Shard): Map<PartName, Part[]> {
  const parts = new Map<PartName, Part[]>(PARTS.map((p) => [p, []]));
  if (shard === "linkask") {
    const main = s.nodes.find((n) => n.role === "main");
    if (main) parts.get("page")!.push(only(s, main.box as Box));
    return parts;
  }
  const column = columnOf(s);
  const here = s.nodes.filter((n) => inside(n.box, column, 8));
  const panel = here.find((n) => n.role === "toolbar" && n.name === "Actions");
  const banners = here.filter((n) => n.role === "banner");
  /* The list column's own head (the design catalogue's "Reading") is no part of the reader. */
  const head = banners.find((b) =>
    here.some((n) => n.role === "heading" && n.name !== "Reading" && inside(n.box, b.box, 1)),
  );
  if (head) parts.get("head")!.push(only(s, head.box as Box));
  for (const b of banners) {
    const sender = here.find((n) => isSender(n) && meets(n.box, b.box));
    if (!sender) continue;
    const letters = parts.get("letter")!;
    letters.push(
      only(
        s,
        union(here.filter((n) => inside(n.box, b.box, 8)).map((n) => n.box)),
        letters.length ? "block" : "window",
      ),
    );
  }
  const tiles = here.filter((n) => n.role === "button" && (FILE.test(n.name) || n.name === "Download all"));
  for (const st of here.filter(
    (n) => n.role === "status" && n.box[2] >= 300 && !tiles.some((t) => meets(t.box, n.box)),
  ))
    parts.get("notice")!.push(only(s, st.box as Box, "block"));
  if (tiles.length) parts.get("files")!.push(only(s, union(tiles.map((t) => t.box)), "block"));
  if (panel) parts.get("panel")!.push(only(s, panel.box as Box));
  if (!head && s.nodes.some((n) => n.role === "separator" && n.name === "List width"))
    parts.get("blank")!.push(only(s, [column[0], 12, column[2] - 12, column[3] - 24]));
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
  const at = join(OUT, `${key}.${part}`.replace(/[^A-Za-z0-9._@-]+/g, "_"));
  writeFileSync(`${at}.actual.png`, drew.png);
  writeFileSync(`${at}.actual.json`, JSON.stringify(drew.scene));
  if (v.picture.diff) writeFileSync(`${at}.diff.png`, v.picture.diff);
}

describe("the reader's parts of the screens reading and linkask, against the reference's", () => {
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
        [d.out, d.unnamed, d.pairs, d.notDrawn].some((list) => Boolean(list?.length)) ||
          d.samePicture === true,
        `${d.reason}: names no node, no pair, no part and no picture`,
      ).toBe(true);
      if (Array.isArray(d.notDrawn))
        expect(d.notDrawn.length, `${d.reason}: a row leaves out a part, never every part`).toBeLessThan(
          PARTS.length - 1,
        );
      if (d.notDrawn === "state")
        expect(d.removedBy, `${d.reason}: a state not drawn names the task that draws it`).not.toMatch(
          /^never/,
        );
      expect([d.reason, d.since, d.removedBy].every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    }
  });

  const require_ = createRequire(resolve(ROOT, "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  const drawnPictures = new Map<string, string>();
  beforeAll(async () => {
    browser = await launch(chromium);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.for([...KEYS])("$key", async ({ key, shard }) => {
    const ref = referenceOf(key, shard);
    const drew = await shoot(browser!, ref.variant, (page) =>
      shard === "linkask" ? openAskPage(page, key) : openReaderPage(page, key),
    );
    drawnPictures.set(key, sha256(decode(drew.png).data));
    const sides = declaredOn(key, ref.scene, drew.scene);
    const pictures = { reference: decode(ref.png), actual: decode(drew.png) };
    if (rowsOf(key).some((d) => d.notDrawn === "state")) {
      console.log(`COMPARE not drawn ${key} [state]`);
      return;
    }
    const notDrawn = new Set(rowsOf(key).flatMap((d) => (Array.isArray(d.notDrawn) ? d.notDrawn : [])));
    const theirs = partsOf(sides.reference, shard);
    const mine = partsOf(sides.actual, shard);
    const verdicts: PartVerdict[] = [];
    for (const part of PARTS) {
      if (notDrawn.has(part)) {
        console.log(`COMPARE not drawn ${key} [${part}]`);
        continue;
      }
      const a = theirs.get(part)!,
        b = mine.get(part)!;
      for (let i = 0; i < Math.max(a.length, b.length); i++)
        verdicts.push(
          holdPart(a.length > 1 ? `${part} ${i + 1}` : part, a[i], b[i], pictures, ref.variant.scale),
        );
    }
    for (const v of verdicts) {
      console.log(describe_(key, v));
      if (!v.green) keep(key, v.part, drew, v);
    }
    expect(
      verdicts.filter((v) => !v.green).map((v) => describe_(key, v, 40)),
      `${key}: a part of the reader differs from the reference`,
    ).toEqual([]);
  });

  it("two keys of a screen never draw one picture, unless a row says the page cannot tell them apart", ({
    skip,
  }) => {
    if (drawnPictures.size < KEYS.length) skip();
    const byPicture = new Map<string, string[]>();
    for (const [key, digest] of drawnPictures) byPicture.set(digest, [...(byPicture.get(digest) ?? []), key]);
    /* A state the page cannot stand is drawn as the state under it: its own row says so already. */
    const standing = (k: string) => !rowsOf(k).some((d) => d.notDrawn === "state");
    const covered = (keys: string[]) =>
      keys.filter(standing).length < 2 ||
      declared.some((d) => d.samePicture && keys.filter(standing).every((k) => d.keys.includes(k)));
    expect([...byPicture.values()].filter((keys) => keys.length > 1 && !covered(keys))).toEqual([]);
  });
});
