import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// NODE RUNS THE FILE THE EXPORTS MAP NAMES.
//
// Every workspace package exports its TypeScript source, because the bundlers (esbuild, webpack,
// Metro, vite), vitest and tsc all read source. Node does not bundle. It resolves the specifier to
// the .ts, strips the types, and then fails in one of two ways: on the file's own relative imports
// (`./types.js` beside a .ts file does not exist on disk — 0.16.2 shipped that into a worker image,
// green build, `ERR_MODULE_NOT_FOUND` at boot), or on syntax type stripping cannot remove (a
// parameter property in `packages/core/src/adapters/drizzle-repo.ts`, ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
// — what `node apps/worker/dist/index.js` met after `npm run build` on this tree).
//
// The remedy is a `node` condition on every entry, naming the compiled twin `tsc -b` writes, so a
// plain Node program takes built JavaScript. Every bundler and the test runner name
// `ohmail-source`, listed ahead of `node`, and keep the source; `default` stays on the source for
// the ones that match neither. This census holds the invariant that makes the class unrepresentable:
// a leaf Node resolves to `src/` may carry no relative import. `apps/worker/test/dist-import-graph.test.ts`
// is the expensive half — it starts the built worker and reads how the import settled.
const ROOT = new URL("../", import.meta.url).pathname;

// The roots whose modules Node executes unbundled. A browser graph is NOT one of them.
const NODE_ROOTS = [
  "apps/worker/src",
  "apps/server/src",
  "apps/sidecar/src",
  "packages/db/src",
  "packages/api/src",
  "packages/services/src",
  "apps/api-vercel/src",
];

/** The condition every source reader names: the bundlers, vitest and the tsx runs. */
const SOURCE_CONDITION = "ohmail-source";

/** The target PLAIN NODE picks: the conditions it matches, in the map's own key order. */
function nodeTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      // `types` is TypeScript's and `ohmail-source` the bundlers' — Node skips both and reads the next key.
      if (["node", "import", "default"].includes(k) && typeof t === "string") return t;
    }
  }
  return undefined;
}

/** The target a BUNDLER that matches neither `ohmail-source` nor `node` picks. */
function defaultTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const t = (v as Record<string, unknown>).default;
    if (typeof t === "string") return t;
  }
  return undefined;
}

const relativeImports = (src: string) =>
  [...new Set([...src.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)].map((m) => m[1]))];

/** Leaf name -> the relative imports its source carries, for every leaf Node resolves into `src/`. */
function unfollowableIn(exports: Record<string, unknown>, dir = `${ROOT}packages/core/`): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of Object.entries(exports)) {
    const target = nodeTarget(value);
    if (!target || !target.includes("/src/")) continue;
    const rel = relativeImports(readFileSync(`${dir}${target.replace(/^\.\//, "")}`, "utf8"));
    if (rel.length > 0) out.set(name.replace(/^\.\//, ""), rel);
  }
  return out;
}

type Manifest = { name: string; dir: string; exports: Record<string, unknown> };

/** Every workspace package that has an exports map, read from the tree. */
function workspaceManifests(): Manifest[] {
  const out: Manifest[] = [];
  for (const area of ["packages", "apps"]) {
    for (const name of readdirSync(`${ROOT}${area}`).sort()) {
      const file = `${ROOT}${area}/${name}/package.json`;
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; exports?: Record<string, unknown> };
      if (pkg.name && pkg.exports) out.push({ name: pkg.name, dir: `${ROOT}${area}/${name}/`, exports: pkg.exports });
    }
  }
  return out;
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = `${dir}/${e}`;
    if (statSync(p).isDirectory()) { tsFiles(p, acc); continue; }
    if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

describe("no workspace leaf resolves, under Node, to a source file Node cannot follow", () => {
  it("every leaf Node resolves into src/ is free of relative imports", () => {
    // THE INVARIANT. A leaf whose Node target is source may only be a module with no relative
    // import of its own. Today none is: every TypeScript entry carries a `node` condition, which
    // moves its Node target out of `src/` and out of this set.
    const unfollowable = workspaceManifests().flatMap((m) =>
      [...unfollowableIn(m.exports, m.dir)].map(([l, r]) => `${m.name}/${l} -> ${r.join(", ")}`));
    expect(unfollowable,
      "give each of these leaves a `node` condition pointing at its ./dist twin, or remove the"
      + " relative import; as they stand, importing one from a Node program is ERR_MODULE_NOT_FOUND"
      + " at boot with a green build behind it").toEqual([]);
  });

  it("the deriver flags a leaf that does have one", () => {
    /* The case above is a 0-ceiling, so it must be watched finding something or it is decoration:
     * the same deriver over a map shaped like the one 0.16.2 shipped. `folder-name.ts` is the real
     * file and really does import `./types.js` — only the exports entry is synthetic. */
    const shipped = unfollowableIn({ "./folder-name": "./src/folder-name.ts" });
    expect([...shipped.keys()]).toEqual(["folder-name"]);
    expect(shipped.get("folder-name")).toEqual(["./types.js"]);
    // And a `node` condition on that same entry takes it back out — behind `ohmail-source`, which Node skips.
    expect([...unfollowableIn({
      "./folder-name": { types: "./src/folder-name.ts", [SOURCE_CONDITION]: "./src/folder-name.ts", node: "./dist/folder-name.js", default: "./src/folder-name.ts" },
    }).keys()]).toEqual([]);
  });

  it("every TypeScript entry has a node twin, behind `types` and the source condition, with `default` on the source", () => {
    /* `default` is what a bundler matching neither condition takes (Metro, a browser build); moved to
     * dist it would put build output into those graphs, which run no compiler.
     *
     * `types` ahead of `node` is a ruling rather than a mechanism: the type layer reads SOURCE, so a
     * `dist/` nobody rebuilt can never be believed by a typecheck. Measured both ways — with `types`
     * on dist a mutated `dist/types.d.ts` reddens `apps/webapp/app/shell/FoldersRailGroup.tsx`; with
     * it on src the same mutation is invisible.
     *
     * `ohmail-source` ahead of `node` is what keeps a node-platform bundle (the two host images, the
     * desktop engine), Next's server compiler and vitest on the source: each matches `node` too, and
     * none of them runs `tsc` first. */
    const offences: string[] = [];
    let entries = 0;
    for (const m of workspaceManifests()) {
      for (const [name, value] of Object.entries(m.exports)) {
        const source = defaultTarget(value);
        // Only TypeScript is compiled: a stylesheet or a file outside `src/` has no twin and no Node consumer.
        if (!source || !/^\.\/src\/.*\.tsx?$/.test(source)) continue;
        entries++;
        const at = `${m.name} ${name}`;
        if (typeof value !== "object" || value === null) { offences.push(`${at}: a bare source string — no node twin`); continue; }
        const v = value as Record<string, unknown>;
        const keys = Object.keys(v);
        if (v.types !== source) offences.push(`${at}: \`types\` is ${JSON.stringify(v.types)}, not the source`);
        if (v[SOURCE_CONDITION] !== source) offences.push(`${at}: \`${SOURCE_CONDITION}\` is ${JSON.stringify(v[SOURCE_CONDITION])}, not the source`);
        const node = v.node;
        const twin = source.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".js");
        if (node !== twin) offences.push(`${at}: \`node\` is ${JSON.stringify(node)}, not ${twin}`);
        // Key ORDER, not just presence: the first matching key wins, so a `node` placed ahead of
        // either would hand tsc or a bundler the build output.
        if (!(keys.indexOf("types") < keys.indexOf("node"))) offences.push(`${at}: \`types\` must come before \`node\` (keys: ${keys.join(", ")})`);
        if (!(keys.indexOf(SOURCE_CONDITION) < keys.indexOf("node"))) offences.push(`${at}: \`${SOURCE_CONDITION}\` must come before \`node\` (keys: ${keys.join(", ")})`);
        if (keys[keys.length - 1] !== "default") offences.push(`${at}: \`default\` must come last (keys: ${keys.join(", ")})`);
        // The twin `tsc -b` writes comes from this source under the package's `rootDir: "src"`.
        // Asserted on disk rather than on a build, so this needs none.
        if (!existsSync(`${m.dir}${source.slice(2)}`)) offences.push(`${at}: names ${source}, which is absent`);
      }
    }
    expect(entries, "no TypeScript entry was read — the census walked nothing").toBeGreaterThan(50);
    expect(offences).toEqual([]);
  });

  it("every reader of the source names the source condition", () => {
    /* The other half of the map: a reader that matches `node` and does not name `ohmail-source` takes
     * `dist/`, which the image recipes and the Vercel builds never produce and a stale local build
     * would answer with old code. Read from the files that configure each one. */
    const readers: Array<[string, RegExp]> = [
      ["scripts/bundle-host.mjs", /conditions:\s*\[\s*"ohmail-source"/],
      ["scripts/engine-bundle.mjs", /conditions:\s*\[\s*"ohmail-source"/],
      ["apps/webapp/next.config.mjs", /conditionNames\s*=\s*\[\s*"ohmail-source"/],
      ["apps/api-vercel/next.config.mjs", /conditionNames\s*=\s*\[\s*"ohmail-source"/],
      ["vitest.config.ts", /conditions:\s*\[\s*"ohmail-source"\s*\]/],
    ];
    for (const [file, rx] of readers) {
      expect(rx.test(readFileSync(`${ROOT}${file}`, "utf8")), `${file} no longer names ${SOURCE_CONDITION}`).toBe(true);
    }
    // The root script a release operator runs against a fresh clone, before any build.
    const scripts = (JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["db:setup:prod"]).toMatch(/^tsx --conditions=ohmail-source /);
    // And the lane database tool, which every checkout runs before it builds: each tsx run names it.
    const laneDb = readFileSync(`${ROOT}scripts/lane-db.sh`, "utf8");
    // A RUN is tsx followed by the script it runs (`for needed in "$TSX" "$MJS"` is a presence check).
    const tsxRuns = [...laneDb.matchAll(
      /(?:\.bin\/tsx"|(?<!in )"\$TSX")( --conditions=ohmail-source)? "(?:\$SELF_ROOT\/scripts\/[a-z-]+\.mjs|\$MJS)"/g)];
    expect(tsxRuns.length, "the lane-db tsx runs were not found — this census reads nothing").toBe(5);
    expect(tsxRuns.filter((m) => m[1] === undefined).map((m) => m[0])).toEqual([]);
  });

  it("and no module under a Node root names a leaf Node cannot follow", () => {
    // The second line of defence: empty above means empty here, and it stays readable if a leaf
    // ever legitimately keeps a relative import on a source-only target.
    const offences: string[] = [];
    for (const m of workspaceManifests()) {
      const unfollowable = unfollowableIn(m.exports, m.dir);
      for (const root of NODE_ROOTS) {
        for (const file of tsFiles(`${ROOT}${root}`)) {
          const src = readFileSync(file, "utf8");
          for (const leaf of unfollowable.keys()) {
            const rx = new RegExp(`from\\s+"${m.name}/${leaf}"`);
            if (rx.test(src)) offences.push(`${file.slice(ROOT.length)} imports ${m.name}/${leaf}`);
          }
        }
      }
    }
    expect(offences, `these would fail at boot with ERR_MODULE_NOT_FOUND:\n  ${offences.join("\n  ")}`)
      .toEqual([]);
  });

  it("reads the roots it claims to read", () => {
    // A census that walked nothing would pass the case above for the wrong reason.
    for (const root of NODE_ROOTS) {
      expect(tsFiles(`${ROOT}${root}`).length, `${root} yielded no TypeScript files`).toBeGreaterThan(0);
    }
    expect(workspaceManifests().map((m) => m.name)).toEqual(expect.arrayContaining(
      ["@trafficflow/core", "@trafficflow/db", "@trafficflow/worker", "@ohmail/db-mail"]));
  });
});
