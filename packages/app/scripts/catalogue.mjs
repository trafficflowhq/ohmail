#!/usr/bin/env node
/**
 * THE CATALOGUES, ONE FILE PER PLACE AND LANGUAGE. The sentences live in `packages/app/messages/<place>.<lang>.json`,
 * each a JSON object whose top-level keys are that place's namespaces; `places.json` says which place holds which
 * namespace and `order.json` the order of the whole. `apps/webapp/messages/en.json` and `de.json` are ASSEMBLED from
 * them, as text, and committed: every loader and every test that imports them by path reads the same bytes it always
 * read.
 *
 * Text, never `JSON.stringify`: the files mix raw characters and `\u` escapes, and a rewrite would change most of
 * their bytes. A namespace's block is cut and joined as the lines it is written in.
 *
 *   node packages/app/scripts/catalogue.mjs --write           assemble the two aggregates (and append a new namespace
 *                                                             to order.json)
 *   node packages/app/scripts/catalogue.mjs --check           assemble in memory; refuse a difference by bytes, a
 *                                                             namespace in no place or in two, a place file whose
 *                                                             namespaces are not its row of places.json
 *   node packages/app/scripts/catalogue.mjs --prove <commit>  the aggregates are the commit's, byte for byte, and the
 *                                                             place files hold every key and value the commit held
 *   node packages/app/scripts/catalogue.mjs --cut             once: slice the aggregates into the place files
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const LANGS = /** @type {const} */ (["en", "de"]);
const MESSAGES = "packages/app/messages";
const aggregatePath = (lang) => `apps/webapp/messages/${lang}.json`;
const placePath = (place, lang) => `${MESSAGES}/${place}.${lang}.json`;

/** A namespace's first line: two spaces, its quoted name, a colon. Nested keys sit deeper. */
const HEAD = /^ {2}"([^"\\]+)": /;

/**
 * The blocks of one catalogue file, in their order: each namespace's lines as written, without the comma that
 * separates it from the next.
 * @param {string} text
 * @param {string} where
 * @returns {{ name: string, text: string }[]}
 */
export function blocksOf(text, where) {
  if (!text.startsWith("{\n") || !text.endsWith("\n}\n"))
    throw new Error(`${where}: not one object of two-space lines`);
  const lines = text.slice(2, -3).split("\n");
  /** @type {{ name: string, lines: string[] }[]} */
  const blocks = [];
  for (const line of lines) {
    const head = HEAD.exec(line);
    if (head) blocks.push({ name: head[1], lines: [line] });
    else if (blocks.length === 0) throw new Error(`${where}: a line before the first namespace`);
    else blocks.at(-1).lines.push(line);
  }
  return blocks.map((block, i) => {
    const body = block.lines.join("\n");
    if (i < blocks.length - 1 && !body.endsWith(","))
      throw new Error(`${where}: ${block.name} is not followed by a comma`);
    return { name: block.name, text: i < blocks.length - 1 ? body.slice(0, -1) : body };
  });
}

/** @param {{ text: string }[]} blocks */
export const fileOf = (blocks) => `{\n${blocks.map((b) => b.text).join(",\n")}\n}\n`;

/** @param {string} root @param {string} rel */
const readText = (root, rel) => readFileSync(join(root, rel), "utf8");
/** @param {string} root @param {string} rel */
const readJson = (root, rel) => JSON.parse(readText(root, rel));

/**
 * Assemble both aggregates from the place files of `root`.
 * @param {string} root
 * @returns {{ aggregates: Record<string, string>, order: string[], problems: string[] }}
 */
export function assemble(root = ROOT) {
  /** @type {Record<string, string[]>} */
  const places = readJson(root, `${MESSAGES}/places.json`);
  /** @type {string[]} */
  const order = readJson(root, `${MESSAGES}/order.json`);
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const home = new Map();
  for (const [place, names] of Object.entries(places)) {
    for (const name of names) {
      const other = home.get(name);
      if (other !== undefined) problems.push(`${name} is in two places: ${other} and ${place}`);
      else home.set(name, place);
    }
  }
  for (const name of order) if (!home.has(name)) problems.push(`${name} is in order.json and in no place`);
  const fullOrder = [...order, ...[...home.keys()].filter((name) => !order.includes(name))];
  /** @type {Record<string, string>} */
  const aggregates = {};
  for (const lang of LANGS) {
    /** @type {Map<string, string>} */
    const byName = new Map();
    for (const [place, names] of Object.entries(places)) {
      const rel = placePath(place, lang);
      if (!existsSync(join(root, rel))) {
        problems.push(`${rel} is missing`);
        continue;
      }
      const blocks = blocksOf(readText(root, rel), rel);
      const held = blocks.map((b) => b.name);
      if (!isDeepStrictEqual([...held].sort(), [...names].sort())) {
        problems.push(`${rel} holds ${held.join(", ")}; places.json says ${names.join(", ")}`);
      }
      for (const block of blocks) {
        if (byName.has(block.name)) problems.push(`${block.name} is written twice in ${lang}`);
        byName.set(block.name, block.text);
      }
    }
    aggregates[lang] = fileOf(
      fullOrder.filter((name) => byName.has(name)).map((name) => ({ text: byName.get(name) })),
    );
  }
  return { aggregates, order: fullOrder, problems };
}

/**
 * What `--check` refuses, as sentences; empty when the committed aggregates are what the place files assemble to.
 * @param {string} root
 * @returns {string[]}
 */
export function check(root = ROOT) {
  const { aggregates, problems } = assemble(root);
  for (const lang of LANGS) {
    const committed = readText(root, aggregatePath(lang));
    if (committed === aggregates[lang]) continue;
    /** @type {{ name: string, text: string }[]} */
    let have;
    try {
      have = blocksOf(committed, aggregatePath(lang));
    } catch (error) {
      problems.push(`${error instanceof Error ? error.message : String(error)}: run --write, never edit it`);
      continue;
    }
    const want = blocksOf(aggregates[lang], `${lang} as assembled`);
    const at = want.findIndex((block, i) => have[i]?.name !== block.name || have[i]?.text !== block.text);
    const name = at === -1 ? (have[want.length]?.name ?? "(the file's end)") : want[at].name;
    problems.push(
      `${aggregatePath(lang)} differs from its place files, first at ${name}: run --write, never edit it`,
    );
  }
  return problems;
}

/** @param {string} root */
export function write(root = ROOT) {
  const { aggregates, order, problems } = assemble(root);
  if (problems.length > 0) return problems;
  for (const lang of LANGS) writeFileSync(join(root, aggregatePath(lang)), aggregates[lang]);
  writeFileSync(join(root, `${MESSAGES}/order.json`), `${JSON.stringify(order, null, 2)}\n`);
  return [];
}

/** @param {unknown} tree @returns {number} */
const leaves = (tree) =>
  typeof tree === "object" && tree !== null ? Object.values(tree).reduce((n, v) => n + leaves(v), 0) : 1;

/**
 * The aggregates are the commit's byte for byte, and the parsed union of the place files is the commit's parse.
 * @param {string} commit
 * @param {string} root
 */
export function prove(commit, root = ROOT) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Record<string, string[]>} */
  const places = readJson(root, `${MESSAGES}/places.json`);
  let ok = true;
  for (const lang of LANGS) {
    const then = execFileSync("git", ["-C", root, "show", `${commit}:${aggregatePath(lang)}`], {
      maxBuffer: 1 << 26,
    });
    const now = readFileSync(join(root, aggregatePath(lang)));
    const sha = (/** @type {Buffer} */ b) => createHash("sha256").update(b).digest("hex");
    const union = Object.assign(
      {},
      ...Object.keys(places).map((place) => readJson(root, placePath(place, lang))),
    );
    const parsed = JSON.parse(then.toString("utf8"));
    const same = sha(then) === sha(now);
    const equal = isDeepStrictEqual(union, parsed);
    ok &&= same && equal;
    lines.push(
      `${lang}: sha256 ${sha(now)} ${same ? "=" : "!="} ${commit}'s; place files ${equal ? "=" : "!="} its parse; ` +
        `${Object.keys(union).length} namespaces, ${leaves(union)} keys`,
    );
  }
  return { ok, lines };
}

/** Once: slice each aggregate at its namespaces and write the place files, each block's text unchanged. */
export function cut(root = ROOT) {
  /** @type {Record<string, string[]>} */
  const places = readJson(root, `${MESSAGES}/places.json`);
  /** @type {string[] | null} */
  let order = null;
  for (const lang of LANGS) {
    const blocks = blocksOf(readText(root, aggregatePath(lang)), aggregatePath(lang));
    order ??= blocks.map((b) => b.name);
    for (const [place, names] of Object.entries(places)) {
      writeFileSync(join(root, placePath(place, lang)), fileOf(blocks.filter((b) => names.includes(b.name))));
    }
  }
  writeFileSync(join(root, `${MESSAGES}/order.json`), `${JSON.stringify(order, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [verb, arg] = process.argv.slice(2);
  /** @param {string[]} problems */
  const finish = (problems) => {
    for (const p of problems) console.error(`catalogue: ${p}`);
    process.exit(problems.length > 0 ? 1 : 0);
  };
  if (verb === "--check") finish(check());
  else if (verb === "--write") finish(write());
  else if (verb === "--cut") {
    cut();
    finish(check());
  } else if (verb === "--prove" && arg) {
    const { ok, lines } = prove(arg);
    for (const line of lines) console.log(line);
    process.exit(ok ? 0 : 1);
  } else {
    console.error("usage: catalogue.mjs --check | --write | --prove <commit> | --cut");
    process.exit(2);
  }
}
