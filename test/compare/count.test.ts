import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { design } from "../../packages/tokens/src/design/tokens.js";
import { fetchAll, fetchShard, referenceIn, wanted } from "./fetch.mjs";
import { size } from "./png.mjs";
import { stateHash } from "./registry.mjs";
import type { ArchiveLock, Manifest, Registry } from "./registry.d.mts";
import { TOLERANCE } from "./render.mjs";
import type { OwnRow } from "./subject.js";

/**
 * THE COUNT: every registered state has a picture, and none is older than its state.
 *
 * It reads the three files this folder holds about the reference (`registry.json`, `manifest.json`,
 * `archive.lock.json`) and never the archive itself, so it runs wherever the suite runs.
 */

const HERE = resolve(process.cwd(), "test/compare");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(HERE, name), "utf8")) as T;
const registry = json<Registry>("registry.json");
const manifest = json<Manifest>("manifest.json");
const lock = json<ArchiveLock>("archive.lock.json");
const rowOf = new Map(manifest.rows.map((r) => [r.key, r]));
/** The registered screens that have no picture on purpose, each with why. */
const noPicture = json<{ screen: string; reason: string }[]>("no-picture.json");
const leftOut = new Set(noPicture.map((n) => n.screen));

describe("the reference pictures", () => {
  it("has a picture for every registered state, but for the screens that are left out with a reason", () => {
    expect(registry.states.length).toBeGreaterThan(2000);
    expect(new Set(registry.states.map((s) => s.key)).size).toBe(registry.states.length);
    expect(registry.states.filter((s) => !leftOut.has(s.screen) && !rowOf.has(s.key)).map((s) => s.key), "registered states without a picture").toEqual([]);
    const without = registry.states.filter((s) => !rowOf.has(s.key));
    console.log(`COUNT registered=${registry.states.length} with_a_picture=${registry.states.length - without.length} without=${without.length} (${noPicture.map((n) => `${n.screen}: ${without.filter((s) => s.screen === n.screen).length}`).join(", ")})`);
  });

  it("leaves a screen out only by name and with its reason, and then holds no picture of it at all", () => {
    const screens = new Set(registry.screens.map((s) => s.id));
    for (const n of noPicture) expect([screens.has(n.screen), n.reason.length > 40], n.screen).toEqual([true, true]);
    expect(leftOut.size).toBe(noPicture.length);
    expect(manifest.rows.filter((r) => leftOut.has(r.shard)).map((r) => r.key), "pictures of a screen that is left out").toEqual([]);
    expect(lock.shards.filter((s) => leftOut.has(s.id)).map((s) => s.id), "archives of a screen that is left out").toEqual([]);
    expect(leftOut.has(lock.canary)).toBe(false);
    // Leaving out is for what is no screen of the app: a handful, never a way around a state that will not draw.
    expect(registry.states.filter((s) => leftOut.has(s.screen)).length).toBeLessThan(registry.states.length / 50);
  });

  it("has no picture older than its state, and none of a state that is no longer registered", () => {
    expect(registry.states.filter((s) => rowOf.has(s.key) && rowOf.get(s.key)!.stateHash !== stateHash(s)).map((s) => s.key), "pictures older than their state").toEqual([]);
    const keys = new Set(registry.states.map((s) => s.key));
    expect(manifest.rows.filter((r) => !keys.has(r.key)).map((r) => r.key), "pictures of no registered state").toEqual([]);
  });

  it("keeps every picture in the shard of its screen, and every shard in the lock", () => {
    const screens = new Set(registry.screens.map((s) => s.id));
    const screenOf = new Map(registry.states.map((s) => [s.key, s.screen]));
    expect(manifest.rows.filter((r) => r.shard !== screenOf.get(r.key) || !screens.has(r.shard)).map((r) => r.key)).toEqual([]);
    const locked = lock.shards.map((s) => s.id);
    expect(new Set(locked).size).toBe(locked.length);
    expect(Object.keys(manifest.shards).sort()).toEqual([...locked].sort());
    expect(locked).toContain(lock.canary);
    // A shard is pinned by its name, its checksum and its size. Where it can be fetched is a list that may be empty; an address in it ends in the file's name.
    for (const s of lock.shards) expect([s.sha256.length, s.bytes > 0, s.file.startsWith(`${s.id}-`), s.urls.every((u) => u.startsWith("https://") && u.endsWith(`/${s.file}`))], s.id).toEqual([64, true, true, true]);
  });

  it("is taken at a scale and a window the row names", () => {
    expect(manifest.rows.filter((r) => !(r.png.scale > 0) || r.png.w % r.png.scale !== 0 || r.png.h % r.png.scale !== 0).map((r) => r.key)).toEqual([]);
  });

  it("names the tag and the commit the design tokens name", () => {
    expect([registry.studioTag, registry.studioCommit]).toEqual([design.sheet.tag, design.sheet.commit]);
    expect([TOLERANCE.studioTag, TOLERANCE.studioCommit]).toEqual([design.sheet.tag, design.sheet.commit]);
    expect(Object.values(manifest.shards).filter((s) => !s.studioTag || !/^[0-9a-f]{40}$/.test(s.studioCommit))).toEqual([]);
  });

  it("carries no address of where the reference is served, and none of its notes", () => {
    // The registry whole; of the manifest, what is not a checksum or a number: its keys and its shards.
    const text = readFileSync(join(HERE, "registry.json"), "utf8") + manifest.rows.map((r) => `${r.key} ${r.shard}`).join("\n") + Object.keys(manifest.shards).join("\n");
    expect(text.match(/https?:|100\.\d+\.|8795|redesign-2026|FB-\d/g) ?? []).toEqual([]);
    expect(Object.keys(registry).sort()).toEqual(["screens", "states", "studioCommit", "studioTag"]);
    const kept = new Set(["key", "screen", "group", "label", "kind", "link", "variant"]);
    expect(registry.states.flatMap((s) => Object.keys(s)).filter((k) => !kept.has(k))).toEqual([]);
  });

  it("keeps no file in this folder over a megabyte", () => {
    const heavy: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, e.name);
        if (e.isDirectory()) walk(at);
        else if (statSync(at).size > 1024 * 1024) heavy.push(at.slice(HERE.length + 1));
      }
    };
    walk(HERE);
    expect(heavy).toEqual([]);
  });
});

describe("the states the reference draws differently from run to run", () => {
  const unsteady = json<{ key: string; what: string }[]>("unsteady.json");
  it("are registered states, each with what moves, and none of them is accepted", () => {
    const keys = new Set(registry.states.map((s) => s.key));
    const accepted = new Set(json<string[]>("accepted.json"));
    expect(unsteady.filter((u) => !keys.has(u.key) || !rowOf.has(u.key) || u.what.length < 20).map((u) => u.key)).toEqual([]);
    expect(new Set(unsteady.map((u) => u.key)).size).toBe(unsteady.length);
    expect(unsteady.filter((u) => accepted.has(u.key)).map((u) => u.key), "accepted, though its picture is one draw of several").toEqual([]);
  });
});

describe("the product's own pictures", () => {
  it("each stand beside their data file, drawn in what their row names", () => {
    for (const row of json<OwnRow[]>("own/rows.json")) {
      const png = readFileSync(join(HERE, "own", `${row.file}.png`));
      const scene = JSON.parse(readFileSync(join(HERE, "own", `${row.file}.json`), "utf8")) as { variant: OwnRow["variant"] };
      expect(scene.variant, row.key).toEqual(row.variant);
      expect(size(png), row.key).toEqual({ width: row.variant.width * row.variant.scale, height: row.variant.height * row.variant.scale });
    }
  });
});

describe("fetching the archive", () => {
  const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  const made: string[] = [];
  const fresh = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  /** A shard made here: a folder of files packed as the capture packs one. */
  function shard(files: Record<string, string>): { from: string; lock: ArchiveLock["shards"][number] } {
    const from = fresh("compare-shard-");
    const src = join(from, "src");
    mkdirSync(src);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);
    const file = "marks-t.1.tar.gz";
    execFileSync("tar", ["-czf", join(from, file), "-C", src, "."]);
    const bytes = readFileSync(join(from, file));
    return { from, lock: { id: "marks", file, sha256: sha256(bytes), bytes: bytes.length, urls: [] } };
  }
  const into = (): string => fresh("compare-into-");

  it("unpacks a shard that matches its lock, and keeps it the second time", async () => {
    const s = shard({ "0123456789abcdef.png": "p", "0123456789abcdef.json": "{}" });
    const dir = into();
    expect(await fetchShard(s.lock, dir, s.from)).toBe("fetched");
    expect(readFileSync(join(dir, "marks", "0123456789abcdef.json"), "utf8")).toBe("{}");
    expect(await fetchShard(s.lock, dir, s.from)).toBe("kept");
  });

  it("refuses a shard whose bytes are not the lock's, and unpacks nothing of it", async () => {
    const s = shard({ "0123456789abcdef.png": "p" });
    const dir = into();
    await expect(fetchShard({ ...s.lock, sha256: "0".repeat(64) }, dir, s.from)).rejects.toThrow(/REFUSED/);
    expect(existsSync(join(dir, "marks"))).toBe(false);
  });

  it("refuses a shard that holds anything but pictures and data files", async () => {
    const s = shard({ "0123456789abcdef.png": "p", "run.sh": "x" });
    await expect(fetchShard(s.lock, into(), s.from)).rejects.toThrow(/REFUSED.*run\.sh/);
  });

  it("fails when the lock names no place and none was given", async () => {
    const s = shard({ "0123456789abcdef.png": "p" });
    await expect(fetchShard(s.lock, into(), undefined)).rejects.toThrow(/no place to fetch/);
  });

  it("says in one line that the archive has no home, and fails, when the lock names no address and no place was given", async () => {
    const s = shard({ "0123456789abcdef.png": "p", "0123456789abcdef.json": "{}" });
    const dir = join(into(), "reference");
    const none = await fetchAll({ shards: [s.lock] }, ["marks"], dir, undefined);
    expect([none.code, none.out, none.err.length]).toEqual([1, [], 1]);
    expect(none.err[0]).toMatch(/^fetch: the reference archive has no home yet: .* Run: node test\/compare\/fetch\.mjs --from </);
    expect(existsSync(dir)).toBe(false);
    // Given the place, the same lock fetches.
    const given = await fetchAll({ shards: [s.lock] }, ["marks"], dir, s.from);
    expect([given.code, given.err, given.out.at(-1)]).toEqual([0, [], "FETCH shards=1 fetched=1 kept=0"]);
    // A shard that could not be had whole still fails, by its own line.
    const other = await fetchAll({ shards: [{ ...s.lock, sha256: "0".repeat(64) }] }, ["marks"], join(into(), "reference"), s.from);
    expect([other.code, other.out.at(-1)]).toEqual([1, "FETCH shards=1 fetched=0 kept=0 FAILED=1"]);
    expect(other.err[0]).toMatch(/REFUSED/);
  });

  it("lets a comparison skip on one line when its shards are not there, and fails on it for a run told they must be", async () => {
    const s = shard({ "0123456789abcdef.png": "p", "0123456789abcdef.json": "{}" });
    const dir = join(into(), "reference");
    const skipped = referenceIn(dir, ["marks", "ohbox"], false);
    expect([skipped.missing, skipped.fail]).toEqual([["marks", "ohbox"], false]);
    expect(skipped.line).toMatch(/^COMPARE SKIPPED: the reference pictures are not in .* \(missing: marks, ohbox\)\. Give them with: node test\/compare\/fetch\.mjs --from </);
    expect(skipped.line).not.toContain("\n");
    const failed = referenceIn(dir, ["marks", "ohbox"], true);
    expect([failed.missing, failed.fail]).toEqual([["marks", "ohbox"], true]);
    expect(failed.line).toMatch(/^COMPARE FAILED: the reference pictures are not in .* \(missing: marks, ohbox\)\. Give them with: node test\/compare\/fetch\.mjs --from </);
    // Once a shard stands there, it is not missing, and a run with all of them has nothing to say either way.
    await fetchShard(s.lock, dir, s.from);
    expect(referenceIn(dir, ["marks", "ohbox"], true).missing).toEqual(["ohbox"]);
    for (const required of [false, true]) expect(referenceIn(dir, ["marks"], required)).toEqual({ missing: [], line: "", fail: false });
  });

  it("asks for the canary and for each registered screen that has subjects, and for nothing else", () => {
    const l = { canary: "marks", shards: [{ id: "marks" }, { id: "ohbox" }, { id: "week" }] } as ArchiveLock;
    const r = { screens: [{ id: "marks" }, { id: "ohbox" }, { id: "week" }] } as Registry;
    expect(wanted(l, r, ["geometry.ts", "ohbox.ts"])).toEqual(["marks", "ohbox"]);
    expect(wanted(l, r, [], true)).toEqual(["marks", "ohbox", "week"]);
  });
});
