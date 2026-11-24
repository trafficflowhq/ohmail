// The workspace as the rules see it: every folder under apps/ and packages/, its manifest, and its
// row of tools/borders.json. Read once per root; the rules ask it who a file is and what an import
// reaches.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const BUILTINS = new Set(builtinModules);
const DECLARED_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const names = (manifest, fields) => new Set(fields.flatMap((f) => Object.keys(manifest?.[f] ?? {})));

/** `packages/core/src/a.ts` → `packages/core`; anything else → null. */
export function unitFolder(rel) {
  const parts = rel.split("/");
  return (parts[0] === "apps" || parts[0] === "packages") && parts.length > 2
    ? `${parts[0]}/${parts[1]}`
    : null;
}

/** A file under a test folder, or named as a test. Tests get their row plus `tests.alsoImport`. */
export function isTestFile(rel) {
  return /(^|\/)(test|tests|__tests__|e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** A file that is run by a tool and never shipped: a tool's config, or a script beside the source. */
export function isToolingFile(rel) {
  return /(^|\/)scripts\//.test(rel) || /(^|\/)[^/]+\.config\.[cm]?[jt]s$/.test(rel);
}

/** The package an import names: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
export function packageNameOf(source) {
  const parts = source.split("/");
  return source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function scan(root, parent) {
  const dir = path.join(root, parent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

function rowOf(borders, folder) {
  const [parent, key] = folder.split("/");
  if (parent === "apps") return borders.apps?.[key] ? { key, kind: "app", ...borders.apps[key] } : null;
  for (const [name, row] of Object.entries(borders.packages ?? {})) {
    if ((row.folders ?? [`packages/${name}`]).includes(folder)) return { key: name, kind: "package", ...row };
  }
  return null;
}

/**
 * @param {string} root the repository root
 * @param {{ borders?: object, manifests?: Record<string, object> }} [given] data handed in by a test
 */
export function loadWorkspace(root, given = {}) {
  const borders = given.borders ?? readJson(path.join(root, "tools/borders.json"));
  const manifests = given.manifests ?? null;
  const manifestOf = (folder) => {
    if (manifests) return manifests[folder] ?? null;
    const file = path.join(root, folder, "package.json");
    return existsSync(file) ? readJson(file) : null;
  };
  const folders = manifests
    ? Object.keys(manifests).filter((f) => f !== ".")
    : [...scan(root, "apps"), ...scan(root, "packages")];
  const rootManifest = manifestOf(".") ?? {};
  const rootNames = names(rootManifest, [...DECLARED_FIELDS, "devDependencies"]);

  const units = new Map();
  const byName = new Map();
  const unitAt = (folder) => {
    if (units.has(folder)) return units.get(folder);
    const manifest = manifestOf(folder);
    const unit = {
      folder,
      kind: folder.startsWith("apps/") ? "app" : "package",
      row: rowOf(borders, folder),
      name: manifest?.name ?? null,
      manifest,
      shipped: names(manifest, DECLARED_FIELDS),
      all: names(manifest, [...DECLARED_FIELDS, "devDependencies"]),
    };
    units.set(folder, unit);
    return unit;
  };
  for (const folder of folders) {
    const unit = unitAt(folder);
    if (unit.name) byName.set(unit.name, unit);
  }

  const rootFolders = new Set(borders.roots?.folders ?? []);
  const rootUnit = {
    folder: ".",
    kind: "root",
    row: { key: ".", kind: "root" },
    name: rootManifest.name ?? null,
    manifest: rootManifest,
    shipped: rootNames,
    all: rootNames,
  };
  const strayUnit = (rel) => ({ ...rootUnit, row: null, folder: rel.split("/")[0] });

  /** Who a file is. `unit.row` is null for a folder the border table does not name. */
  function classify(file) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const folder = unitFolder(rel);
    const first = rel.split("/")[0];
    // A file at the root itself, or under a root folder the table names, is the repository's own.
    const unit = folder
      ? unitAt(folder)
      : first === rel || rootFolders.has(first)
        ? rootUnit
        : strayUnit(rel);
    return { rel, unit, test: isTestFile(rel), tooling: isToolingFile(rel) || unit.kind === "root" };
  }

  /** What an import reaches: another unit of the product, a registry package, or nothing we judge. */
  function resolve(file, source) {
    if (source.startsWith(".") || source.startsWith("/")) {
      const target = classify(path.resolve(path.dirname(file), source.split("?")[0]));
      if (target.rel.startsWith("..")) return { kind: "own" };
      return { kind: "unit", unit: target.unit, byPath: true };
    }
    if (source.startsWith("node:") || BUILTINS.has(source)) return { kind: "builtin" };
    const name = packageNameOf(source);
    return byName.has(name)
      ? { kind: "unit", unit: byName.get(name), byPath: false }
      : { kind: "external", name };
  }

  return { root, borders, units, byName, rootNames, classify, resolve };
}

/** The packages a file's row lets it import; `"*"` is every package. */
function allowedPackages(workspace, importer) {
  const { row } = importer.unit;
  const extra = importer.test ? (workspace.borders.tests?.alsoImport ?? []) : [];
  if (row.kind === "app")
    return { any: true, never: (row.never ?? []).filter((key) => !extra.includes(key)), typesOnly: [] };
  if (row.imports === "*") return { any: true, never: [], typesOnly: [] };
  return { any: false, names: [...row.imports, ...extra], never: [], typesOnly: row.typesOnly ?? [] };
}

/**
 * The border verdict on one import: null when it may stand, else the reason.
 * @param {{ typeOnly: boolean }} how
 */
export const borderVerdict = (workspace, file, source, how) =>
  borderRefusal(workspace, file, source, how)?.why ?? null;

/**
 * The same verdict with what the import reached: a package's key of the table, or a folder.
 * @param {{ typeOnly: boolean }} how
 * @returns {{ why: string, reach: string } | null}
 */
export function borderRefusal(workspace, file, source, how) {
  const why = (text, reach) => ({ why: text, reach });
  const importer = workspace.classify(file);
  if (!importer.unit.row) return null; // refused once per file, by the rule itself
  const reached = workspace.resolve(file, source);
  if (reached.kind !== "unit" || reached.unit === importer.unit) return null;
  const from = importer.unit.folder;
  const target = reached.unit;
  const how_ = reached.byPath ? " by path" : "";
  if (importer.unit.kind === "root") return null;
  if (target.kind === "root") {
    if (!target.row)
      return why(
        `${from} imports ${target.folder}/${how_}, a folder the border table does not name`,
        target.folder,
      );
    return importer.test || importer.tooling
      ? null
      : why(`${from} imports the repository's own ${source}${how_}; source imports only packages`, "root");
  }
  if (target.kind === "app") {
    const key = target.folder.split("/")[1];
    if (importer.unit.kind === "app" && (importer.unit.row.apps ?? []).includes(key)) return null;
    return why(`${from} imports the app ${target.folder}${how_}; an app is never imported`, target.folder);
  }
  if (!target.row)
    return why(
      `${from} imports ${target.folder}${how_}, which has no row in tools/borders.json`,
      target.folder,
    );
  const allowed = allowedPackages(workspace, importer);
  const key = target.row.key;
  if (allowed.never.includes(key)) return why(`${from} imports ${key}${how_}; its row refuses ${key}`, key);
  if (allowed.any || allowed.names.includes(key)) return null;
  if (allowed.typesOnly.includes(key)) {
    return how.typeOnly
      ? null
      : why(`${from} imports a value of ${key}${how_}; its row allows types only (import type)`, key);
  }
  return why(
    `${from} imports ${key}${how_}; its row names ${allowed.names.length ? allowed.names.join(", ") : "nothing"}`,
    key,
  );
}

/**
 * The manifest verdict on one import: null when it is declared, else the reason. An
 * import the border check already refuses is not judged twice.
 * @param {{ typeOnly: boolean }} how
 */
export function declaredVerdict(workspace, file, source, how) {
  const importer = workspace.classify(file);
  if (!importer.unit.row || borderVerdict(workspace, file, source, how)) return null;
  const reached = workspace.resolve(file, source);
  if (reached.kind === "builtin" || reached.kind === "own") return null;
  if (
    reached.kind === "unit" &&
    (reached.unit === importer.unit || reached.unit.kind === "root" || importer.unit.kind === "root")
  )
    return null;
  const name = reached.kind === "unit" ? reached.unit.name : reached.name;
  const where =
    importer.unit.folder === "." ? "the root package.json" : `${importer.unit.folder}/package.json`;
  if (!importer.unit.manifest)
    return `${importer.unit.folder} has no package.json to declare ${name ?? source}`;
  if (!name) return `${source} reaches ${reached.unit.folder}, which has no package name to declare`;
  // A test, a tool's config and a type are not shipped: a development dependency is enough for them.
  const lenient = importer.test || importer.tooling || how.typeOnly;
  const declared = (set) =>
    set.has(name) || (how.typeOnly && set.has(`@types/${name.replace(/^@/, "").replace("/", "__")}`));
  if (declared(importer.unit.shipped)) return null;
  if (lenient && (declared(importer.unit.all) || declared(workspace.rootNames))) return null;
  return `${name} is not declared in ${where}${lenient ? " or in the root's" : ""}`;
}
