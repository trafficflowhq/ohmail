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
import { subjects } from "../../../../test/compare/subjects/compose.js";
import { declaredOn as declaredBy, partsOf, type Box, type Part } from "./write-cut.js";
import { WRITE_CLASSES, WRITE_PARTS, type WriteDeclaredRow, type WritePart } from "./write-classes.js";

/**
 * WRITE'S PARTS of the screen `compose`, each against the same part of the reference's picture and data file
 * (`node test/compare/fetch.mjs --from <the shards>`, then
 * `npx vitest run --config vitest.compare.config.ts packages/app/test/compare/write-parts.compare.ts`). The shard is
 * named to the fetch by `test/compare/subjects/compose.ts`, whose keys are the states the page draws; a shard not in
 * build/reference is red here, never a skip.
 *
 * The reference stands the letter in the reading column beside the Drafts list and the frame's rail; the rail, the
 * list and what stands above a forward's letter (the original, the reader's) are not write's. What is write's is cut
 * out of both sides alike with the kit's `cutScene` and held by the comparison's four questions, none softened, each
 * part by its box:
 *
 * - status: a line over the letter's people (what happened to the send, a From note, a draft moved elsewhere);
 * - head: the From line, the people and the subject;
 * - marks: the formatting strip; tabs: Your text and Draft;
 * - text: the letter's text; signature: the signature and its way off;
 * - files: the letter's own files and a forward's, with their headings;
 * - notes: each line over the foot; foot: the foot's toolbar; verbs: Send and its neighbours;
 * - over: a menu, a card, a dialog or the suggestions standing over the letter.
 *
 * Every part but the head, the verbs and what stands over the letter is compared from its own corner: where it
 * stands follows the text above it. The differences that stay are the rows of `write-declared.json`, each in one
 * named class of `write-classes.ts` with a reason a person can check against the design. What a part that is not
 * green drew is written to build/compare/write-parts/.
 */

const ROOT = process.cwd();
const COMPARE = resolve(ROOT, "test/compare");
const REFERENCE = resolve(ROOT, "build/reference");
const OUT = resolve(ROOT, "build/compare/write-parts");
const SHARDS = ["compose"] as const;
type Shard = (typeof SHARDS)[number];

type PartName = WritePart;
const PARTS: readonly PartName[] = WRITE_PARTS;
type DeclaredRow = WriteDeclaredRow;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const registry = json<Registry>(join(COMPARE, "registry.json"));
const manifest = json<Manifest>(join(COMPARE, "manifest.json"));
const declared = json<DeclaredRow[]>(resolve(ROOT, "packages/app/test/compare/write-declared.json"));
const KEYS: readonly { key: string; shard: Shard }[] = registry.states
  .filter((s) => s.screen === "compose")
  .map((s) => ({ key: s.key, shard: "compose" as const }));
const ALL_KEYS = new Set(KEYS.map((k) => k.key));

const said = (n: SceneNode): string => `${n.role} "${n.name}"`;
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

describe("write's parts of the screen compose, against the reference's", () => {
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
      expect(Object.keys(WRITE_CLASSES), d.reason).toContain(d.class);
      expect(d.keys.length, d.reason).toBeGreaterThan(0);
      expect(
        d.keys.filter((k) => !ALL_KEYS.has(k)),
        d.reason,
      ).toEqual([]);
      expect(
        [d.out, d.unnamed, d.pairs, d.notDrawn].some((list) => Boolean(list?.length)),
        `${d.reason}: names no node, no pair and no part`,
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
    const sides = declaredBy(rowsOf(key), key, ref.scene, drew.scene);
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
      `${key}: a part of the letter differs from the reference`,
    ).toEqual([]);
  });
});
