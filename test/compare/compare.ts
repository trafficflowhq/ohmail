/**
 * The comparison of one rendered state with its reference: four questions, from the one that breaks
 * least to the one that breaks most.
 *
 *   names    what is there: the roles and names a screen reader would read, in order, and the words each
 *            node shows. Equal or red.
 *   boxes    where it sits: each matched node's box, each painted surface's and that of what a stylesheet
 *            draws before or after one, within `tolerance.box` CSS pixels.
 *   drawn    how it is drawn: the values a token carries, on the node, on the words inside it and on every
 *            surface that paints; how each of them is turned; and the font faces that arrived. The computed
 *            strings must be equal.
 *   picture  the pixels: the share that differs, over the whole picture and inside every node's region; and
 *            the largest mark, the differing pixels that touch one another.
 *
 * The first three fail a run. The picture fails for a state whose own picture was accepted
 * (`accepted.json`), and for any state when it differs grossly (`tolerance.grossRatio`); short of that it
 * reports. A state on the list of declared differences (`declared.json`) reports on every question and
 * fails on none. Nothing here opens a browser or a file: it is given two scenes and two pictures and says
 * how they differ.
 */
import pixelmatch from "pixelmatch";
import { decode, encode } from "./png.mjs";
import type { Picture } from "./png.d.mts";
import type { Tolerance } from "./render.d.mts";
import type { Drawn, Paint, Run, Scene, SceneNode, Surface, TextType } from "./scene.d.mts";

export type Verdict = "green" | "red" | "reported";

export interface Reading {
  verdict: Verdict;
  /** What differs, one line each, worst first where there is an order. */
  findings: string[];
}

export interface PictureReading extends Reading {
  /** The share of the whole picture's pixels that differ. */
  ratio: number;
  /** The worst region: the share of its pixels that differ, and whose it is. */
  worst: { ratio: number; node: string } | null;
  /** The largest mark: how many differing pixels touch one another, the box around them in picture pixels, and how many more marks are over the line. Null when no pixel differs or the sizes do. */
  mark: Mark | null;
  /** False when the two pictures are not the same size: nothing was compared, and that is always red. */
  sized: boolean;
  /** Every differing pixel drawn over nothing, an edge's too, as a PNG; absent when the sizes differ or nothing does. */
  diff?: Buffer;
}

export interface Mark {
  pixels: number;
  box: [number, number, number, number];
  more: number;
}

export interface StateVerdict {
  key: string;
  green: boolean;
  names: Reading;
  boxes: Reading;
  drawn: Reading;
  picture: PictureReading;
}

/** A declared difference: the whole state, or only the nodes it names. */
export interface Declared {
  key: string;
  reason: string;
  since: string;
  nodes?: { role: string; name: string }[];
}

export interface Rendering {
  scene: Scene;
  png: Uint8Array;
}

const DRAWN: (keyof Drawn)[] = [
  "color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "borderRadius",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderColor",
];

const said = (n: SceneNode): string => `${n.role}${n.level ? ` ${n.level}` : ""} "${n.name}"`;
const same = (a: SceneNode, b: SceneNode): boolean => a.role === b.role && a.name === b.name && (a.level ?? 0) === (b.level ?? 0);

/**
 * Pairs the two sequences along their longest common run of equal nodes, so one missing control does not
 * make every node after it a difference of place and of drawing as well.
 */
function pair(ref: SceneNode[], got: SceneNode[]): { pairs: [SceneNode, SceneNode][]; missing: SceneNode[]; extra: SceneNode[] } {
  const n = ref.length, m = got.length;
  const run: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) run[i]![j] = same(ref[i]!, got[j]!) ? run[i + 1]![j + 1]! + 1 : Math.max(run[i + 1]![j]!, run[i]![j + 1]!);
  }
  const pairs: [SceneNode, SceneNode][] = [], missing: SceneNode[] = [], extra: SceneNode[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (same(ref[i]!, got[j]!)) pairs.push([ref[i++]!, got[j++]!]);
    else if (run[i + 1]![j]! >= run[i]![j + 1]!) missing.push(ref[i++]!);
    else extra.push(got[j++]!);
  }
  while (i < n) missing.push(ref[i++]!);
  while (j < m) extra.push(got[j++]!);
  return { pairs, missing, extra };
}

/** Further apart than the tolerance. Boxes are tenths of a pixel held as binary fractions: a step of exactly the tolerance must not read as more. */
const over = (distance: number, tolerance: number): boolean => distance > tolerance + 1e-6;

const TYPE: (keyof TextType)[] = ["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "fontVariationSettings", "textTransform", "turn"];

/** A node's words as one string without spaces, and the style each character stands in: how a page cut them into pieces does not show. */
function letters(runs: Run[] | undefined): { text: string; type: number[] } {
  let text = "";
  const type: number[] = [];
  for (const r of runs ?? []) {
    const s = r.said.replace(/\s+/g, "");
    text += s;
    for (let i = 0; i < s.length; i++) type.push(r.type);
  }
  return { text, type };
}

/** The words inside one node: other words are a matter of names, the same words in another style of how they are drawn. */
function compareText(who: string, ref: { runs?: Run[]; types: TextType[] }, got: { runs?: Run[]; types: TextType[] }, names: string[], drawn: string[]): void {
  const r = letters(ref.runs), g = letters(got.runs);
  if (r.text !== g.text) {
    let at = 0;
    while (at < r.text.length && r.text[at] === g.text[at]) at++;
    const cut = (s: string): string => (s.length > 64 ? `${at > 24 ? "…" : ""}${s.slice(Math.max(0, at - 24), at + 40)}${s.length > at + 40 ? "…" : ""}` : s);
    names.push(`${who}: reads "${cut(g.text)}", the reference "${cut(r.text)}"`);
    return;
  }
  /* One line for each pair of styles that differ, with the first words they differ on. */
  const told = new Set<string>();
  for (let i = 0; i < r.text.length; i++) {
    const pair = `${r.type[i]}>${g.type[i]}`;
    if (told.has(pair)) continue;
    told.add(pair);
    const a = ref.types[r.type[i]!], b = got.types[g.type[i]!];
    if (!a || !b) throw new Error(`compare: ${who} names a text style its scene does not hold`);
    let end = i;
    while (end < r.text.length && r.type[end] === r.type[i] && g.type[end] === g.type[i]) end++;
    const words = r.text.slice(i, Math.min(end, i + 32));
    for (const k of TYPE) if (a[k] !== b[k]) drawn.push(`${who}: text "${words}" ${k} ${a[k] ?? "none"} is ${b[k] ?? "none"}`);
  }
}

const first = (p: Paint): string => { const k = Object.keys(p)[0]; return k ? `${k} ${p[k]}` : "nothing"; };

/**
 * The surfaces inside one node, paired by where they sit inside it: a node that moved takes its surfaces
 * along and is one difference, not one for each of them. A surface with no partner is a matter of where
 * things sit; a pair that paints differently, of how they are drawn.
 */
function compareSurfaces(
  who: string,
  ref: { surfaces?: Surface[]; paints: Paint[]; origin: [number, number] },
  got: { surfaces?: Surface[]; paints: Paint[]; origin: [number, number] },
  tolerance: number,
  boxes: string[],
  drawn: string[],
): void {
  const mine = got.surfaces ?? [];
  const used = new Set<number>();
  const paintOf = (side: { paints: Paint[] }, s: Surface): Paint => {
    const p = side.paints[s.paint];
    if (!p) throw new Error(`compare: ${who} names a paint its scene does not hold`);
    return p;
  };
  for (const r of ref.surfaces ?? []) {
    const a = paintOf(ref, r);
    let best = -1, least = Infinity;
    for (let j = 0; j < mine.length; j++) {
      if (used.has(j)) continue;
      const g = mine[j]!;
      const off = [r.box[0] - ref.origin[0] - (g.box[0] - got.origin[0]), r.box[1] - ref.origin[1] - (g.box[1] - got.origin[1]), r.box[2] - g.box[2], r.box[3] - g.box[3]].map(Math.abs);
      if (off.some((d) => over(d, tolerance))) continue;
      const b = paintOf(got, g);
      /* Of several in the same place, the one that paints alike is the partner. */
      const far = off.reduce((x, y) => x + y, 0) + (a === b || JSON.stringify(a) === JSON.stringify(b) ? 0 : 1000);
      if (far < least) { least = far; best = j; }
    }
    if (best < 0) { boxes.push(`${who}: nothing is drawn at [${r.box.join(", ")}], where the reference draws ${first(a)}`); continue; }
    used.add(best);
    const b = paintOf(got, mine[best]!);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) drawn.push(`${who}: at [${r.box.join(", ")}] ${k} ${a[k] ?? "none"} is ${b[k] ?? "none"}`);
    /* What a stylesheet draws before or after the element: its size, and its place where both sides say one. One that is drawn on one side only has said so by its paint. */
    for (const part of ["before", "after"] as const) {
      const p = r.parts?.[part], q = mine[best]!.parts?.[part];
      if (!p || !q) continue;
      const n = Math.min(p.length, q.length);
      if (p.slice(-n).some((v, k) => over(Math.abs(v - q.slice(-n)[k]!), tolerance))) boxes.push(`${who}: at [${r.box.join(", ")}] the box drawn ${part} it is [${q.join(", ")}], the reference's [${p.join(", ")}]`);
    }
  }
  mine.forEach((g, j) => { if (!used.has(j)) boxes.push(`${who}: draws ${first(paintOf(got, g))} at [${g.box.join(", ")}], which the reference does not`); });
}

/** The reader both scenes must come from: one that reads more, or otherwise, writes scenes that only look alike. */
const READER = 5;

/** The first three questions. `declared` takes its named nodes out of both sides before anything is asked. */
export function compareScenes(
  reference: Scene,
  actual: Scene,
  tolerance: Pick<Tolerance, "box">,
  declared?: Declared,
): { names: Reading; boxes: Reading; drawn: Reading; pairs: [SceneNode, SceneNode][] } {
  for (const [whose, s] of [["the reference's", reference], ["the product's", actual]] as const) {
    if (s.reader !== READER) throw new Error(`compare: ${whose} data file was read by reader ${String(s.reader ?? 1)}, and this comparison reads reader ${READER}: derive the data file again`);
  }
  const out = (n: SceneNode): boolean => !!declared?.nodes?.some((d) => d.role === n.role && d.name === n.name);
  const { pairs, missing, extra } = pair(reference.nodes.filter((n) => !out(n)), actual.nodes.filter((n) => !out(n)));
  const verdict = (findings: string[]): Reading => ({ verdict: findings.length ? "red" : "green", findings });

  const names = [...missing.map((n) => `missing: ${said(n)}`), ...extra.map((n) => `not in the reference: ${said(n)}`)];
  const boxes: string[] = [];
  const drawn: string[] = [];
  for (const [r, g] of pairs) {
    const off = r.box.map((v, k) => Math.abs(v - g.box[k]!));
    if (off.some((d) => over(d, tolerance.box))) boxes.push(`${said(r)}: box [${r.box.join(", ")}] is [${g.box.join(", ")}]`);
    for (const k of DRAWN) if (r.drawn[k] !== g.drawn[k]) drawn.push(`${said(r)}: ${k} ${r.drawn[k]} is ${g.drawn[k]}`);
    if (r.turn !== g.turn) drawn.push(`${said(r)}: turn ${r.turn ?? "none"} is ${g.turn ?? "none"}`);
    compareText(said(r), { runs: r.text, types: reference.types }, { runs: g.text, types: actual.types }, names, drawn);
    compareSurfaces(said(r), { surfaces: r.surfaces, paints: reference.paints, origin: [r.box[0], r.box[1]] }, { surfaces: g.surfaces, paints: actual.paints, origin: [g.box[0], g.box[1]] }, tolerance.box, boxes, drawn);
  }
  compareText("outside every node", { runs: reference.loose.text, types: reference.types }, { runs: actual.loose.text, types: actual.types }, names, drawn);
  compareSurfaces("outside every node", { surfaces: reference.loose.surfaces, paints: reference.paints, origin: [0, 0] }, { surfaces: actual.loose.surfaces, paints: actual.paints, origin: [0, 0] }, tolerance.box, boxes, drawn);
  /* A face that did not arrive leaves the font-family string as it was, and the words in another font. Asked of the faces the reference's words are set in: a face a page declares and sets nothing in is not missed. */
  const set = new Set([...reference.types.map((t) => t.fontFamily), ...reference.nodes.map((n) => n.drawn.fontFamily)].map((f) => (f.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "")));
  for (const f of reference.fonts) {
    if (set.has(f.family) && !actual.fonts.some((a) => a.family === f.family && a.style === f.style)) drawn.push(`the face "${f.family}" (${f.style}) is not loaded; the reference had it`);
  }
  if (reference.page.clientWidth !== actual.page.clientWidth) boxes.push(`the window is ${actual.page.clientWidth} wide, the reference's ${reference.page.clientWidth}`);
  if (actual.page.scrollWidth > actual.page.clientWidth && reference.page.scrollWidth <= reference.page.clientWidth) {
    boxes.push(`the page scrolls sideways: ${actual.page.scrollWidth} in ${actual.page.clientWidth}`);
  }
  return { names: verdict(names), boxes: verdict(boxes), drawn: verdict([...new Set(drawn)]), pairs };
}

/**
 * The marks of a picture: its differing pixels in groups that touch one another, a corner counts. Returns
 * the largest, and how many others are over `line` pixels. A person sees a changed mark as one thing,
 * whatever share of a row it is; a share alone lets it through.
 */
function marksOf(mask: Uint8Array, width: number, height: number, line: number): Mark | null {
  const todo = new Uint8Array(width * height);
  let left = 0;
  for (let i = 0; i < todo.length; i++) if (mask[i * 4 + 3] !== 0) { todo[i] = 1; left++; }
  if (!left) return null;
  const stack = new Int32Array(left);
  let largest: Mark | null = null, over = 0;
  for (let start = 0; start < todo.length && left > 0; start++) {
    if (!todo[start]) continue;
    let top = 0, pixels = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    stack[top++] = start;
    todo[start] = 0;
    while (top > 0) {
      const at = stack[--top]!, x = at % width, y = (at - x) / width;
      pixels++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const next = ny * width + nx;
          if (todo[next]) { todo[next] = 0; stack[top++] = next; }
        }
      }
    }
    left -= pixels;
    if (pixels > line) over++;
    if (!largest || pixels > largest.pixels) largest = { pixels, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], more: 0 };
  }
  if (largest && largest.pixels > line) largest.more = over - 1;
  return largest;
}

/**
 * The fourth question. A picture of another size is red and is never scaled to fit. `regions` are node
 * boxes in CSS pixels; each is grown to `regionFloor` a side and read on its own, against the region's
 * own line: a region is a small part of a picture, and a share of it is not a share of the whole. A mark
 * of more than `mark` pixels that touch is red whatever its share.
 */
export function comparePictures(
  reference: Picture,
  actual: Picture,
  regions: { node: string; box: [number, number, number, number] }[],
  scale: number,
  tolerance: Pick<Tolerance, "pictureRatio" | "regionRatio" | "regionFloor" | "pixel" | "mark">,
): PictureReading {
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return { verdict: "red", ratio: 1, worst: null, mark: null, sized: false, findings: [`the picture is ${actual.width} × ${actual.height}, the reference's ${reference.width} × ${reference.height}`] };
  }
  const { width, height } = reference;
  const mask = new Uint8Array(width * height * 4);
  const differing = pixelmatch(reference.data, actual.data, mask, width, height, { threshold: tolerance.pixel, includeAA: false, diffMask: true });
  const ratio = differing / (width * height);
  const findings: string[] = [];
  if (ratio > tolerance.pictureRatio) findings.push(`${differing} of ${width * height} pixels differ (${ratio.toFixed(6)} > ${tolerance.pictureRatio})`);

  /* Differing pixels above and to the left of each point, so a region is read in four lookups. */
  const sum = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3] !== 0) row++;
      sum[(y + 1) * (width + 1) + x + 1] = sum[y * (width + 1) + x + 1]! + row;
    }
  }
  let worst: PictureReading["worst"] = null;
  const red: { ratio: number; line: string }[] = [];
  for (const { node, box } of regions) {
    const grow = (at: number, len: number): [number, number] => (len >= tolerance.regionFloor ? [at, len] : [at - (tolerance.regionFloor - len) / 2, tolerance.regionFloor]);
    const [x, w] = grow(box[0], box[2]), [y, h] = grow(box[1], box[3]);
    const x0 = Math.max(0, Math.floor(x * scale)), y0 = Math.max(0, Math.floor(y * scale));
    const x1 = Math.min(width, Math.ceil((x + w) * scale)), y1 = Math.min(height, Math.ceil((y + h) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    const at = (px: number, py: number): number => sum[py * (width + 1) + px]!;
    const inside = at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0);
    const share = inside / ((x1 - x0) * (y1 - y0));
    if (!worst || share > worst.ratio) worst = { ratio: share, node };
    if (share > tolerance.regionRatio) red.push({ ratio: share, line: `${node}: ${inside} of ${(x1 - x0) * (y1 - y0)} pixels differ in its region (${share.toFixed(4)} > ${tolerance.regionRatio})` });
  }
  red.sort((a, b) => b.ratio - a.ratio);
  findings.push(...red.map((r) => r.line));
  /* The marks are read with every differing pixel in. The shares leave out what pixelmatch takes for a soft edge, and with it most of a thin stroke that moved: a caret turned over counts a handful of pixels there. */
  const every = new Uint8Array(width * height * 4);
  const any = pixelmatch(reference.data, actual.data, every, width, height, { threshold: tolerance.pixel, includeAA: true, diffMask: true });
  const mark = any ? marksOf(every, width, height, tolerance.mark) : null;
  if (mark && mark.pixels > tolerance.mark) {
    /* Whose it is: the smallest node around the mark's middle. Where it is: in CSS pixels, as every box is said. */
    const mx = (mark.box[0] + mark.box[2] / 2) / scale, my = (mark.box[1] + mark.box[3] / 2) / scale;
    let whose = "outside every node", least = Infinity;
    for (const { node, box } of regions) {
      if (mx < box[0] || my < box[1] || mx > box[0] + box[2] || my > box[1] + box[3] || box[2] * box[3] >= least) continue;
      least = box[2] * box[3];
      whose = node;
    }
    const where = mark.box.map((v) => Math.round((v / scale) * 10) / 10).join(", ");
    findings.push(`${whose}: a mark of ${mark.pixels} pixels that touch differs at [${where}] (> ${tolerance.mark})${mark.more ? `, and ${mark.more} more mark${mark.more > 1 ? "s" : ""} over the line` : ""}`);
  }
  return { verdict: findings.length ? "red" : "green", ratio, worst, mark, sized: true, findings, diff: any ? encode({ width, height, data: every }) : undefined };
}

/**
 * All four questions for one state.
 * @param accepted the state's own picture was accepted, so a picture that differs at all fails
 */
export function compareState(input: {
  key: string;
  reference: Rendering;
  actual: Rendering;
  tolerance: Tolerance;
  declared?: Declared;
  accepted: boolean;
}): StateVerdict {
  const { key, reference, actual, tolerance, declared, accepted } = input;
  const scenes = compareScenes(reference.scene, actual.scene, tolerance, declared);
  const scale = reference.scene.variant.scale;
  const picture = comparePictures(
    decode(reference.png),
    decode(actual.png),
    scenes.pairs.map(([r]) => ({ node: said(r), box: r.box })),
    scale,
    tolerance,
  );
  /* A wrong size is the harness drawing the wrong window, and a gross difference is another screen: red whatever the state's standing. */
  const gross = picture.ratio > tolerance.grossRatio;
  if (gross) picture.findings.unshift(`${(picture.ratio * 100).toFixed(1)} % of the picture differs: over ${tolerance.grossRatio * 100} % fails for any state`);
  if (picture.verdict === "red" && !accepted && picture.sized && !gross) picture.verdict = "reported";
  const whole = !!declared && !declared.nodes;
  const soften = (r: Reading): Reading => (whole && r.verdict === "red" ? { ...r, verdict: "reported" } : r);
  const names = soften(scenes.names), boxes = soften(scenes.boxes), drawn = soften(scenes.drawn);
  if (whole && picture.verdict === "red" && picture.sized) picture.verdict = "reported";
  const green = [names, boxes, drawn, picture].every((r) => r.verdict !== "red");
  return { key, green, names, boxes, drawn, picture };
}

/** One line a state, for a log; the findings under it when anything was said. */
export function describeVerdict(v: StateVerdict, most = 8): string {
  const head = `COMPARE ${v.green ? "green" : "RED"} ${v.key} names=${v.names.verdict} boxes=${v.boxes.verdict} drawn=${v.drawn.verdict} picture=${v.picture.verdict} ratio=${v.picture.ratio.toFixed(6)}${v.picture.mark ? ` mark=${v.picture.mark.pixels}` : ""}${v.picture.worst ? ` worst=${v.picture.worst.ratio.toFixed(4)} (${v.picture.worst.node})` : ""}`;
  const lines: string[] = [];
  for (const [q, r] of [["names", v.names], ["boxes", v.boxes], ["drawn", v.drawn], ["picture", v.picture]] as const) {
    for (const f of r.findings.slice(0, most)) lines.push(`  ${q}: ${f}`);
    if (r.findings.length > most) lines.push(`  ${q}: … and ${r.findings.length - most} more`);
  }
  return [head, ...lines].join("\n");
}
