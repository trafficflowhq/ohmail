// What every host's entry reaches, read from the tree as text: the hosts' entries, the imports of each module
// by value (an import of types alone reaches nothing at run time), and where a specifier lands: a relative path,
// the web's `@/`, or a package of the workspace by its manifest's `exports`. A package from outside the
// workspace is not followed, and neither is an alias a bundler's config adds.
import path from "node:path";
import { readSource } from "./source-text.mjs";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ENDINGS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];
/** The web's route files and its two root hooks: what Next starts a page from. */
const WEB_ENTRY =
  /^apps\/webapp\/(app\/(.+\/)?(page|layout|template|error|global-error|not-found|loading|default|route|manifest|robots|sitemap|icon|apple-icon|opengraph-image)|middleware|instrumentation(-client)?)\.(tsx?|jsx?)$/;
/** The desktop's window and its served tab (the paired page, `apps/desktop/host.html`), and the phone's page. */
const SCRIPT_ENTRIES = [
  "apps/desktop/src/main.tsx",
  "apps/paired-page/src/main.tsx",
  "apps/mobile/web/src/main.tsx",
];
/** The phone app's routes, and the module its page's build answers `./mounted` with, one per app. */
const PHONE_ENTRY = /^apps\/mobile\/(app\/.+|web\/src\/mounted\.[a-z]+\.ts)$/;
/** The folders whose modules a host draws or runs a person's mail with: a kept row's part stands among them. */
const UI_PART =
  /^(apps\/(webapp\/app|desktop\/src|paired-page\/src|mobile\/(app|src|web\/src))|packages\/(app|app-logic|ui)\/src)\//;

const isTest = (rel) =>
  /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
export const isUiPart = (rel) =>
  UI_PART.test(rel) && SOURCE.test(rel) && !rel.endsWith(".d.ts") && !isTest(rel);

/** Every host's entry among `files`. */
export function hostEntries(files) {
  return files.filter(
    (rel) =>
      !isTest(rel) &&
      (WEB_ENTRY.test(rel) || SCRIPT_ENTRIES.includes(rel) || (PHONE_ENTRY.test(rel) && SOURCE.test(rel))),
  );
}

const SPACE = /\s/;
const STOPS = new Set([";", "'", '"', "`"]);

/**
 * The `import … from "x"` and `export … from "x"` that start at `at` (just past the word), read by hand in one pass up
 * to the clause's first `;` or quote: `{ type, clause, spec, end }`, or null when it is no such statement.
 */
function fromClause(bare, at) {
  let i = at;
  if (!SPACE.test(bare[i] ?? "")) return null;
  while (SPACE.test(bare[i] ?? "")) i += 1;
  let type = false;
  if (bare.startsWith("type", i) && SPACE.test(bare[i + 4] ?? "")) {
    type = true;
    i += 4;
    while (SPACE.test(bare[i] ?? "")) i += 1;
  }
  const start = i;
  while (i < bare.length && !STOPS.has(bare[i])) i += 1;
  if (bare[i] !== '"' && bare[i] !== "'") return { end: i };
  let last = i;
  while (last > start && SPACE.test(bare[last - 1])) last -= 1;
  if (last - start < 4 || bare.slice(last - 4, last) !== "from") return { end: i };
  let close = i + 1;
  while (close < bare.length && bare[close] !== '"' && bare[close] !== "'") close += 1;
  if (close >= bare.length || close === i + 1) return { end: i + 1 };
  return { type, clause: bare.slice(start, last - 4).trim(), spec: bare.slice(i + 1, close), end: close + 1 };
}

/** The specifiers a module imports by value: static, side-effect, dynamic and `require`; never `import type`. */
export function importsOf(text) {
  const { bare } = readSource(text);
  const found = [];
  const word = /\b(import|export)/g;
  for (let m = word.exec(bare); m; m = word.exec(bare)) {
    const read = fromClause(bare, m.index + m[1].length);
    if (!read) continue;
    word.lastIndex = Math.max(word.lastIndex, read.end);
    if (read.spec === undefined || read.type) continue;
    const names = /^\{([^}]*)\}$/
      .exec(read.clause)?.[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names?.length && names.every((name) => name.startsWith("type "))) continue;
    found.push(read.spec);
  }
  for (const m of bare.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of bare.matchAll(/\b(import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[2]);
  return found;
}

/** Where an `exports` entry sends a condition-picking reader: the source first, as the workspace's tools do. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["ohmail-source", "import", "default", "types"]) {
    const target = exportTarget(entry[key]);
    if (target) return target;
  }
  return null;
}

/**
 * @param {Set<string>} present every file of the tree
 * @param {Record<string, { name?: string, exports?: unknown, main?: string }>} manifests keyed by folder
 */
export function makeResolver(present, manifests) {
  const packages = new Map(
    Object.entries(manifests)
      .filter(([, manifest]) => manifest?.name)
      .map(([folder, manifest]) => [manifest.name, { folder, manifest }]),
  );
  const landing = (base) => {
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    const candidates = [
      base,
      ...ENDINGS.map((end) => base + end),
      ...ENDINGS.map((end) => `${base}/index${end}`),
    ];
    if (stem !== base) candidates.push(...ENDINGS.map((end) => stem + end));
    return candidates.find((candidate) => present.has(candidate)) ?? null;
  };
  return (spec, importer) => {
    if (spec.startsWith(".")) return landing(path.posix.join(path.posix.dirname(importer), spec));
    if (spec.startsWith("@/")) return landing(`apps/webapp/${spec.slice(2)}`);
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const pkg = packages.get(name);
    if (!pkg) return null;
    const sub = `.${spec.slice(name.length)}`;
    const { exports, main } = pkg.manifest;
    const target =
      (exports &&
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports)[0]?.startsWith(".")
        ? exportTarget(exports[sub])
        : sub === "."
          ? exportTarget(exports)
          : null) ?? (sub === "." ? (main ?? "src/index.ts") : null);
    return target ? landing(path.posix.join(pkg.folder, target)) : null;
  };
}

/**
 * The module graph of a tree, by value, read once a module: `edgesOf` a module's resolved imports, `closure` the
 * source modules a set of starts reaches through the workspace.
 * @param {(spec: string, importer: string) => string | null} resolve
 * @param {(rel: string) => string | null} textOf
 */
export function makeGraph(resolve, textOf) {
  const edges = new Map();
  const edgesOf = (rel) => {
    if (!edges.has(rel)) {
      const out = new Set();
      for (const spec of importsOf(textOf(rel) ?? "")) {
        const target = resolve(spec, rel);
        if (target) out.add(target);
      }
      edges.set(rel, [...out]);
    }
    return edges.get(rel);
  };
  const closure = (starts) => {
    const reached = new Set();
    const stack = [...starts];
    while (stack.length) {
      const rel = stack.pop();
      if (reached.has(rel) || !SOURCE.test(rel)) continue;
      reached.add(rel);
      for (const target of edgesOf(rel)) if (!reached.has(target)) stack.push(target);
    }
    return reached;
  };
  return { edgesOf, closure };
}

/** Check each host's runtime imports against the shell helpers the application still uses. */
export function checkHostShellImports({ files, textOf, manifests }, retained, before = retained) {
  const allowed = new Set(retained);
  const previous = new Set(before);
  const refusals = [];
  for (const file of allowed) {
    if (!file.startsWith("apps/webapp/app/shell/"))
      refusals.push(`host shell: invalid retained file ${file}`);
    if (!previous.has(file)) refusals.push(`host shell: ${file} was added to the retained list`);
  }
  const graph = makeGraph(makeResolver(new Set(files), manifests), textOf);
  for (const entry of hostEntries(files)) {
    for (const file of graph.closure([entry])) {
      if (
        file.startsWith("apps/webapp/app/views/") ||
        (file.startsWith("apps/webapp/app/shell/") && !allowed.has(file))
      ) {
        refusals.push(`host shell: ${entry} reaches ${file}`);
      }
    }
  }
  return refusals;
}
