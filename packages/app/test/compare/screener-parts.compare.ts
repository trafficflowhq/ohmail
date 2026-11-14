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
import { subjects } from "../../../../test/compare/subjects/screener.js";
import { cutScene } from "../../../ui/test/compare/cut.mjs";

/**
 * THE SCREENER'S PARTS of the screen `screener`, each against the same part of the reference's picture and data file
 * (`node test/compare/fetch.mjs --from <the shards>`, then
 * `npx vitest run --config vitest.compare.config.ts packages/app/test/compare/screener-parts.compare.ts`). The shard
 * is named to the fetch by `test/compare/subjects/screener.ts`, whose keys are the states the page draws; a shard not
 * in build/reference is red here, never a skip.
 *
 * The reference stands the Screener beside the frame's rail; the rail and the landmarks around the columns are the
 * frame's (held by `frame-parts`). What is the Screener's is cut out of both sides alike with the kit's `cutScene` and
 * held by the comparison's four questions, none softened, each part by its node's box:
 *
 * - the list's head: the banner with the place's name and its sections;
 * - a notice of the place's own, under the head;
 * - Search Junk's field;
 * - each list of rows;
 * - the open sender's sentence: the reading column's first banner;
 * - each held letter's head, the second and later measured from their own corner (a letter's text above sets their
 *   place);
 * - the panel: the reading column's toolbar;
 * - a dialog or a menu standing over the place;
 * - the blank reading column.
 *
 * The differences that stay are the rows of `screener-declared.json` beside this file, each in one named CLASS of
 * `CLASSES` below with a reason a person can check against the design: nodes left out of both sides, a pair of names
 * (and roles), or a part or a state not drawn. Never a whole state of the screen it draws. What a part that is not
 * green drew is written to build/compare/screener-parts/.
 */

const ROOT = process.cwd();
const COMPARE = resolve(ROOT, "test/compare");
const REFERENCE = resolve(ROOT, "build/reference");
const OUT = resolve(ROOT, "build/compare/screener-parts");
const SHARDS = ["screener"] as const;
type Shard = (typeof SHARDS)[number];

type Box = [number, number, number, number];
type PartName = "head" | "notice" | "search" | "rows" | "sentence" | "letter" | "panel" | "over" | "blank";
const PARTS: readonly PartName[] = [
  "head",
  "notice",
  "search",
  "rows",
  "sentence",
  "letter",
  "panel",
  "over",
  "blank",
];

/**
 * THE NAMED CLASSES a declared row may stand in, each a difference a person can check against the design. A row of
 * no class is a difference to mend, in the screen or as an ask of the kit, never a row.
 */
const CLASSES = {
  "not-in-2.0":
    "a part of 1.0.11 that 2.0 leaves out by decision (Z70: the degraded Screener, the Quarantine shelf and its sweep, Delete on Spam): no state to draw",
  "demo-option": "an option of the reference's own (dotted words, panel faces) that no product setting draws",
  posture: "a posture of a folding phone: the states page stands a window, never a posture; phone-touch's",
  "designed-letter": "a letter drawn as its sender designed it: the reader's body part, not the Screener's",
  "frame-report": "what a press reports after it: the frame's report, drawn by the frame, not by this place",
  "first-open":
    "the queue with nobody open: 1.0.11 opens the first sender, so the place stands so only after a decision leaves none",
  "kit-rows":
    "the kit's rows are options of a named listbox (the shipped rows' names, what a screen reader is told), where the reference draws a list of buttons",
  "shipped-name":
    "a control keeps the name 1.0.11 gives it (what the journeys and a screen reader find), where the reference names it anew",
  "kit-ask": "a part the kit lacks, drawn with a stand-in until the kit's ask lands (named in the reason)",
} as const;
type ClassName = keyof typeof CLASSES;

/** A row of `screener-declared.json`. */
interface DeclaredRow {
  keys: string[];
  class: ClassName;
  reason: string;
  since: string;
  removedBy: string;
  out?: { role: string; name: string }[];
  unnamed?: { role: string; name: string }[];
  pairs?: { role: string; name: string; as: string; asRole?: string }[];
  notDrawn?: PartName[] | "state";
  samePicture?: true;
}

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const registry = json<Registry>(join(COMPARE, "registry.json"));
const manifest = json<Manifest>(join(COMPARE, "manifest.json"));
const declared = json<DeclaredRow[]>(resolve(ROOT, "packages/app/test/compare/screener-declared.json"));
const KEYS: readonly { key: string; shard: Shard }[] = registry.states
  .filter((s) => s.screen === "screener")
  .map((s) => ({ key: s.key, shard: "screener" as const }));
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
        return pair ? { ...n, name: pair.as, role: pair.asRole ?? n.role } : n;
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

/** The two columns: between the rail's handle and the list's, and right of the list's; one column is the window. */
function columnsOf(s: Scene): { list: Box; reading: Box | null } {
  const { width, height } = s.variant;
  const rail = s.nodes.find((n) => n.role === "separator" && n.name === "Sidebar width");
  const handle = s.nodes.find((n) => n.role === "separator" && n.name === "List width");
  const left = rail ? rail.box[0] + rail.box[2] : 0;
  if (!handle) return { list: [left, 0, width - left, height], reading: null };
  const x = handle.box[0] + handle.box[2];
  return { list: [left, 0, handle.box[0] - left, height], reading: [x, 0, width - x, height] };
}

const LISTS = new Set(["list", "listbox"]);

/** Every part of one side, in its order on the page. */
function partsOf(s: Scene): Map<PartName, Part[]> {
  const parts = new Map<PartName, Part[]>(PARTS.map((p) => [p, []]));
  const { list, reading } = columnsOf(s);
  const inList = s.nodes.filter((n) => inside(n.box, list, 8));
  const head = inList.find((n) => n.role === "banner");
  if (head) parts.get("head")!.push(only(s, head.box as Box));
  for (const st of inList.filter(
    (n) => n.role === "status" && n.box[2] >= 300 && (!head || !inside(n.box, head.box)),
  ))
    parts.get("notice")!.push(only(s, st.box as Box));
  const search = inList.find((n) => n.role === "searchbox");
  if (search) parts.get("search")!.push(only(s, search.box as Box));
  for (const l of inList.filter((n) => LISTS.has(n.role))) parts.get("rows")!.push(only(s, l.box as Box));
  for (const o of s.nodes.filter((n) => n.role === "dialog" || n.role === "menu"))
    parts.get("over")!.push(only(s, o.box as Box));
  if (reading === null) return parts;
  const here = s.nodes.filter((n) => inside(n.box, reading, 8));
  const banners = here.filter((n) => n.role === "banner");
  const [sentence, ...letters] = banners;
  if (sentence) parts.get("sentence")!.push(only(s, sentence.box as Box));
  letters.forEach((b, i) => parts.get("letter")!.push(only(s, b.box as Box, i === 0 ? "window" : "block")));
  const panel = here.find((n) => n.role === "toolbar");
  if (panel) parts.get("panel")!.push(only(s, panel.box as Box));
  if (!sentence) parts.get("blank")!.push(only(s, [reading[0], 12, reading[2] - 12, reading[3] - 24]));
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

describe("the Screener's parts of the screen screener, against the reference's", () => {
  const reference = referenceIn(REFERENCE, [...SHARDS], true);
  if (reference.fail) {
    it("finds the reference in build/reference", () => {
      throw new Error(reference.line);
    });
    return;
  }
  const drawn = new Map(subjects.map((s) => [s.key, s.open]));

  it("declares by class, by node, by a pair of names or by a part or state not drawn, and only its own keys", () => {
    for (const d of declared) {
      expect(Object.keys(CLASSES), d.reason).toContain(d.class);
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
      /* A state the page draws is never declared whole. */
      if (d.notDrawn === "state")
        expect(
          d.keys.filter((k) => drawn.has(k)),
          `${d.reason}: a state the page draws is compared, never declared whole`,
        ).toEqual([]);
      expect([d.reason, d.since, d.removedBy].every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    }
  });

  it("every registered state is drawn or stands in a row that says why not", () => {
    const declaredWhole = new Set(declared.filter((d) => d.notDrawn === "state").flatMap((d) => d.keys));
    expect(KEYS.map((k) => k.key).filter((k) => !drawn.has(k) && !declaredWhole.has(k))).toEqual([]);
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

  it.for(KEYS.filter((k) => drawn.has(k.key)))("$key", async ({ key, shard }) => {
    const ref = referenceOf(key, shard);
    const drew = await shoot(browser!, ref.variant, (page) => drawn.get(key)!(page, ref.variant));
    const sides = declaredOn(key, ref.scene, drew.scene);
    const pictures = { reference: decode(ref.png), actual: decode(drew.png) };
    const notDrawn = new Set(rowsOf(key).flatMap((d) => (Array.isArray(d.notDrawn) ? d.notDrawn : [])));
    const theirs = partsOf(sides.reference);
    const mine = partsOf(sides.actual);
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
      `${key}: a part of the Screener differs from the reference`,
    ).toEqual([]);
  });
});
