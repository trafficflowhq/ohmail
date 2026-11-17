import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as door from "../src/engine.js";
import { ENGINE_DOOR, ENGINE_SRC, engineUnitFiles } from "../../../test/support/engine-unit.js";

/**
 * THE ENGINE HAS ONE DOOR. `createSidecar`'s prelude and its sections stand in flat `engine-*.ts` files
 * beside `engine.ts`, one unit with one way in: the shell's entry, the phone's and every test come
 * through `engine.ts`, which answers the names it answered when the engine was one file. A module that
 * imports a section file directly makes that section's inside somebody's contract; a section that
 * imports the door is a cycle the two bundlers would order by chance. Read from the import graph with
 * the TypeScript parser, so a specifier inside a string or a comment is no import.
 */

const ROOT = resolve(ENGINE_SRC, "..", "..", "..");

/** The door's values and types, as the engine answered them before the cut. A change here changes the engine's contract. */
const VALUES = [
  "BAKED_ENGINE_VERSION", "ConnectionReplacedError", "DEFAULT_HEARTBEAT_TIMEOUT_MS", "DEFAULT_POLL_INTERVAL_MS",
  "DESKTOP_RECONNECT", "IDLE_POLL_CEILING_MS", "LOCAL_CONNECTIONS_LOG_EVERY_MS", "LOCAL_CONNECTION_DEAD_AFTER_CYCLES",
  "LOCAL_CONNECTION_DEAD_AFTER_MS", "LOCAL_INBOUND_QUIET_EVERY_MS", "LOCAL_JOIN_HEAL_EVERY_MS", "LOCAL_NAME_BACKFILL_BATCH",
  "LOCAL_NAME_BACKFILL_PAGES", "PHONE_RECONNECT", "QUIT_OFFER_RESERVE_MS", "QuitLeftOpenError", "RECONNECT_PROFILES",
  "REDIAL_BACKOFF_BASE_MS", "REDIAL_BACKOFF_MAX_MS", "SIDECAR_NET_TIMEOUTS", "STORE_REFUSED_DETAIL", "SignedOutError",
  "UNMETERED_MAILBOX_ALLOWANCE", "WallWait", "certificateRefused", "createSidecar", "credentialsRefused", "dialWentQuiet",
  "discloseLocalSyncFailures", "discloseProviderConfirms", "drainFailureKeepsTheLogin", "engineBuildLabel", "fetchRefusal",
  "fetchRefused", "isConnectionFailure", "nextIdlePollMs", "reconnectProfile", "redialStepMs", "refusingKeyProvider",
  "resolveHeartbeatTimeoutMs", "seedDial", "settledWithin", "summarizeDrain", "tlsRefused", "withForcedRedial",
  "withImportHandover", "withPullKick", "withSeenPush",
];
const TYPES = [
  "AdapterDialContext", "BootPhase", "CredentialBlock", "CredentialState", "DialAnswer", "FirstSyncState", "LaunchReport",
  "MailboxConnectionState", "OpenLocalDbFn", "OrganizerState", "QuitPlan", "QuitReport", "ReconnectProfile", "Sidecar",
  "SidecarConfig", "SidecarImapConfig",
];

const parse = (path: string, text: string = readFileSync(path, "utf8")): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Every name a module's own statements export: `export { a } from …` by name, `*` for a wholesale re-export. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause === undefined) names.push("*");
      else if (ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.push(e.name.text);
      else names.push(`* as ${st.exportClause.name.text}`);
      continue;
    }
    if (!(ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) continue;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push(d.name.getText(sf));
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text);
    else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) names.push(st.name.text);
  }
  return names.sort();
}

/** Every module a file names: import and export declarations, `import()` and `require()`, and `import("…")` in a type. */
function specifiersOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const first = n.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) out.push(first.text);
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A relative specifier as the file it names, without its extension; null for a package's. */
const named = (from: string, specifier: string): string | null =>
  specifier.startsWith(".") ? resolve(dirname(from), specifier).replace(/\.(?:[cm]?[jt]sx?)$/, "") : null;
const bare = (path: string): string => path.replace(/\.(?:[cm]?[jt]sx?)$/, "");

/** The modules a file loads when it runs: its imports and re-exports of a value, not those of types alone. */
function valueImportsOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const bindings = clause?.namedBindings;
      if (clause === undefined || (!clause.isTypeOnly && (clause.name !== undefined || (bindings !== undefined
        && (ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly)))))) out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.exportClause;
      if (!st.isTypeOnly && (clause === undefined || !ts.isNamedExports(clause) || clause.elements.some((e) => !e.isTypeOnly))) {
        out.push(st.moduleSpecifier.text);
      }
    }
  }
  return out;
}

/** The files of the engine's folder a file loads by a relative value import, each read once. */
const loaded = new Map<string, string[]>();
function loadsOf(file: string): string[] {
  let found = loaded.get(file);
  if (found === undefined) {
    found = valueImportsOf(parse(file)).flatMap((s) => {
      const base = named(file, s);
      if (base === null || relative(ENGINE_SRC, base).startsWith("..")) return [];
      return [".ts", ".tsx", ".js", ".mjs", `${sep}index.ts`].map((ext) => base + ext).filter((p) => existsSync(p)).slice(0, 1);
    });
    loaded.set(file, found);
  }
  return found;
}

/** The chain of value imports by which a part loads the door, or null when what it loads in the folder never does. */
function wayToTheDoor(part: string): string[] | null {
  const seen = new Set([part]);
  const queue = [[part]];
  for (let chain = queue.shift(); chain !== undefined; chain = queue.shift()) {
    for (const next of loadsOf(chain.at(-1)!)) {
      if (bare(next) === bare(ENGINE_DOOR)) return [...chain, next];
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "generated", "target", "coverage", ".gradle", "Pods", ".expo"]);
/** Every source file of the repository that names an `engine-` module anywhere in its text, the unit's own aside. */
function namingAPart(dir: string, unit: ReadonlySet<string>, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) namingAPart(p, unit, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !unit.has(p) && readFileSync(p, "utf8").includes("engine-")) out.push(p);
  }
  return out;
}

describe("the desktop engine's door", () => {
  it("answers the 48 values it answered when the engine was one file", () => {
    expect(Object.keys(door).sort()).toEqual([...VALUES].sort());
  });

  it("exports the 64 names by name, the 16 types with them, and nothing wholesale", () => {
    expect(exportedNames(parse(ENGINE_DOOR))).toEqual([...VALUES, ...TYPES].sort());
  });

  it("is entered by no file of its own unit", () => {
    const parts = engineUnitFiles().filter((f) => f !== ENGINE_DOOR);
    expect(parts.length).toBeGreaterThan(0);
    const through = parts.flatMap((f) => specifiersOf(parse(f)).filter((s) => named(f, s) === bare(ENGINE_DOOR))
      .map((s) => `${relative(ROOT, f)} imports ${s}`));
    expect(through).toEqual([]);
    // Nor through what a part loads: a part that imports `./index.js`, which loads the door, closes the same cycle.
    const around = parts.map((f) => wayToTheDoor(f)).filter((way) => way !== null)
      .map((way) => way.map((p) => relative(ROOT, p)).join(" -> "));
    expect(around).toEqual([]);
  });

  it("is the only way into the unit: nothing outside it imports one of its parts", () => {
    const unit = new Set(engineUnitFiles());
    const parts = new Set([...unit].filter((f) => f !== ENGINE_DOOR).map(bare));
    const around = namingAPart(ROOT, unit).flatMap((f) => specifiersOf(parse(f)).filter((s) => parts.has(named(f, s) ?? ""))
      .map((s) => `${relative(ROOT, f)} imports ${s}`));
    expect(around).toEqual([]);
  });
});
