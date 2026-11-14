/* The model behind src/design: source/*.json read as an ordered list of blocks, each with the
   attributes it answers to, and the cascade a browser would compute from them.

   One block is one rule of the generated stylesheet. `when` names the root attributes of its
   selector; a block with more attributes wins over one with fewer, and of two with the same
   number the later one wins. That is CSS specificity for these selectors, so `resolve()` returns
   what a document stamped with `ctx` computes. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceDir = fileURLToPath(new URL("../source/", import.meta.url));
const readJson = (dir, name) => JSON.parse(readFileSync(`${dir}${name}`, "utf8"));

/** source/tokens.json, source/motion.json and source/fonts.json, from `dir` (the package's own by default). */
export function readSource(dir = sourceDir) {
  return { tokens: readJson(dir, "tokens.json"), motion: readJson(dir, "motion.json"), fonts: readJson(dir, "fonts.json") };
}

export class SourceError extends Error {}
const refuse = (msg) => {
  throw new SourceError(msg);
};

const NAME = /^[a-z][a-z0-9-]*$/;
/* What no value holds: an address or a host, a second declaration, a rule, markup, a comment. */
const FORBIDDEN = /url\(|\/\/|@|[;{}<>]|\/\*|\*\/|\\|\.example\b/i;

/** A source entry is a string or `{ value, note }`; the value is what ships. */
export const valueOf = (entry) => (typeof entry === "string" ? entry : entry?.value);

/** A flat `{ name: value }` map from a source block, every name and value checked. */
function decls(block, path) {
  const out = {};
  for (const [name, entry] of Object.entries(block ?? {})) {
    const value = valueOf(entry);
    if (!NAME.test(name)) refuse(`${path}: "${name}" is not a token name`);
    if (typeof value !== "string" || value.trim() === "") refuse(`${path}.${name}: no value`);
    if (FORBIDDEN.test(value)) refuse(`${path}.${name}: a value holds no address, rule or markup`);
    out[name] = value.trim();
  }
  return out;
}

/* The order of attributes in a selector, as the sheet writes them. `scheme` is last so that the
   system-scheme twin of a dark block differs from it in its last part alone. */
export const ATTRIBUTES = ["face", "accent", "device", "pose", "icons", "touch", "cal", "product", "sqtone", "scheme"];

const BEFORE_ACCENTS = [
  ["faces.paper.light", {}],
  ["faces.paper.dark", { scheme: "dark" }],
  ["faces.ohmarchy.light", { face: "ohmarchy" }],
  ["faces.ohmarchy.dark", { face: "ohmarchy", scheme: "dark" }],
  ["faces.paper.touch", { touch: "1" }],
  ["faces.ohmarchy.touch", { face: "ohmarchy", touch: "1" }],
  ["faces.paper.fold", { device: "fold" }],
  ["faces.paper.foldWords", { device: "fold", icons: "0" }],
  ["faces.ohmarchy.fold", { face: "ohmarchy", device: "fold" }],
];
const AFTER_ACCENTS = [
  ["sqtone.pale", { sqtone: "pale" }],
  ["sqtone.paler", { sqtone: "paler" }],
  ["faces.paper.phone", { device: "phone" }],
  ["calendar.paper.light", {}],
  ["calendar.paper.land", { face: "paper", pose: "land", icons: "1" }],
  ["calendar.paper.alone", { face: "paper", cal: "alone" }],
  ["calendar.paper.dark", { scheme: "dark" }],
  ["calendar.paper.touch", { touch: "1" }],
  ["calendar.paper.phone", { device: "phone" }],
  ["calendar.paper.fold", { device: "fold" }],
  ["product.cal", { product: "cal" }],
  ["calendar.ohmarchy.light", { face: "ohmarchy" }],
  ["calendar.ohmarchy.dark", { face: "ohmarchy", scheme: "dark" }],
];

export const FACES = ["paper", "ohmarchy"];
export const SCHEMES = ["light", "dark"];
/** The accent whose colours are the faces' own blocks; it has no block of its own. */
export const BASE_ACCENT = "base";

const at = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

function accentBlocks(tokens) {
  const out = [];
  for (const [name, accent] of Object.entries(tokens.accents ?? {})) {
    if (accent === BASE_ACCENT) continue;
    for (const face of FACES) {
      for (const scheme of SCHEMES) {
        const when = scheme === "dark" ? { face, accent: name, scheme } : { face, accent: name };
        out.push([`accents.${name}.${face}.${scheme}`, when]);
      }
    }
  }
  return out;
}

const KNOWN = {
  top: ["sheet", "productAccent", "faces", "accents", "readSquare", "sqtone", "product", "avatarHues", "tagHues", "calendar"],
  calendar: ["paper", "ohmarchy", "ring", "accents"],
};

/** Every key of `obj` at `path` is the name of a block in `table`, or the source is refused. */
function onlyBlocks(obj, path, table) {
  for (const key of Object.keys(obj ?? {})) {
    if (!table.some(([p]) => p === `${path}.${key}`)) refuse(`${path}.${key} is not a block this package emits`);
  }
}

/** The ordered blocks of the stylesheet: `{ path, when, decls }`. Refuses a source it cannot emit whole. */
export function blocksOf(tokens) {
  for (const key of Object.keys(tokens)) if (!KNOWN.top.includes(key)) refuse(`"${key}" is not a part of the source`);
  for (const key of Object.keys(tokens.calendar ?? {})) {
    if (!KNOWN.calendar.includes(key)) refuse(`calendar.${key} is not a part of the source`);
  }
  const table = [...BEFORE_ACCENTS, ...accentBlocks(tokens), ...AFTER_ACCENTS];
  for (const face of FACES) {
    onlyBlocks(tokens.faces?.[face], `faces.${face}`, table);
    onlyBlocks(tokens.calendar?.[face], `calendar.${face}`, table);
  }
  onlyBlocks(tokens.sqtone, "sqtone", table);
  onlyBlocks(tokens.product, "product", table);
  const blocks = table.map(([path, when], order) => ({ path, when, order, decls: decls(at(tokens, path), path) }));
  checkKeySets(blocks);
  return blocks;
}

/** The sheet's own rule: a token named in any block is named in the default block too. */
function checkKeySets(blocks) {
  const base = (path) => blocks.find((b) => b.path === path).decls;
  const mail = base("faces.paper.light");
  const calendar = base("calendar.paper.light");
  for (const name of Object.keys(calendar)) {
    if (name in mail) refuse(`calendar.paper.light.${name} is a token of faces.paper.light`);
  }
  for (const block of blocks) {
    const home = block.path.startsWith("calendar.") ? calendar : mail;
    for (const name of Object.keys(block.decls)) {
      if (!(name in home)) refuse(`${block.path}.${name} is not named in the default block`);
    }
  }
}

/** The selector of a block: `:root` and one attribute per condition, in the sheet's order. */
export function selectorOf(when, { systemScheme = false } = {}) {
  let out = ":root";
  for (const attr of ATTRIBUTES) {
    if (!(attr in when)) continue;
    out += attr === "scheme" && systemScheme ? ":not([data-scheme])" : `[data-${attr}="${when[attr]}"]`;
  }
  return out;
}

const matches = (when, ctx) => Object.entries(when).every(([attr, v]) => (ctx[attr] ?? DEFAULTS[attr]) === v);
/* What a document that stamps nothing answers to. A paper accent block names the face, so the
   resolved contexts stamp it. */
const DEFAULTS = { face: "paper", scheme: "light" };

/** The declarations a document stamped with `ctx` ends up with, still as written (aliases kept). */
export function cascade(blocks, ctx) {
  const applying = blocks.filter((b) => matches(b.when, ctx));
  applying.sort((a, b) => Object.keys(a.when).length - Object.keys(b.when).length || a.order - b.order);
  return Object.assign({}, ...applying.map((b) => b.decls));
}

const VAR = /var\(--([a-z0-9-]+)\)/g;

/** Every `var(--x)` replaced by what `x` resolves to in `map`. `initial` un-sets a token. */
export function resolveAll(map, extra = {}) {
  const scope = { ...extra, ...map };
  const done = {};
  const walk = (name, trail) => {
    if (name in done) return done[name];
    if (!(name in scope)) refuse(`var(--${name}) names no token (from ${trail.join(" > ")})`);
    if (trail.includes(name)) refuse(`var(--${name}) refers to itself (${trail.join(" > ")})`);
    done[name] = scope[name].replace(VAR, (_, ref) => walk(ref, [...trail, name]));
    return done[name];
  };
  const out = {};
  for (const name of Object.keys(map)) {
    const value = walk(name, []);
    if (value !== "initial") out[name] = value;
  }
  return out;
}

/** The motion blocks, checked: `reduced` may only name what `slick` names. */
export function motionOf(motion) {
  const known = ["m-time", "slick", "reduced", "calendar"];
  for (const key of Object.keys(motion)) if (!known.includes(key)) refuse(`motion "${key}" is not a part of the source`);
  const time = decls({ "m-time": motion["m-time"] }, "motion");
  const part = (src, path) => {
    const slick = decls(src.slick, `${path}.slick`);
    const reduced = decls(src.reduced, `${path}.reduced`);
    for (const name of Object.keys(reduced)) {
      if (!(name in slick)) refuse(`${path}.reduced.${name} is not named in ${path}.slick`);
    }
    return { slick, reduced };
  };
  const mail = part(motion, "motion");
  const calendar = part(motion.calendar ?? {}, "motion.calendar");
  for (const name of Object.keys(calendar.slick)) {
    if (name in mail.slick) refuse(`motion.calendar.slick.${name} is a token of motion.slick`);
  }
  return { time, slick: mail.slick, reduced: mail.reduced, calendar };
}
