import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceClosure } from "../scripts/lib/engine-closure.mjs";
// @ts-expect-error — plain .mjs helper, no declarations by design.
import { moduleResolver, specifiersIn, workspacePackages } from "../scripts/lib/import-closure.mjs";

// THE PATCHES THE IMAGE INSTALLS MUST BE IN THE IMAGE'S BUILD CONTEXT.
 //
 // Each `.dockerignore` is an allow-list — `*`, then `!` lines — and a recipe that runs
 // `node scripts/apply-patches.mjs apply` after its install applies every file in `patches/`.
 // A patch that is not admitted makes that step die, and no local run can tell you: a laptop has
 // the whole repository, so only the image build ever sees the context. The paths are DERIVED
 // from `patches/` rather than listed here — a second list is the thing that goes stale when the
 // next patch arrives.
// A file path, not a URL's `.pathname`: that keeps `%20` for a space and a leading `/C:` on Windows.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IGNORE = ".dockerignore";

// * Every patch this repository carries, as `patches/<file>`.
function patchPaths(): string[] {
  return readdirSync(`${ROOT}patches`).filter((f) => f.endsWith(".patch")).sort().map((f) => `patches/${f}`);
}

// Docker's matcher, for the shapes this file uses and no others: a literal path, a directory
// prefix (`patches` covers everything under it), a star over one segment, a star in the middle of
// a path, and a leading double-star over any segment. LAST MATCH WINS, which is the rule that
// makes an allow-list work at all.
function rules(file: string = IGNORE): { negate: boolean; pattern: string }[] {
  return readFileSync(`${ROOT}${file}`, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (l.startsWith("!") ? { negate: true, pattern: l.slice(1) } : { negate: false, pattern: l }));
}

function matches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const rx = new RegExp(`^${pattern
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.+)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/")}$`);
  if (rx.test(path)) return true;
  return pattern.startsWith("**/") ? path.split("/").includes(pattern.slice(3)) : false;
}

// What the build context would do with one path. `*` excludes a TOP-LEVEL entry and everything
 // under it comes with that verdict, so the question is answered over the path's ANCESTORS: walk
 // them shallowest-first, and each time a rule matches one, that rule's verdict takes over. This
 // is why `!apps/worker` re-admits a subtree its parent excluded, and why `**/dist` takes it back
 // out one level deeper.
function admitted(path: string, file: string = IGNORE): boolean {
  const rs = rules(file);
  const segs = path.split("/");
  let verdict = true;
  for (let i = 1; i <= segs.length; i++) {
    const prefix = segs.slice(0, i).join("/");
    for (const r of rs) if (matches(r.pattern, prefix)) verdict = r.negate;
  }
  return verdict;
}

describe("the docker build context carries the patches the install applies", () => {
  const paths = patchPaths();

  it("reads every patch patches/ holds", () => {
    expect(paths.length, "no patch found — the reader or the directory moved").toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(`${ROOT}${p}`), `${p} does not exist`).toBe(true);
  });

  it("admits every one of them", () => {
    for (const p of paths) {
      expect(admitted(p), `${p} is excluded from the build context by ${IGNORE}`).toBe(true);
    }
  });

  it("still denies what the list is there to deny", () => {
    // The positive control for the matcher itself: an allow-list that admitted everything would
    // pass the case above for the wrong reason.
    for (const denied of ["apps/desktop/src-tauri/target/x", "apps/worker/dist/index.js", "apps/" + "worker/test/x.test.ts", "packages/core/.env"]) {
      expect(admitted(denied), `${denied} should not be in the context`).toBe(false);
    }
    expect(admitted("apps/worker/src/index.ts"), "the worker's own sources must be in the context").toBe(true);
  });
});

// EVERY DOCKERFILE'S CONTEXT CARRIES EVERY FILE ITS BUILD READS — asked of the allow-list that
// Dockerfile ACTUALLY GETS. BuildKit prefers a sibling `<Dockerfile>.dockerignore` and the legacy
// builder reads only the root file, so the three self-host recipes get their own list and the
// retired worker recipe gets the root one. Both the inputs and the list are DERIVED here: a written-down
// pair is what goes stale when a fourth recipe arrives.
const DOCKERFILES = (function find(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", ".next", "target", ".build"].includes(e.name)) continue;
      find(rel, out);
    } else if (/(^|\/)Dockerfile($|\.)/.test(rel) && !rel.endsWith(".dockerignore")) out.push(rel);
  }
  return out;
})("").sort();

// The list this Dockerfile's build context is actually cut with.
function ignoreFor(dockerfile: string): string {
  return existsSync(`${ROOT}${dockerfile}.dockerignore`) ? `${dockerfile}.dockerignore` : IGNORE;
}

// What the build READS, read off the recipe: the lockfile its install verb requires, every script
// a RUN step hands to node (plus that script's own relative imports), and every COPY source that
// comes from the context rather than from an earlier stage.
function requiredPaths(dockerfile: string): string[] {
  return requiredPathsOf(readFileSync(`${ROOT}${dockerfile}`, "utf8"));
}

function requiredPathsOf(text: string): string[] {
  const need = new Set<string>();
  if (/^RUN\b.*\bnpm ci\b/m.test(text)) need.add("package-lock.json");
  if (/^RUN\b.*\bpnpm install\b/m.test(text)) {
    need.add("pnpm-lock.yaml");
    for (const p of patchPaths()) need.add(p);
  }
  // An npm recipe applies the same patches itself, after its install.
  if (/^RUN\b.*\bnode scripts\/apply-patches\.mjs apply\b/m.test(text)) for (const p of patchPaths()) need.add(p);
  for (const m of text.matchAll(/^RUN\b.*?\bnode\s+([\w./-]+\.(?:m?js|cjs))/gm)) need.add(m[1]);
  for (const m of text.matchAll(/^COPY\s+(?!--from=)(?:--\S+\s+)*(\S+)\s+\S+\s*$/gm)) {
    if (m[1] !== "." && !m[1].startsWith("/")) need.add(m[1]);
  }
  // …and what those scripts import of their own siblings, one closure deep: the bundler pulls in
  // the shared esbuild loader, and a context without it fails the build, not the install.
  for (const p of [...need]) {
    if (!/\.m?js$/.test(p) || !existsSync(`${ROOT}${p}`)) continue;
    const dir = p.slice(0, p.lastIndexOf("/"));
    for (const m of readFileSync(`${ROOT}${p}`, "utf8").matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
      need.add(`${dir}/${m[1].replace(/^\.\//, "")}`.replace(/\/[^/]+\/\.\.\//g, "/"));
    }
  }
  return [...need].sort();
}

// The refusal each recipe prints when it was built by a builder that cannot read its own list.
// Without it the build dies inside npm on EUSAGE — over a lockfile this repository does commit —
// and every reader goes looking for a missing file instead of a missing builder.
function namesTheBuilder(dockerfile: string): boolean {
  const text = readFileSync(`${ROOT}${dockerfile}`, "utf8");
  return /RUN test -f package-lock\.json \|\|/.test(text)
    && text.includes(`${dockerfile}.dockerignore`)
    && /buildx/.test(text);
}

describe("every Dockerfile's build context carries every file its build reads", () => {
  it("finds the recipes rather than listing them", () => {
    expect(DOCKERFILES.length, "no Dockerfile found — the walk or the tree moved").toBeGreaterThanOrEqual(4);
    for (const d of DOCKERFILES) expect(existsSync(`${ROOT}${d}`), `${d} does not exist`).toBe(true);
  });

  it.each(DOCKERFILES)("%s: its allow-list admits every input the recipe reads", (dockerfile) => {
    const list = ignoreFor(dockerfile);
    const need = requiredPaths(dockerfile);
    expect(need.length, `${dockerfile}: nothing derived — the reader stopped matching the recipe`).toBeGreaterThan(0);
    for (const p of need) {
      expect(admitted(p, list), `${dockerfile} reads ${p}, and ${list} excludes it from its build context`).toBe(true);
    }
  });

  /* The recipes are read off the tree, so an input none of them can find is a recipe that cannot
     build here at all, whatever its list admits. apps/worker/Dockerfile is the retired worker recipe:
     it installs from a pnpm lockfile this repository does not carry (row
     RETIRED-WORKER-DOCKERFILE-WOULD-SHIP-UNPATCHED), so its arm is skipped by name, not left out. */
  const RETIRED = "apps/worker/Dockerfile";
  it.each(DOCKERFILES.filter((d) => d !== RETIRED))("%s: every input the recipe reads exists in this tree", (dockerfile) => {
    const missing = requiredPaths(dockerfile).filter((p) => !existsSync(`${ROOT}${p}`));
    expect(missing, `${dockerfile} reads what this tree does not hold`).toEqual([]);
  });
  it.skip(`${RETIRED}: every input the recipe reads exists in this tree (row RETIRED-WORKER-DOCKERFILE-WOULD-SHIP-UNPATCHED)`, () => {
    expect(requiredPaths(RETIRED).filter((p) => !existsSync(`${ROOT}${p}`))).toEqual([]);
  });

  it("control: the input reader names a lockfile and a script a recipe would read and this tree lacks", () => {
    const planted = "FROM node:22\nCOPY package.json ./\nRUN pnpm install --frozen-lockfile\nRUN node scripts/no-such-step.mjs\n";
    const need = requiredPathsOf(planted);
    expect(need.filter((p) => !existsSync(`${ROOT}${p}`))).toEqual(["pnpm-lock.yaml", "scripts/no-such-step.mjs"]);
  });

  it.each(DOCKERFILES)("%s: if the ROOT list would not do, the recipe names the builder", (dockerfile) => {
    const need = requiredPaths(dockerfile);
    const rootWouldDo = need.every((p) => admitted(p, IGNORE));
    if (rootWouldDo) return; // the root list carries it: the legacy builder builds it correctly
    expect(
      namesTheBuilder(dockerfile),
      `${dockerfile} depends on its sibling allow-list, which only BuildKit reads. Built by the `
        + `legacy builder its context loses ${need.filter((p) => !admitted(p, IGNORE)).join(", ")} `
        + `and npm reports a missing lockfile. The recipe must refuse by name and say buildx.`,
    ).toBe(true);
  });

  it("the per-Dockerfile lists are the thing being read, and they differ from the root one", () => {
    // The positive control for the pair above: if every recipe fell back to the root list, both
    // cases would pass for the wrong reason.
    const siblings = DOCKERFILES.filter((d) => ignoreFor(d) !== IGNORE);
    expect(siblings.length, "no Dockerfile has its own allow-list — the sibling lookup is wrong").toBeGreaterThan(0);
    for (const d of siblings) {
      expect(admitted("package-lock.json", ignoreFor(d)), `${ignoreFor(d)} must admit the lockfile`).toBe(true);
    }
    expect(admitted("package-lock.json", IGNORE), "the root list is the retired worker recipe's pnpm context and admits no npm lockfile").toBe(false);
  });
});

// EVERY DOCKERFILE'S CONTEXT CARRIES EVERY WORKSPACE MODULE ITS BUILD COMPILES. The case above reads
// the recipe's own inputs; this one reads what the build then reaches for. The api image's bundle
// once died on `Could not resolve "@ohmail/cal-core"`: services had begun to import the calendar's
// core, and the server's allow-list had never heard of it. Nothing local can see that (a laptop has
// the whole repository), so the walk is done here, from the recipe's own entry, with the
// repository's one resolution rule (`scripts/lib/import-closure.mjs`: a workspace name through its
// manifest's `exports`) and its one closure walk (`scripts/lib/engine-closure.mjs`). The packages
// are never listed: what the walk reaches is what the list must admit.

// A type-only statement, which a bundler erases before it resolves anything: `import type … from`
// and `export type … from`. The clause is told by its SHAPE — one brace list, a star with an
// optional `as` name, or one default name — and then `from`, so the match ends at the statement's
// own closing brace or name and cannot run on into the next statement (a semicolon-less
// `export type { X }` before a value import once swallowed that import). `import type from "…"`
// is a default import named `type`, a value, and is kept. No quantifier repeats over its own
// characters, so a hostile line costs linear time. An inline `{ type X }` is kept, which can only
// ask for MORE than the bundle needs, never less.
const TYPE_ONLY = /^[ \t]*(?:import|export)[ \t]+type[ \t]+(?:\{[\w$,\s]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*from[ \t]*["'][^"'\n]+["']/gm;

const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "target", ".build"]);

/** Every source file under `dir` that `list` lets into the context. */
function contextSources(dir: string, list: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(`${ROOT}${rel}`, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (SOURCE.test(p) && admitted(p, list)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Where the recipe's compile STARTS, read off the recipe, and whether it reads types.
 *  · `node scripts/bundle-host.mjs <host>`: the host's entry in that script's table (a stub entry
 *    is followed to what the stub imports). esbuild bundles it and erases type-only imports.
 *  · `cd <dir> && … next build`: every source of that app the context carries, type-checked.
 *  · `pnpm --filter "<name>" build`: every source of that package the context carries (tsc -b).
 */
function compileOf(dockerfile: string): { seed: string[]; types: boolean } | null {
  const text = readFileSync(`${ROOT}${dockerfile}`, "utf8");
  const list = ignoreFor(dockerfile);
  const host = /^RUN\b.*\bnode scripts\/bundle-host\.mjs\s+(\w+)/m.exec(text)?.[1];
  if (host) {
    const bundler = readFileSync(`${ROOT}scripts/bundle-host.mjs`, "utf8");
    const row = new RegExp(`^\\s*${host}: \\{ entry: "([^"]+)"(?:, stub: (\\w+))? \\}`, "m").exec(bundler);
    if (!row) return null;
    const [, entry, stub] = row;
    if (!stub) return { seed: [entry], types: false };
    const body = new RegExp(`^const ${stub} = \`([^\`]*)\``, "m").exec(bundler)?.[1] ?? "";
    const resolve = moduleResolver(ROOT);
    const seed = (specifiersIn(body) as string[]).map((s) => resolve(entry, s) as string | null)
      .filter((f): f is string => f !== null);
    return seed.length ? { seed, types: false } : null;
  }
  const app = /^RUN\s+cd\s+(\S+)\s+&&.*\bnext build\b/m.exec(text)?.[1];
  if (app) return { seed: contextSources(app, list), types: true };
  const pkg = /^RUN\b.*\bpnpm --filter "([^"]+)" build\b/m.exec(text)?.[1];
  const dir = pkg ? (workspacePackages(ROOT) as Map<string, { dir: string }>).get(pkg)?.dir : undefined;
  if (dir) return { seed: contextSources(dir, list), types: true };
  return null;
}

/** Every workspace source file the recipe's compile reaches from its start. */
function reached(dockerfile: string): string[] {
  const how = compileOf(dockerfile);
  if (!how) return [];
  const scan = how.types
    ? (src: string) => specifiersIn(src) as string[]
    : (src: string) => specifiersIn(src.replace(TYPE_ONLY, "")) as string[];
  const resolve = moduleResolver(ROOT);
  return sourceClosure({
    root: ROOT,
    seed: how.seed,
    isDenied: () => false,
    specifiersIn: scan,
    resolve: (rel: string, spec: string) => resolve(rel, spec) as string | null,
  }).files;
}

/** `packages/x/src/a.ts` → `packages/x`. */
const packageOf = (file: string): string => file.split("/").slice(0, 2).join("/");

// What the bundle script COPIES beside the bundle, which no import names: every
// `cpSync(join(ROOT, "a", "b", …), …)` source, read off the script. The worker's bundle imports
// nothing of db-mail, yet the script copies db-mail's migrations into every host's image, and a
// list without that package fails the step on ENOENT. Each quoted segment is bounded by its quotes
// and each repetition starts with `, "`, so the match cannot backtrack over its own characters.
const COPY_CALL = /\bcpSync\(/g;
const COPY_FROM_ROOT = /\bcpSync\(join\(ROOT((?:, "[^"\n]+")+)\)/g;

function copiedBy(scriptText: string): string[] {
  return [...scriptText.matchAll(COPY_FROM_ROOT)]
    .map((m) => [...m[1].matchAll(/"([^"\n]+)"/g)].map((s) => s[1]).join("/"))
    .sort();
}

/** The bundle script the recipe runs (`node scripts/bundle-host.mjs <host>`), or null. */
function bundleScriptOf(dockerfile: string): string | null {
  return /^RUN\b.*\bnode (scripts\/bundle-host\.mjs)\s+\w+/m.exec(readFileSync(`${ROOT}${dockerfile}`, "utf8"))?.[1] ?? null;
}

/** Every file under `dir`, as repository paths (none when it does not exist). */
function filesUnder(dir: string): string[] {
  if (!existsSync(`${ROOT}${dir}`)) return [];
  return readdirSync(`${ROOT}${dir}`, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath.slice(ROOT.length).replace(/\\/g, "/")}/${e.name}`);
}

const BUNDLED = DOCKERFILES.filter((d) => bundleScriptOf(d) !== null);

describe("every Dockerfile's build context carries every workspace module its build compiles", () => {
  it.each(DOCKERFILES)("%s: the recipe's compile is found", (dockerfile) => {
    const how = compileOf(dockerfile);
    expect(how, `${dockerfile}: no build step this reader knows — teach compileOf the new one`).not.toBeNull();
    expect(how!.seed.length, `${dockerfile}: the compile starts nowhere`).toBeGreaterThan(0);
  });

  it.each(DOCKERFILES)("%s: its allow-list admits every module the build reaches", (dockerfile) => {
    const list = ignoreFor(dockerfile);
    const missing = reached(dockerfile).filter((f) => !admitted(f, list));
    const byPackage = [...new Set(missing.map(packageOf))].sort();
    expect(byPackage, `${dockerfile} compiles ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}, `
      + `and ${list} keeps them out of its build context`).toEqual([]);
  });

  it.each(BUNDLED)("%s: its allow-list admits every directory the bundle script copies", (dockerfile) => {
    const list = ignoreFor(dockerfile);
    const script = bundleScriptOf(dockerfile)!;
    const text = readFileSync(`${ROOT}${script}`, "utf8");
    const copied = copiedBy(text);
    expect(copied.length, `${script}: a copy this reader does not understand — teach copiedBy its shape`)
      .toBe(text.match(COPY_CALL)?.length ?? 0);
    const refused = copied.filter((dir) => !filesUnder(dir).some((f) => admitted(f, list)));
    expect(refused, `${dockerfile} runs ${script}, which copies ${refused.join(", ")}, `
      + `and ${list} keeps every file of it out of its build context`).toEqual([]);
  });

  it("control: the copy reader reads the bundle script's copies, and the recipes that run it", () => {
    expect(BUNDLED.length, "no recipe runs the bundle script — the reader stopped matching the recipes").toBeGreaterThan(0);
    const planted = 'cpSync(join(ROOT, "a", "b"), join(out, "b"), { recursive: true });\ncpSync(join(ROOT, "c"), out);\n';
    expect(copiedBy(planted)).toEqual(["a/b", "c"]);
    for (const d of BUNDLED) {
      expect(copiedBy(readFileSync(`${ROOT}${bundleScriptOf(d)!}`, "utf8")).length, `${d}: its script copies nothing this reader sees`).toBeGreaterThan(0);
    }
  });

  it("control: the walk crosses packages, and a list without them would be refused", () => {
    // The positive control for the case above: a walk that stopped at the entry's own package
    // would pass every list for the wrong reason.
    const server = reached("apps/server/Dockerfile");
    const packages = new Set(server.map(packageOf));
    for (const p of ["apps/server", "packages/api", "packages/services", "packages/db"]) {
      expect(packages.has(p), `the server's walk does not reach ${p}`).toBe(true);
    }
    expect(server.filter((f) => f.startsWith("packages/services/")).some((f) => admitted(f, IGNORE)),
      "the root list (the organizer's context) admits the services package").toBe(false);
  });

  it("control: a type-only statement is erased for a bundle, and a value import is not", () => {
    const src = 'import type { A } from "@ohmail/wire";\nexport type {\n  B,\n} from "./b.js";\nimport { c } from "./c.js";\nexport type D = E;\nimport "./f.js";\n';
    expect(specifiersIn(src.replace(TYPE_ONLY, ""))).toEqual(["./c.js", "./f.js"]);
    // One statement, never into the next: a value import after a semicolon-less type export is
    // kept, and so is a default import whose name is the word `type`. A default type import and a
    // star type export (named or not) are erased.
    const shapes = 'export type { Z7 }\nimport { LIMITS as z8 } from "@ohmail/cal-providers"\nimport type G from "./g.js"\n'
      + 'export type * from "./h.js"\nexport type * as I from "./i.js"\nimport type from "./t.js"\n';
    expect(specifiersIn(shapes.replace(TYPE_ONLY, ""))).toEqual(["@ohmail/cal-providers", "./t.js"]);
  });
});
