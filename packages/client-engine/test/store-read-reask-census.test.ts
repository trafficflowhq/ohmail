import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY STORE READ ON THE WEB AND THE PHONE GOES THROUGH THE ONE RE-ASK.
 *
 * SCANNED ROOTS: `apps/webapp/app`, `apps/mobile/src`, `apps/mobile/app` — none is this package,
 * so it runs by its scanned roots (CLAUDE.md's census rule). A store read is a render bind of a
 * History or Search walker (`useSyncExternalStore` over its `subscribe`); each one needs a
 * `useSessionReask` call in its file, and each platform's `useSessionReask` calls the engine's
 * `createSessionReask`. The phone's two reads had none: a 401 there stayed "did not answer".
 */

const ROOTS: Array<[string, URL]> = [
  ["apps/webapp/app", new URL("../../../apps/webapp/app/", import.meta.url)],
  ["packages/app-logic/src", new URL("../../app-logic/src/", import.meta.url)],
  ["apps/mobile/src", new URL("../../../apps/mobile/src/", import.meta.url)],
  ["apps/mobile/app", new URL("../../../apps/mobile/app/", import.meta.url)],
];

/** Every render bind the roots hold today, by file. A new one is named here on purpose. */
const BINDS: Record<string, number> = {
  "packages/app-logic/src/session/store-timeline.ts": 1,
  "apps/webapp/app/views/SearchView.tsx": 1,
  "apps/mobile/src/state/store-views.ts": 2,
};

/** Each platform's one adapter over the engine's rule. */
const ADAPTERS = ["packages/app-logic/src/session/session-reask.ts", "apps/mobile/src/state/store-views.ts"];

const WALKER_SOURCE = /new\s+Store(?:Timeline|Search)Walker\(|store(?:Search)?WalkerFor\(|\.store\.(?:walker|searchWalker)\b/;

function sources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, `${rel}/${name}`); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      out.push({ rel: `${rel}/${name}`, src: withoutComments(readFileSync(full, "utf8")) });
    }
  };
  for (const [rel, root] of ROOTS) walk(fileURLToPath(root).replace(/\/$/, ""), rel);
  return out;
}

/** How many render binds of a walker this source holds. */
export function walkerBinds(src: string): number {
  const walkers = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]*)/g)) {
    if (WALKER_SOURCE.test(m[2]!)) walkers.add(m[1]!);
  }
  let binds = 0;
  for (const m of src.matchAll(/useSyncExternalStore\(\s*([^,]*)/g)) {
    if ([...walkers].some((w) => new RegExp(`\\b${w}\\.subscribe\\b`).test(m[1]!))) binds += 1;
  }
  return binds;
}

const reaskCalls = (src: string): number =>
  [...src.matchAll(/\buseSessionReask\(/g)].length - [...src.matchAll(/function\s+useSessionReask\(/g)].length;

/** `file: …` for every file whose binds outnumber its re-asks, or whose re-ask decides nothing. */
export function unbound(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const binds = walkerBinds(src);
    if (binds === 0) continue;
    if (reaskCalls(src) < binds) out.push(`${rel}: ${binds} bind(s), ${reaskCalls(src)} re-ask(s)`);
    // Each answer decides the state shown (`renewing ? "loading" : …`): one read per re-ask, so a
    // second read in the same file cannot stand in for a dropped one.
    const asked = new Map<string, number>();
    for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*useSessionReask\(/g)) asked.set(m[1]!, (asked.get(m[1]!) ?? 0) + 1);
    for (const [name, n] of asked) {
      const reads = [...src.matchAll(new RegExp(`\\b${name}\\s*\\?`, "g"))].length;
      if (reads < n) out.push(`${rel}: ${name} read ${reads} time(s) for ${n} re-ask(s)`);
    }
  }
  return out;
}

describe("every store read goes through the one re-ask", () => {
  const files = sources();

  it("finds the store reads it names, and only those — a census that found none measured nothing", () => {
    const found: Record<string, number> = {};
    for (const { rel, src } of files) {
      const n = walkerBinds(src);
      if (n > 0) found[rel] = n;
    }
    expect(found).toEqual(BINDS);
  });

  it("each read's file asks the one re-ask as often as it binds a walker", () => {
    expect(unbound(files)).toEqual([]);
  });

  it("each platform's adapter is the engine's rule, and no root decides a refusal on its own", () => {
    for (const rel of ADAPTERS) {
      const src = files.find((f) => f.rel === rel)?.src ?? "";
      const body = src.slice(src.indexOf("function useSessionReask("));
      expect(src, `${rel} defines no useSessionReask`).toContain("function useSessionReask(");
      expect(body, `${rel}'s useSessionReask is not the engine's rule`).toMatch(/\bcreateSessionReask\(/);
    }
    const own = files.filter((f) => /function\s+sessionRefused\(|function\s+useSessionReask\(/.test(f.src)).map((f) => f.rel);
    expect(own.sort()).toEqual([...ADAPTERS].sort());
    expect(files.filter((f) => /function\s+sessionRefused\(/.test(f.src))).toEqual([]);
  });

  it("the phone's live world hands its bearer to the reads as their renewal door", () => {
    // The provider hands the bearer to the projector, which gives it to the reads (`world-projection.ts`).
    const world = files.find((f) => f.rel === "apps/mobile/src/state/world.tsx")?.src ?? "";
    const projection = files.find((f) => f.rel === "apps/mobile/src/state/world-projection.ts")?.src ?? "";
    expect(world, "the provider no longer hands the projector its bearer").toMatch(/\bbearer:\s*session\.bearer\b/);
    expect(projection, "the reads would get no door and never wait on a renewal").toMatch(/\brenewal:\s*inp\.bearer\b/);
  });

  it("CONTROL — a planted read with no re-ask is refused, and one with it admitted", () => {
    const planted = `const walker = useMemo(() => new StoreTimelineWalker(engine), [engine]);
      const rev = useSyncExternalStore(walker.subscribe, walker.revision, walker.revision);`;
    expect(unbound([{ rel: "planted.ts", src: planted }])).toEqual(["planted.ts: 1 bind(s), 0 re-ask(s)"]);
    const dropped = `${planted}\n const renewing = useSessionReask(read);`;
    expect(unbound([{ rel: "dropped.ts", src: dropped }])).toEqual(["dropped.ts: renewing read 0 time(s) for 1 re-ask(s)"]);
    const bound = `${dropped}\n const state = renewing ? "loading" : walker.state();`;
    expect(unbound([{ rel: "bound.ts", src: bound }])).toEqual([]);
  });
});
