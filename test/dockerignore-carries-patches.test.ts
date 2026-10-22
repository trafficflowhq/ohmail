import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
