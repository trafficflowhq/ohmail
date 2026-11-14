#!/usr/bin/env node
/**
 * node --import tsx test/compare/prove.mjs --studio <dir> --tag <tag> --work <empty dir> [--keys <key>,…]
 *
 * Shows the comparison biting on the design reference itself. For each key it draws the state from the
 * tag twice, and from a copy of the tag with one thing changed in the reference's token sheet, and says
 * what each of the four questions reads. Two parts:
 *
 *   NAMED    one change each, with the reading it must give (the table below): the state against itself is
 *            green on all four; a colour, a spacing step, a sheet that takes the ground's colour, a radius,
 *            a text size, an icon's stroke, the cap of an icon's lines, an icon no longer turned, a caret
 *            that is a bordered box turned the other way and a text face that is not declared are each
 *            red, and each on the question that asks for it.
 *   TOKENS   every colour of the reference's default block, changed to another colour, one at a time. Where
 *            the change shows in a state's picture, the state must be RED though nobody accepted its
 *            picture: no colour that draws may pass as "reported".
 *
 * A maintainer runs it when the tool, the reader or the tolerance changes. It writes only into --work,
 * which the caller removes. Exit 0 when every reading is as named, 1 otherwise.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { captureState } from "./capture.mjs";
import { compareState, describeVerdict } from "./compare.ts";
import { decode } from "./png.mjs";
import { deriveRegistry, keyOf } from "./registry.mjs";
import { launch, RequestLost, TOLERANCE } from "./render.mjs";
import { commitOf, extractSimulator, readScreens, serveLoopback, windows } from "./studio.mjs";

const argv = process.argv.slice(2);
const value = (/** @type {string} */ flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const studio = value("--studio"), tag = value("--tag"), work = value("--work");
if (!studio || !tag || !work) { process.stderr.write("usage: prove.mjs --studio <dir> --tag <tag> --work <empty dir> [--keys <key>,…]\n"); process.exit(2); }

const SHEET = "core/tokens.css";
/**
 * One change each, as the reference's sheet writes it; a change that finds nothing to change is refused.
 * `expect` names the reading: of a question, with the state's picture accepted; and of the `state` as a
 * whole when it is not, which is how every reference state stands until its screen is accepted.
 * A change marked `whereItDraws` is held to its reading in the states whose picture it moves, and must move one.
 * @type {Record<string, { from: string | RegExp, to: string, expect: Record<string, string>, whereItDraws?: boolean }>}
 */
const CHANGES = {
  colour: { from: "--hot:#F8431A;", to: "--hot:#1F4BFF;", expect: { names: "green", drawn: "red", picture: "red", state: "red" } },
  "colour-step": { from: "--hot:#F8431A;", to: "--hot:#F8431B;", expect: { names: "green", boxes: "green", drawn: "red", picture: "green", state: "red" } },
  spacing: { from: "--s3:12px;", to: "--s3:16px;", expect: { names: "green", boxes: "red", drawn: "red", state: "red" } },
  "sheet-is-ground": { from: "--sheet:#FFFFFF;", to: "--sheet:#F0EBE3;", expect: { names: "green", picture: "red", state: "red" } },
  radius: { from: "--r-sheet:20px;", to: "--r-sheet:0px;", expect: { names: "green", drawn: "red", state: "red" } },
  /* Larger or other letters also move what the reference fits by measuring, so names and boxes may differ too. */
  "text-size": { from: "--t-meta:13px;", to: "--t-meta:14px;", expect: { drawn: "red", state: "red" } },
  "icon-stroke": { from: "--ico-w:1.8;", to: "--ico-w:2.4;", expect: { names: "green", drawn: "red", state: "red" } },
  /* A line's end moves no box, colour or width, and a few hundred pixels of a screen: far under every line of the picture. */
  "icon-cap": { from: "--ico-cap:round;", to: "--ico-cap:butt;", expect: { names: "green", boxes: "green", drawn: "red", state: "red" } },
  /* The reference points a chevron by turning its icon: unturned, it moves some forty pixels of a screen, and no box, colour or stroke. */
  "icon-turn": { from: /$/, to: "\nsvg.ic{transform:none!important}\n", expect: { names: "green", boxes: "green", drawn: "red", state: "red" }, whereItDraws: true },
  /* The reference draws a slot's caret as a bordered box that a rule turns to point down. Pointing up, it moves some thirty pixels of a screen and no box: under every share of the picture, and over its mark line. */
  "caret-turn": { from: /$/, to: "\n.fs .slot .sc{transform:translateY(-.2em) rotate(225deg)!important}\n", expect: { names: "green", boxes: "green", drawn: "red", picture: "red", state: "red" }, whereItDraws: true },
  "text-face-missing": { from: /@font-face\{font-family:"Hanken Grotesk";[^}]*\}\s*/g, to: "", expect: { drawn: "red", state: "red" } },
};
/** What a changed colour becomes: a colour the design does not hold. */
const OTHER = "#1F4BFF", OTHER_FOR_BLUE = "#0A7F3F";
/** A change shows in a state when a pixel moves by more than this many steps of a channel; the changes made here move theirs by far more. */
const DRAW_STEPS = 4;

const at = { studioTag: tag, studioCommit: commitOf(studio, tag) };
const registry = deriveRegistry(readScreens(studio, tag), at);
const keys = (value("--keys") ?? "screen=ohbox&open=ben-kiln&hold=1,screen=ohbox&device=phone,screen=settings&sec=general,screen=settings&sec=ai").split(",").map(keyOf);

/** Unpacks the tag into its own folder under --work. @param {string} name */
function site(name) {
  const dir = join(resolve(work), name);
  mkdirSync(dir, { recursive: true });
  return extractSimulator(studio, tag, dir);
}

/** The pixels that moved by more than two draws of one page do. @param {Uint8Array} a @param {Uint8Array} b */
function moved(a, b) {
  const x = decode(a), y = decode(b);
  if (x.width !== y.width || x.height !== y.height) return x.width * x.height;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) > DRAW_STEPS || Math.abs(x.data[i + 1] - y.data[i + 1]) > DRAW_STEPS || Math.abs(x.data[i + 2] - y.data[i + 2]) > DRAW_STEPS) n++;
  }
  return n;
}

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const browser = await launch(require_("@playwright/test").chromium);
let wrong = 0;
try {
  const tagDir = site("tag"), changedDir = site("changed");
  const original = readFileSync(join(tagDir, SHEET), "utf8");
  const reference = await serveLoopback(tagDir), changed = await serveLoopback(changedDir);
  const windowOf = windows(tagDir, async () => browser, reference.base);
  const draw = async (/** @type {string} */ base, /** @type {string} */ key) => {
    const state = registry.states.find((s) => s.key === key);
    if (!state) throw new Error(`prove: ${key} is not a registered state`);
    /* A page that lost a file is drawn again, as the capture does: the host's network moving under a draw is no reading. */
    for (let attempt = 1; ; attempt++) {
      try { return await captureState(browser, base, state, await windowOf(key), at); } catch (e) { if (!(e instanceof RequestLost) || attempt === 4) throw e; }
    }
  };
  /** Writes the changed copy's sheet and draws every key from it. @param {string} text */
  const drawChanged = async (text) => { writeFileSync(join(changedDir, SHEET), text); return Promise.all(keys.map((k) => draw(changed.base, k))); };
  const ask = (/** @type {string} */ key, /** @type {any} */ first, /** @type {any} */ other, /** @type {boolean} */ accepted) => compareState({ key, reference: first, actual: other, tolerance: TOLERANCE, accepted });

  const firsts = await Promise.all(keys.map((k) => draw(reference.base, k)));
  const say = (/** @type {string} */ name, /** @type {any[]} */ others, /** @type {Record<string, string>} */ expect, whereItDraws = false) => {
    if (whereItDraws && !keys.some((_key, n) => moved(firsts[n].png, others[n].png))) { wrong++; process.stdout.write(`PROVE ${name} WRONG (it draws in none of these states)\n`); }
    keys.forEach((key, n) => {
      if (whereItDraws && !moved(firsts[n].png, others[n].png)) { process.stdout.write(`PROVE ${name} does not draw in ${key}\n`); return; }
      const v = ask(key, firsts[n], others[n], true), unaccepted = ask(key, firsts[n], others[n], false);
      const read = { names: v.names.verdict, boxes: v.boxes.verdict, drawn: v.drawn.verdict, picture: v.picture.verdict, state: unaccepted.green ? "green" : "red" };
      const off = Object.entries(expect).filter(([q, want]) => read[/** @type {keyof typeof read} */ (q)] !== want).map(([q, want]) => `${q} should read ${want}`);
      if (off.length) wrong++;
      process.stdout.write(`PROVE ${name} ${off.length ? `WRONG (${off.join(", ")})` : "as named"}; not accepted: ${read.state}\n${describeVerdict(v, 3)}\n`);
    });
  };

  say("itself", await Promise.all(keys.map((k) => draw(reference.base, k))), { names: "green", boxes: "green", drawn: "green", picture: "green", state: "green" });
  for (const [name, change] of Object.entries(CHANGES)) {
    const text = original.replace(change.from, change.to);
    if (text === original) throw new Error(`prove: ${SHEET} at ${tag} has nothing for the change "${name}"`);
    say(name, await drawChanged(text), change.expect, change.whereItDraws);
  }

  /* Every colour of the default block: the first block of the sheet that sets values. */
  const from = original.indexOf(".fs{"), to = original.indexOf("\n}", from);
  if (from < 0 || to < 0) throw new Error(`prove: ${SHEET} at ${tag} has no default block`);
  const block = original.slice(from, to);
  const tokens = [...block.matchAll(/--([a-z0-9-]+):(#[0-9A-Fa-f]{6});/g)].map((m) => ({ name: m[1], was: m[2] }));
  let drew = 0, red = 0;
  /** @type {string[]} */
  const unseen = [];
  for (const token of tokens) {
    const now = token.was.toUpperCase() === OTHER ? OTHER_FOR_BLUE : OTHER;
    const others = await drawChanged(original.slice(0, from) + block.replace(`--${token.name}:${token.was};`, `--${token.name}:${now};`) + original.slice(to));
    let shown = false;
    keys.forEach((key, n) => {
      const pixels = moved(firsts[n].png, others[n].png);
      if (!pixels) return;
      shown = true; drew++;
      const v = ask(key, firsts[n], others[n], false);
      if (v.green) wrong++; else red++;
      process.stdout.write(`TOKEN --${token.name} ${token.was} -> ${now} ${key}: ${pixels} pixels moved; not accepted: ${v.green ? "GREEN, WRONG" : "red"} names=${v.names.verdict} boxes=${v.boxes.verdict} drawn=${v.drawn.verdict} picture=${v.picture.verdict} ratio=${v.picture.ratio.toFixed(6)}\n`);
    });
    if (!shown) unseen.push(`--${token.name}`);
  }
  process.stdout.write(`TOKENS colours=${tokens.length} shown_in_a_state=${tokens.length - unseen.length} readings=${drew} red=${red} green=${drew - red}\n`);
  if (unseen.length) process.stdout.write(`TOKENS not shown by these states: ${unseen.join(" ")}\n`);
  await reference.close();
  await changed.close();
} finally {
  await browser.close();
}
process.stdout.write(`PROVED keys=${keys.length} wrong=${wrong}\n`);
process.exit(wrong ? 1 : 0);
