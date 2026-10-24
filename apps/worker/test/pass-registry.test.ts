import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { WORKER_PASSES } from "../src/pass-registry.js";

/**
 * THE PASS CENSUS — a pass cannot exist unregistered, and a registry row cannot outlive its pass.
 *
 * The registry (`src/pass-registry.ts`) is the map of every pass/heal/backfill/retro/sweep this
 * deployment runs. A map nobody is forced to update is a map that lies within a month, so this
 * census holds it to the source from both sides, the route/log-census way:
 *
 *  1. every pass-shaped export in `src/` (`…Pass` / `run<Upper>…`) is REGISTERED or on the
 *     named exclusion list with its reason — a new pass is red until it has a row;
 *  2. every row's module exists and exports/contains its named entry — a renamed or deleted
 *     pass is red until its row follows (the decorative-registry failure, killed);
 *  3. every operator CLI (`run-*.ts`) is claimed by a row, and every claimed CLI exists;
 *  4. every row claiming the sidecar runs its module (`sidecar-drain`) is backed by a real
 *     subpath export in package.json — the dual-mode "one implementation" rule, cross-checked.
 *
 * The extractor is self-tested on a fixture (a scanner that silently matches nothing is green
 * precisely when it is useless — the measured failure mode of every source-scanning guard here).
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Pass-shaped names: standing passes end in `Pass`; repairs and backstops are `run<Upper>…`.
 * Applied to the parser's exported-name set, so prose, strings and regex literals cannot
 * manufacture one and cannot hide one (review rounds 1 and 2).
 */
const PASS_SHAPED = /^(run[A-Z]\w*|\w*Pass)$/;

/**
 * Pass-shaped exports that are NOT passes, each with the reason it is out. A new name lands
 * here only with a reason — an empty-string reason is red.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([
  ["index.ts::runWorkerCli", "the worker's own process entry — the thing that RUNS passes"],
  ["supervisor.ts::runWorkerSupervised", "the supervisor process entry, not a pass"],
  ["cron-log.ts::runCronCli", "the CLI bottom every cron process shares — process ceremony"],
  ["sync.ts::runSyncCycle", "the wake path itself — the pipeline every pass budget exists to protect"],
  /**
   * A RE-EXPORT, not a second pass — and it is listed here only because the census got sharper:
   * the regex this file used to scan with saw `export function`/`export const` alone, so
   * `export { bubbleUpPass } from "./bubble-up-pass.js"` was invisible to it. The parser sees
   * it. The pass itself is registered at its declaring module (`bubble_up`), and this module is
   * registered as the backstop process that re-exports it (`cron_bubble_up`); a row here would
   * be the same pass counted twice.
   */
  ["bubble-up-cron.ts::bubbleUpPass", "a re-export of the pass declared in bubble-up-pass.ts (rows: bubble_up + cron_bubble_up)"],
]);

/**
 * Every `.ts` under `src/`, RECURSIVELY, as a path relative to `src/`.
 *
 * The first version read `readdirSync(SRC)` and skipped anything whose name did not end in
 * `.ts` — which silently included every DIRECTORY. A pass filed as `src/maintenance/foo.ts`
 * would then have been invisible to this census and the registry would have stayed green
 * without a row for it: the exact "a scanner that finds nothing is green" hole this file is
 * supposed to close (review round 1).
 */
/**
 * THE 31 IN-WORKER PASSES, NAMED — the census's exact set, replacing a `>= 27` floor that
 * permitted two of them to be deleted with their rows and stay green (review round 1). A new
 * pass is red here until it is listed; a deleted one is red until its name goes. This is the
 * `MUTATION_KINDS` discipline applied to the worker's passes.
 */
const IN_WORKER_PASSES: readonly string[] = [
  /* `away-responder.ts::awayResponderPass` was here until mail 0087, and its removal is the census
     working as designed: the pass moved to `packages/services/src/away-responder-pass.ts` and runs
     on the API host, because THIS app's platform blocks outbound SMTP submission at the port level
     (`smtp-size.ts`) and the responder therefore had almost certainly never delivered a reply from
     here. A pass that cannot dial is not a pass this worker owns. */
  "alert-gap-prune.ts::alertGapPrunePass",
  "alert-drill-pass.ts::alertDrillPass",
  "api-fault-prune.ts::apiFaultPrunePass",
  "refund-obligation-drain.ts::refundObligationDrainPass",
  "retention-prune.ts::retentionPrunePass",
  "retention-prune.ts::signInRetentionPass",
  "away-reply-flag-redeliver.ts::awayReplyFlagRedeliverPass",
  "blank-repair.ts::blankRepairPass",
  "bubble-up-cron.ts::runBubbleUpCron",
  "bubble-up-pass.ts::bubbleUpPass",
  "folder-ops.ts::folderOpsPass",
  "gate-release.ts::gateReleasePass",
  "sender-check-backfill.ts::senderCheckBackfillPass",
  "list-address-backfill.ts::listAddressBackfillPass",
  "inbound-quiet.ts::inboundQuietPass",
  "junk-rescue.ts::junkRescuePass",
  "junk-restore.ts::junkRestorePass",
  "junk-gone.ts::junkGonePass",
  "junk-sweep.ts::junkSweepPass",
  "kickstart.ts::runKickstart",
  "mailbox-erasure-pass.ts::mailboxErasurePass",
  "news-fold.ts::newsFoldPass",
  "news-repair.ts::legacyNewsRepairPass",
  "ohbox-tidy.ts::ohboxTidyPass",
  "proposal-cron.ts::proposalGeneratePass",
  "proposal-cron.ts::runProposalCron",
  "read-retro.ts::readStateRetroPass",
  "reconcile-cron.ts::runReconcileCron",
  "redacted-restore.ts::redactedRestorePass",
  "rule-retro.ts::ruleRetroPass",
  "gap-catchup.ts::gapCatchupPass",
  "screener-auto-act.ts::screenerAutoActPass",
  "screener-correspondent-retro.ts::screenerCorrespondentRetroPass",
  "screener-auto-suggest.ts::screenerAutoSuggestPass",
  "screener-auto.ts::screenerAutoApplyPass",
  "sender-name-backfill.ts::runSenderNameBackfill",
  "sensitive-backfill.ts::sensitiveBackfillPass",
  "storage-evict.ts::storageEvictPass",
  "sync-kick.ts::syncKickPass",
  "thread-backfill.ts::runThreadBackfill",
  "thread-join-heal.ts::threadJoinHealPass",
  "thread-subject-heal.ts::runThreadSubjectHeal",
  "workflow-cron.ts::runWorkflowCron",
  "workflow-cron.ts::workflowDrainPass",
  "workflow-cron.ts::workflowTimeScanPass",
];

function tsFilesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const abs = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...tsFilesUnder(abs, rel));
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

function detectedExports(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of tsFilesUnder(SRC)) {
    const src = readFileSync(join(SRC, rel), "utf8");
    const entries = [...exportedNames(src, rel)].filter((n) => PASS_SHAPED.test(n));
    if (entries.length > 0) found.set(rel, entries);
  }
  return found;
}

/**
 * The two registered entries that are ordinary `function` declarations — constructible for
 * legacy reasons and entirely valid passes. Measured, not assumed: every other imported entry
 * is an async function or an arrow, which JavaScript does not allow `new` on.
 */
const CONSTRUCTIBLE_BY_DESIGN: ReadonlySet<string> = new Set(["startApiCron", "startPushWake"]);

/** Does `new` work on this value? The language's own answer to "is it a constructor". */
function isConstructible(v: unknown): boolean {
  if (typeof v !== "function") return false;
  try {
    Reflect.construct(function () { /* probe */ }, [], v as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * A CLASS's source form. `class` followed by `(` is a METHOD named `class`
 * (`({ class() {} }).class` prints `class() {}`) and is an ordinary callable, so the negative
 * lookahead is what separates the two (round 12); the word boundary admits a comment directly
 * after the keyword (round 11).
 */
const CLASS_FORM = /^\s*class\b(?!\s*\()/;

/**
 * The shape `Function.prototype.toString` gives a bound or intrinsic callable: a body that is
 * exactly `{ [native code] }`. Anchored deliberately — a real pass may mention that text in a
 * diagnostic string, and rejecting it would be a false failure (round 11).
 */
const NATIVE_BODY = /\)\s*\{\s*\[native code\]\s*\}\s*$/;

/** Is this callable a CLASS? `typeof` cannot tell; the source form can, and the JS engine preserves it. */
function isClass(v: unknown): boolean {
  return typeof v === "function" && CLASS_FORM.test(Function.prototype.toString.call(v));
}

/**
 * Does this namespace EMIT anything — i.e. does it declare a value, directly or through a
 * nested namespace? A namespace whose body is only interfaces and type aliases is erased by
 * the compiler, so merging one with a type-only import produces no runtime binding at all
 * (round 7). `declare` bodies are ambient and emit nothing either.
 */
function instantiated(mod: ts.ModuleDeclaration): boolean {
  const body = mod.body;
  if (body === undefined || !ts.isModuleBlock(body)) {
    return body !== undefined && ts.isModuleDeclaration(body) ? instantiated(body) : false;
  }
  return body.statements.some((st) => {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isVariableStatement(st)) return true;
    if (ts.isEnumDeclaration(st)) return true;
    if (ts.isModuleDeclaration(st)) return instantiated(st);
    return false;
  });
}

/**
 * THE EXPORTED NAMES OF ONE MODULE, FROM TYPESCRIPT'S OWN PARSER.
 *
 * This was a hand-rolled lexer for two review rounds, and each round found a syntax it got
 * wrong: first string interiors (a declaration inside a string literal counted), then regular
 * expression literals — `const quote = /["']/;` sends a quote-tracking lexer into string mode
 * and blanks the real `export` after it, while `/export function stalePass/` reads as code and
 * would keep a deleted row green. A third syntax was waiting behind those two: `export { a as
 * b }` names `b`, not `a`, so a row naming `a` must NOT be satisfied by it.
 *
 * Rather than teach a regex the grammar one counterexample at a time, the census now asks the
 * compiler this repository already depends on. `spec.name` is deliberately the EXPORTED side of
 * a specifier (`propertyName` is the local one), which is what makes the alias case correct by
 * construction rather than by another special case.
 */
export function exportedNames(src: string, fileName = "x.ts"): Set<string> {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  /** Local names this file declares ONLY in type space — interfaces and type aliases. */
  const typeOnlyLocals = new Set<string>();
  const valueLocals = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) typeOnlyLocals.add(st.name.text);
    // An enum is a value; a namespace is one only if it is INSTANTIATED — a namespace holding
    // nothing but types is erased entirely, so it cannot satisfy a row (rounds 6 and 7).
    else if (ts.isEnumDeclaration(st)) valueLocals.add(st.name.text);
    else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name) && instantiated(st)) {
      valueLocals.add(st.name.text);
    }
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) valueLocals.add(st.name.text);
    else if (ts.isVariableStatement(st)) {
      // Binding patterns bind runtime names too — `const { fooPass } = makePasses()`. Missing
      // them made the type-only filter reject a REAL export (round 5's false-failure half).
      const bind = (n: ts.BindingName): void => {
        if (ts.isIdentifier(n)) { valueLocals.add(n.text); return; }
        for (const el of n.elements) {
          if (!ts.isOmittedExpression(el)) bind(el.name);
        }
      };
      for (const d of st.declarationList.declarations) bind(d.name);
    } else if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      const nb = clause.namedBindings;
      // `import type { x }` / `import { type x }` bind a TYPE. Re-exporting such a name emits
      // nothing at runtime, so a row naming it must not be satisfied (round 5's false-green
      // half — with this repository's non-verbatim emit the statement becomes `export {}`).
      const sink = (typeOnly: boolean): Set<string> => (typeOnly ? typeOnlyLocals : valueLocals);
      if (clause.name) sink(clause.isTypeOnly).add(clause.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) sink(clause.isTypeOnly || el.isTypeOnly).add(el.name.text);
      } else if (nb && ts.isNamespaceImport(nb)) {
        sink(clause.isTypeOnly).add(nb.name.text);
      }
    }
  }
  // A name declared in BOTH spaces (a class plus an interface of the same name) is a value.
  for (const v of valueLocals) typeOnlyLocals.delete(v);
  const mods = (n: ts.Node): readonly ts.Modifier[] =>
    ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : [];
  const has = (n: ts.Node, k: ts.SyntaxKind): boolean => mods(n).some((m) => m.kind === k);
  /**
   * A RUNTIME NAMED export, which is narrower than "a declaration with `export` on it" — the
   * distinction round 3 found, and it is the difference between a guard and a decoration:
   *
   *  · `export default function fooPass() {}` exports `default`; `fooPass` is a LOCAL name, so a
   *    row naming it must go red — the named callable is gone.
   *  · `export type { fooPass }` and `declare` exports live in type space and have no runtime
   *    value at all, so they cannot satisfy a row either.
   */
  const named = (n: ts.Node): boolean =>
    has(n, ts.SyntaxKind.ExportKeyword)
    && !has(n, ts.SyntaxKind.DefaultKeyword)
    && !has(n, ts.SyntaxKind.DeclareKeyword);
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && named(st) && st.name) {
      out.add(st.name.text);
    } else if (ts.isVariableStatement(st) && named(st)) {
      // Through binding patterns too — `export const { hiddenPass } = makePasses()` exports a
      // name a plain identifier check would miss, and a missed name is an unregistered pass
      // nothing asks about (round 9).
      const bind = (n: ts.BindingName): void => {
        if (ts.isIdentifier(n)) { out.add(n.text); return; }
        for (const el of n.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
      };
      for (const d of st.declarationList.declarations) bind(d.name);
    } else if (
      ts.isExportDeclaration(st) && !st.isTypeOnly
      && st.exportClause && ts.isNamedExports(st.exportClause)
    ) {
      /**
       * `spec.name` is the name the module EXPORTS — `a as b` exports `b`. Two kinds of
       * type-space specifier are skipped, and the second is the one round 4 found:
       *
       *  · `export { type x }` — explicit, `spec.isTypeOnly`;
       *  · `export { x }` where the LOCAL `x` in this file is only an interface or a type
       *    alias. `isTypeOnly` is false there (it records syntax, not meaning), so a pass
       *    demoted to `interface fooPass {}` would otherwise keep its row green while the
       *    callable is gone. Resolved against this file's own declarations, which is exact for
       *    a local binding and needs no type checker; a specifier with a `from` clause names
       *    another module's export and is counted, since this file cannot see it.
       */
      for (const spec of st.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        const local = (spec.propertyName ?? spec.name).text;
        if (st.moduleSpecifier === undefined && typeOnlyLocals.has(local)) continue;
        out.add(spec.name.text);
      }
    }
  }
  return out;
}

/** Does this source DECLARE `name` as an export (not merely mention it)? */
function declaresExport(src: string, name: string): boolean {
  return exportedNames(src).has(name);
}

describe("the reader itself — the syntaxes two review rounds found", () => {
  const shaped = (src: string): string[] =>
    [...exportedNames(src)].filter((n) => PASS_SHAPED.test(n)).sort();

  it("reads real declarations and refuses comment, string and regex twins", () => {
    const fixture = [
      "export async function realPass(x: number): Promise<void> {}",
      "// export async function commentedPass(): Promise<void> {}",
      "/* export const blockPass = 1; */",
      "/**",
      " * export function prosePass() — the JSDoc restatement",
      " */",
      'const s = "export function stringPass() {}";',
      "const r = /export function regexPass/;",
      "export function runRealRepair(): void {}",
      "export const notAPassShape = 1;",
    ].join("\n");
    expect(shaped(fixture)).toEqual(["realPass", "runRealRepair"]);
  });

  it("a regex holding a quote does not blank the export after it (round 2)", () => {
    // The hand-rolled lexer entered string mode at the quote INSIDE the regex and lost the
    // declaration that followed — a valid row rejected.
    const fixture = ['const quote = /["\']/;', "export async function afterRegexPass(): Promise<void> {}"].join("\n");
    expect(shaped(fixture)).toEqual(["afterRegexPass"]);
  });

  it("an alias exports the NEW name only — a row naming the old one stays red (round 2)", () => {
    const fixture = ["async function oldPass(): Promise<void> {}", "export { oldPass as newPass };"].join("\n");
    expect(declaresExport(fixture, "newPass")).toBe(true);
    expect(declaresExport(fixture, "oldPass")).toBe(false);
  });

  it("a DEFAULT export does not satisfy a row naming the function (round 3)", () => {
    // `default` is what the module exports; `defaultedPass` is a local name only.
    expect(declaresExport("export default function defaultedPass(): void {}", "defaultedPass")).toBe(false);
  });

  it("type-only and ambient exports carry no runtime value (round 3)", () => {
    expect(declaresExport("type typedPass = () => void;\nexport type { typedPass };", "typedPass")).toBe(false);
    expect(declaresExport("export { valuePass, type typedPass } from './x.js';", "typedPass")).toBe(false);
    expect(declaresExport("export { valuePass, type typedPass } from './x.js';", "valuePass")).toBe(true);
    expect(declaresExport("export declare function ambientPass(): void;", "ambientPass")).toBe(false);
  });

  it("a pass demoted to an INTERFACE and re-exported is not a runtime export (round 4)", () => {
    const fixture = ["interface typedPass { x: number }", "export { typedPass };"].join("\n");
    expect(declaresExport(fixture, "typedPass")).toBe(false);
  });

  it("a local VALUE exported the same way still counts", () => {
    const fixture = ["async function localPass(): Promise<void> {}", "export { localPass };"].join("\n");
    expect(declaresExport(fixture, "localPass")).toBe(true);
  });

  it("a name imported as a TYPE and re-exported is not a runtime export (round 5)", () => {
    for (const imp of ['import type { fooPass } from "./t.js";', 'import { type fooPass } from "./t.js";']) {
      expect(declaresExport([imp, "export { fooPass };"].join("\n"), "fooPass")).toBe(false);
    }
    // …while the value form still counts.
    expect(declaresExport(['import { fooPass } from "./t.js";', "export { fooPass };"].join("\n"), "fooPass")).toBe(true);
  });

  it("a binding pattern binds a runtime name (round 5)", () => {
    const fixture = [
      "type fooPass = () => void;",
      "const { fooPass } = makePasses();",
      "export { fooPass };",
    ].join("\n");
    expect(declaresExport(fixture, "fooPass")).toBe(true);
  });

  it("a namespace merged with a type-only import IS a runtime value (round 6)", () => {
    const fixture = [
      'import type { fooPass } from "./t.js";',
      "namespace fooPass { export const x = 1; }",
      "export { fooPass };",
    ].join("\n");
    expect(declaresExport(fixture, "fooPass")).toBe(true);
  });

  it("a namespace of only TYPES is erased and satisfies nothing (round 7)", () => {
    const fixture = [
      'import type { fooPass } from "./t.js";',
      "namespace fooPass { export interface X { a: number } }",
      "export { fooPass };",
    ].join("\n");
    expect(declaresExport(fixture, "fooPass")).toBe(false);
  });

  it("an exported binding pattern is DISCOVERED (round 9)", () => {
    const found = [...exportedNames("export const { hiddenPass } = makePasses();")];
    expect(found).toContain("hiddenPass");
  });

  it("constructibility, not printed text, is what the runtime check asks (round 13)", () => {
    // The cases five rounds of text-matching kept getting wrong — settled by the language.
    expect(isConstructible(class Real {})).toBe(true);
    class Bindable {}
    expect(isConstructible(Bindable.bind(null))).toBe(true);
    /**
     * The exact spelling the text rule could not survive: the comment sits BEFORE the
     * parenthesis, so `class\b(?!\s*\()` — which only skipped whitespace — read it as a class.
     * Asserted both ways here, so the fixture reproduces the case rather than a milder one.
     */
    // Built from a STRING, deliberately: this file is transpiled before it runs and the
    // transform strips the comment, so a literal here would silently become the milder
    // `class()` spelling and the fixture would stop reproducing the case (round 14).
    const methodNamedClass = eval("({ class /* c */ () { return 1; } }).class") as () => number;
    expect(CLASS_FORM.test(Function.prototype.toString.call(methodNamedClass))).toBe(true); // the text rule was wrong…
    expect(isConstructible(methodNamedClass)).toBe(false);                                  // …and this is right.
    expect(isConstructible(async function realPass(): Promise<void> {})).toBe(false);
    expect(isConstructible(() => undefined)).toBe(false);
    // …and the two legacy-constructible plain declarations the registry really holds.
    expect(isConstructible(function startApiCron(): void {})).toBe(true);
  });

  it("a method NAMED class is a callable, not a class (round 12)", () => {
    const obj = { class() { return 1; } };
    expect(Function.prototype.toString.call(obj.class).startsWith("class")).toBe(true);
    expect(isClass(obj.class)).toBe(false);
    expect(isClass(class Real {})).toBe(true);
  });

  it("the two shape rules are precise, not approximate (round 11)", () => {
    // A comment right after `class` is valid source that toString preserves.
    expect(isClass(eval("(class/*c*/ Sneaky {})"))).toBe(true);
    // …and a function that merely MENTIONS the native marker is a real function.
    const authored = function realPass(): string { return "not [native code], just text"; };
    expect(NATIVE_BODY.test(Function.prototype.toString.call(authored))).toBe(false);
    expect(NATIVE_BODY.test(Function.prototype.toString.call(authored.bind(null)))).toBe(true);
  });

  it("a BOUND class hides from the source form but not from the rule (round 10)", () => {
    class Replacement {}
    const bound = Replacement.bind(null);
    const form = Function.prototype.toString.call(bound);
    expect(isClass(bound)).toBe(false);              // the source form cannot see it…
    expect(/\[native code\]/.test(form)).toBe(true); // …and this is what does.
  });

  it("a class is not a callable pass (round 9)", () => {
    expect(isClass(class fooPass {})).toBe(true);
    expect(isClass(async function realPass(): Promise<void> {})).toBe(false);
    expect(isClass(() => undefined)).toBe(false);
  });

  it("a plain re-export satisfies a row naming it", () => {
    expect(declaresExport("export { somePass } from './x.js';", "somePass")).toBe(true);
  });
});

describe("the worker pass registry", () => {
  const detected = detectedExports();
  const rows = WORKER_PASSES;

  it("every pass-shaped export in src/ is registered, or excluded with a stated reason", () => {
    const registered = new Set(
      rows
        .filter((r) => r.module.startsWith("apps/worker/src/"))
        .map((r) => `${r.module.slice("apps/worker/src/".length)}::${r.entry}`),
    );
    const unaccounted: string[] = [];
    for (const [file, entries] of detected) {
      for (const entry of entries) {
        const key = `${file}::${entry}`;
        if (registered.has(key)) continue;
        const reason = EXCLUDED.get(key);
        if (reason !== undefined && reason.length > 0) continue;
        unaccounted.push(key);
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it("the census is not vacuous: the extractor sees exactly the in-worker passes the registry names", () => {
    const inWorker = rows.filter((r) => r.module.startsWith("apps/worker/src/"));
    const passShaped = inWorker.filter((r) => /^(run[A-Z]\w*|\w*Pass)$/.test(r.entry));
    for (const r of passShaped) {
      const file = r.module.slice("apps/worker/src/".length);
      expect(detected.get(file) ?? [], `${r.module} should export ${r.entry}`).toContain(r.entry);
    }
    /**
     * EXACT SET, not a floor. The first version asserted `>= 27` against the then-29 measured
     * passes,
     * which let TWO passes be deleted with their rows and stay green — a census that permits
     * the thing it exists to detect (review round 1). Naming them means a deletion is red and
     * an addition is red until it is listed, which is the whole point.
     */
    expect([...passShaped].map((r) => `${r.module.slice("apps/worker/src/".length)}::${r.entry}`).sort())
      .toEqual([...IN_WORKER_PASSES].sort());
  });

  it("every row's module exists and DECLARES its entry as an export — no decorative rows", () => {
    for (const r of rows) {
      const p = join(REPO, r.module);
      expect(existsSync(p), `${r.module} (row '${r.name}') does not exist`).toBe(true);
      const src = readFileSync(p, "utf8");
      // A comment-stripped export DECLARATION, not `includes`: prose that names a deleted
      // function would otherwise keep its row green (review round 1).
      expect(declaresExport(src, r.entry), `${r.module} does not export '${r.entry}' (row '${r.name}')`).toBe(true);
    }
  });

  it("the comment stripper is not the hole it closes", () => {
    const fixture = [
      "// export function commentedPass(): void {}",
      "/* export const blockPass = 1; */",
      "const s = \"export function stringPass() {}\";",
      "export async function realPass(): Promise<void> {}",
    ].join("\n");
    expect(declaresExport(fixture, "realPass")).toBe(true);
    expect(declaresExport(fixture, "commentedPass")).toBe(false);
    expect(declaresExport(fixture, "blockPass")).toBe(false);
    expect(declaresExport(fixture, "stringPass")).toBe(false);
  });

  /**
   * THE GROUND TRUTH, AND WHY IT ENDS AN ARGUMENT THE PARSER COULD NOT.
   *
   * Rounds 2–7 walked steadily deeper into TypeScript's symbol space — regex literals, aliased
   * specifiers, default exports, type-only exports and imports, binding patterns, namespace
   * merging, erased namespaces — each a real way for a SYNTACTIC reader to disagree with what
   * the module actually exports. That is a spec-shaped chase with no natural end, and its
   * subject is a question with a direct answer: import the module and look.
   *
   * So this is the check that decides a row's fate. Every registered entry must be a callable
   * the module really exports at runtime; no syntax reasoning can make a dead row survive it,
   * and none is consulted. {@link exportedNames} keeps a narrower job — DISCOVERING pass-shaped
   * exports so an unregistered pass is caught — where the same syntaxes cost a false name at
   * worst, which the exact-set pin then reports.
   *
   * One documented exception: `index.ts` is the worker's composition root and its row names a
   * constant (`MAINTENANCE_EVERY_MS`); importing it here would pull the whole boot graph into
   * a unit test for no gain, and the parser already covers a constant's declaration.
   */
  it("every registered entry is a REAL runtime export — imported, not parsed", async () => {
    for (const r of rows) {
      if (r.module === "apps/worker/src/index.ts") continue;
      const mod = (await import(pathToFileURL(join(REPO, r.module)).href)) as Record<string, unknown>;
      const value = mod[r.entry];
      expect(typeof value, `${r.module} does not export a callable '${r.entry}' (row '${r.name}')`)
        .toBe("function");
      /**
       * AND IT MUST BE A FUNCTION SOMEBODY WROTE, which `typeof` cannot say. A class answers
       * `"function"` while throwing when called (round 9), and a BOUND class —
       * `Replacement.bind(null)` — hides its class-ness from the source form (round 10) while
       * still throwing. Both are excluded by one rule instead of two special cases: the value's
       * own source must read as a function or an arrow, never `class …` and never
       * `[native code]`, which is what every bound or intrinsic callable prints. Measured
       * against the real registry: 28 of the 30 imported entries are not constructible at all
       * (async functions and arrows), and the two that are — `startApiCron`, `startPushWake` —
       * are ordinary `function` declarations, which this rule accepts and a bound impostor
       * fails.
       */
      const form = Function.prototype.toString.call(value as (...a: never[]) => unknown);
      /**
       * ── NOT A CONSTRUCTOR, ASKED OF THE LANGUAGE RATHER THAN OF THE PRINTED SOURCE ────────
       *
       * Rounds 9 to 13 all lived in one place: a regex deciding, from `toString` text, whether
       * a callable is a class. Every round found another way for text to mislead it — a bound
       * class printing as native code, a comment after the keyword, a METHOD NAMED `class`, a
       * comment before that method's parenthesis. The text is not the fact.
       *
       * `Reflect.construct` asks the fact. A class (bound or not) is constructible; an async
       * function, an arrow and a method named `class` are not. Measured against the real
       * registry: 28 of the 30 imported entries are non-constructible, and the two that are —
       * `startApiCron`, `startPushWake` — are ordinary `function` declarations, legacy-
       * constructible and perfectly valid passes. Those two are named, and for them the only
       * text question left is one no class can pass: does the source begin with `function`.
       *
       * A bound impostor is excluded before either branch, by the native body — the one thing
       * `toString` states rather than merely renders.
       */
      expect(NATIVE_BODY.test(form), `${r.module} exports '${r.entry}' as a bound or intrinsic callable`).toBe(false);
      if (CONSTRUCTIBLE_BY_DESIGN.has(r.entry)) {
        expect(/^\s*(async\s+)?function\b/.test(form),
          `${r.module} exports '${r.entry}', which should be a plain function declaration`).toBe(true);
      } else {
        expect(isConstructible(value), `${r.module} exports '${r.entry}' as a constructor, not a pass`).toBe(false);
      }
    }
  }, 120_000);

  it("rows are complete and unique: non-empty facts, one row per (module, entry)", () => {
    const seen = new Set<string>();
    for (const r of rows) {
      for (const field of ["name", "module", "entry", "cadence", "budget", "owns", "fence"] as const) {
        expect(r[field].length, `row '${r.name}' has an empty '${field}'`).toBeGreaterThan(0);
      }
      expect(r.triggers.length, `row '${r.name}' names no trigger`).toBeGreaterThan(0);
      const key = `${r.module}::${r.entry}`;
      expect(seen.has(key), `duplicate row for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("every operator CLI (run-*.ts) is claimed by exactly one row, and every claim exists", () => {
    /* AN OPERATOR CLI IS A `run-*.ts` NOTHING ELSE IMPORTS. The 0.22 backend remainder put the
       runners' shared scaffold in `run-cli.ts` — the flags, the mailbox read and the lease door —
       and a name-only rule read that library as a fourteenth operator command with no row to
       claim it. Being imported is the discriminator, and it is structural: a scaffold has callers
       inside `src`, an entry point has none. The assertion below still refuses a real CLI that
       nobody claims, which is what this arm is for. */
    const runFiles = readdirSync(SRC).filter((n) => n.startsWith("run-") && n.endsWith(".ts"));
    const importedBySrc = (name: string): boolean => readdirSync(SRC)
      .filter((o) => o.endsWith(".ts") && o !== name)
      .some((o) => readFileSync(join(SRC, o), "utf8").includes(`${name.replace(/\.ts$/, "")}.js`));
    const cliFiles = runFiles.filter((n) => !importedBySrc(n));
    expect(runFiles.length, "no run-*.ts at all — the arm would pass by measuring nothing")
      .toBeGreaterThan(0);
    expect(cliFiles.length, "every run-*.ts is imported — the arm would claim nothing")
      .toBeGreaterThan(0);
    const claimed = new Map<string, string>();
    for (const r of rows) {
      for (const c of r.cli ?? []) {
        expect(claimed.has(c), `${c} is claimed by both '${claimed.get(c)}' and '${r.name}'`).toBe(false);
        claimed.set(c, r.name);
        expect(existsSync(join(SRC, c)), `row '${r.name}' claims ${c}, which does not exist`).toBe(true);
      }
    }
    expect([...claimed.keys()].sort()).toEqual(cliFiles.sort());
  });

  it("every sidecar-drain row is backed by a real subpath export — the dual-mode rule, cross-checked", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      exports: Record<string, string | { default?: string }>;
    };
    const exported = new Set(
      Object.values(pkg.exports)
        // A subpath is a path, or a conditions object whose `default` is the path.
        .map((e) => (typeof e === "string" ? e : e.default ?? ""))
        .filter((p) => p.startsWith("./src/"))
        .map((p) => p.slice("./src/".length)),
    );
    for (const r of rows) {
      if (!r.triggers.includes("sidecar-drain")) continue;
      const file = r.module.slice("apps/worker/src/".length);
      expect(exported.has(file), `row '${r.name}' claims the sidecar runs it, but ${file} is not a subpath export`).toBe(true);
    }
  });
});
