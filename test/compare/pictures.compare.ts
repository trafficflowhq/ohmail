import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareState, describeVerdict, type Declared, type Rendering } from "./compare.js";
import { referenceIn } from "./fetch.mjs";
import { fileOf } from "./registry.mjs";
import type { ArchiveLock, Manifest, Registry } from "./registry.d.mts";
import { launch, shoot, TOLERANCE } from "./render.mjs";
import type { OwnRow, Subject, Variant } from "./subject.js";

/**
 * Every subject against its picture (`npx vitest run --config vitest.compare.config.ts`).
 *
 * A subject of a registered screen is held against the reference picture of its key, read from the
 * archive in `build/reference/`; any other against the product's own picture in `own/`. An own picture
 * that is missing fails. A shard of the archive that is not in `build/reference/` is said in one line
 * and what reads it is skipped; with `COMPARE_REQUIRE_REFERENCE=1`, which a job that exists to compare
 * sets, that line is a failure. What a red state drew is written to `build/compare/`.
 *
 * `COMPARE_WRITE_OWN=1` takes the own pictures anew and compares nothing: the one way a baseline in
 * `own/` is made, on purpose, by a person who then reads the pictures.
 */

const HERE = resolve(process.cwd(), "test/compare");
const REFERENCE = resolve(process.cwd(), "build/reference");
const OUT = resolve(process.cwd(), "build/compare");
const WRITE_OWN = process.env.COMPARE_WRITE_OWN === "1";
const REQUIRED = process.env.COMPARE_REQUIRE_REFERENCE === "1";

const json = <T>(name: string): T => JSON.parse(readFileSync(join(HERE, name), "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const registry = json<Registry>("registry.json");
const manifest = json<Manifest>("manifest.json");
const lock = json<ArchiveLock>("archive.lock.json");
const declared = json<Declared[]>("declared.json");
const accepted = new Set(json<string[]>("accepted.json"));
const ownRows = json<OwnRow[]>("own/rows.json");
const screens = new Set(registry.screens.map((s) => s.id));
const stateOf = new Map(registry.states.map((s) => [s.key, s]));
const rowOf = new Map(manifest.rows.map((r) => [r.key, r]));

type Loaded = { screen: string | null; subject: Subject };

/** Every subject, with the registered screen its file is named after (none for the product's own). */
async function subjectsOf(): Promise<Loaded[]> {
  const loaded: Loaded[] = [];
  for (const f of readdirSync(join(HERE, "subjects")).filter((n) => n.endsWith(".ts")).sort()) {
    const name = basename(f, ".ts");
    const mod = (await import(`./subjects/${name}.ts`)) as { subjects: Subject[] };
    for (const subject of mod.subjects) loaded.push({ screen: screens.has(name) ? name : null, subject });
  }
  return loaded;
}

function referenceOf(key: string): { variant: Variant; rendering: Rendering } {
  const state = stateOf.get(key), row = rowOf.get(key);
  if (!state) throw new Error(`${key} is not a registered state (registry.json)`);
  if (!row) throw new Error(`${key} has no picture (manifest.json)`);
  const at = join(REFERENCE, row.shard, fileOf(key));
  if (!existsSync(`${at}.png`) || !existsSync(`${at}.json`)) throw new Error(`the reference archive is not in build/reference (shard ${row.shard}); run: node test/compare/fetch.mjs`);
  const png = readFileSync(`${at}.png`), scene = readFileSync(`${at}.json`);
  if (sha256(png) !== row.png.sha256 || sha256(scene) !== row.scene.sha256) throw new Error(`${key}: the picture in build/reference is not the one the manifest names`);
  const { scale } = row.png;
  return { variant: { ...state.variant, width: row.png.w / scale, height: row.png.h / scale, scale }, rendering: { png, scene: JSON.parse(scene.toString("utf8")) } };
}

function keep(name: string, v: ReturnType<typeof compareState>, drew: Rendering): void {
  mkdirSync(OUT, { recursive: true });
  const at = join(OUT, name.replace(/[^A-Za-z0-9._@-]+/g, "_"));
  writeFileSync(`${at}.actual.png`, drew.png);
  writeFileSync(`${at}.actual.json`, JSON.stringify(drew.scene));
  if (v.picture.diff) writeFileSync(`${at}.diff.png`, v.picture.diff);
}

/** The shards this run reads: the canary, and one for each screen that has subjects. */
const shardsOf = (loaded: Loaded[]): string[] => [...new Set([lock.canary, ...loaded.flatMap((l) => (l.screen ? [l.screen] : []))])];

describe("the reference archive", async () => {
  const shards = shardsOf(await subjectsOf());
  const reference = referenceIn(REFERENCE, shards, REQUIRED);
  if (reference.line && !reference.fail) console.log(reference.line);
  if (reference.fail) it("stands in build/reference, as this run was told it must", () => { throw new Error(reference.line); });
  it.for(shards)("holds shard %s whole, as the manifest names it", (shard, { skip }) => {
    if (reference.missing.includes(shard)) skip();
    const rows = manifest.rows.filter((r) => r.shard === shard);
    expect(rows.length, `no picture in the manifest belongs to shard ${shard}`).toBeGreaterThan(0);
    for (const row of rows) {
      const { rendering } = referenceOf(row.key);
      const scene = rendering.scene as Rendering["scene"] & { key?: string; studioCommit?: string };
      expect([scene.key, scene.studioCommit], row.key).toEqual([row.key, manifest.shards[shard]?.studioCommit]);
    }
    console.log(`ARCHIVE ${shard} pictures=${rows.length} verified`);
  });
});

describe("each subject against its picture", async () => {
  const loaded = await subjectsOf();
  /* A registered screen's subject is skipped with its missing shard, which the block above has said; a run told the reference must be there fails on it instead. */
  const skipped = new Set(REQUIRED ? [] : referenceIn(REFERENCE, shardsOf(loaded), false).missing);
  const require_ = createRequire(resolve(process.cwd(), "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  beforeAll(async () => { browser = await launch(chromium); });
  afterAll(async () => { await browser?.close(); });

  it("has a subject for every own picture, and one key a subject", () => {
    const keys = loaded.map((l) => l.subject.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ownRows.map((r) => r.key).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it.for(loaded.map((l) => [l.subject.key, l] as const))("%s", async ([key, { screen, subject }], { skip }) => {
    if (screen && skipped.has(screen)) skip();
    let variant: Variant, reference: Rendering | null = null;
    if (screen) {
      expect(stateOf.get(key)?.screen, `${key} is not a state of the screen its file is named after`).toBe(screen);
      ({ variant, rendering: reference } = referenceOf(key));
    } else {
      expect(key.startsWith("own:"), `${key}: a subject outside a registered screen's file has an own: key`).toBe(true);
      const row = ownRows.find((r) => r.key === key);
      if (!row) throw new Error(`${key} has no row in own/rows.json`);
      variant = row.variant;
      const at = join(HERE, "own", row.file);
      const drew = WRITE_OWN ? await shoot(browser!, variant, (page) => subject.open(page, variant)) : null;
      if (drew) {
        writeFileSync(`${at}.png`, drew.png);
        writeFileSync(`${at}.json`, `${JSON.stringify(drew.scene, null, 1)}\n`);
        console.log(`WROTE own/${row.file}`);
        return;
      }
      if (!existsSync(`${at}.png`) || !existsSync(`${at}.json`)) throw new Error(`${key}: own/${row.file} has no picture`);
      reference = { png: readFileSync(`${at}.png`), scene: JSON.parse(readFileSync(`${at}.json`, "utf8")) };
    }
    const drew = await shoot(browser!, variant, (page) => subject.open(page, variant));
    const verdict = compareState({ key, reference, actual: drew, tolerance: TOLERANCE, declared: declared.find((d) => d.key === key), accepted: accepted.has(key) });
    console.log(describeVerdict(verdict));
    if (!verdict.green || verdict.picture.verdict !== "green") keep(key, verdict, drew);
    expect(verdict.green, describeVerdict(verdict, 40)).toBe(true);
  });
});
