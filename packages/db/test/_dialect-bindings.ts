import ts from "typescript";
import { existsSync } from "node:fs";

/**
 * WHAT A RAW `sql` FRAGMENT BINDS — the census's third question, and the only one needing a TYPE.
 *
 * The other two tables ask what a file's SQL SAYS, and text answers that. This one asks what a
 * file's SQL BINDS, and text cannot answer it: the defect shipped as `${releaseRequested}`, a bare
 * identifier with nothing about it to grep for. What made it a defect is the identifier's TYPE.
 *
 * ── THE CLASS, MEASURED TWICE ─────────────────────────────────────────────────────────────
 *
 * A raw template parameter carries NO column encoder. The schema's timestamp columns are
 * `integer(… { mode: "timestamp_ms" })` on the device store, and nothing maps a `Date` onto that
 * when the value arrives through a raw fragment. `node:sqlite` binds it as SQL NULL through a bare
 * `prepare().all()` and REFUSES it through `.returning()` — `Provided value cannot be bound to
 * SQLite parameter`. So `is not distinct from` compared against NULL, matched no row, and the
 * phone went on saying it organizes a mailbox whose claim was already gone. The seam's `tsOrNull`
 * is the ported spelling, and the reason it is a member rather than a caller's ternary is that the
 * caller who would have written the ternary wrote `${at}` instead.
 *
 * ── WHY A PROGRAM AND NOT A PATTERN ───────────────────────────────────────────────────────
 *
 * Two shapes the measurement found, which between them rule out every lexical reading:
 *
 *   · `${releaseRequested}` is a Date and looks like nothing. No `new Date(`, no `.toISOString()`,
 *     no name that says so — the only witness is the declaration, in another function.
 *   · `${reps.sortKey}` is `SQL.Aliased<Date>` — a drizzle alias that renders as an IDENTIFIER and
 *     binds nothing. Its type STRING contains "Date". {@link isJsDate} asks the SYMBOL instead, so
 *     the alias is outside the answer by construction rather than by an exception.
 *
 * The second reading was measured rather than argued: the same arm with the decision changed to
 * `typeToString(type).includes("Date")` reported SIXTY-SEVEN bindings where this one reports none.
 * Every one was already ported — a `PgColumn` of a column NAMED date, an `SQL<Date>` fragment the
 * seam had built, the alias. A list that names clean lines is a list its reader stops trusting.
 */

/** A value a `sql` template interpolates, and what the program says it is. */
export interface Binding {
  /** Root-relative, so a citation is a path somebody can open. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly expr: string;
  readonly kind: BindingKind;
  /** The type as the checker prints it — the citation's evidence, never its decision. */
  readonly type: string;
}

/**
 * `date` is the defect. `unresolved` is the HOLE the defect could hide in — an `any` or `unknown`
 * expression is one the checker cannot answer for, so a Date there reads as clean. It is reported
 * separately rather than folded into either answer, because "no Date" and "no Date I could see"
 * are different claims and only one of them is worth making.
 */
export type BindingKind = "date" | "boolean" | "unresolved" | "value";

/**
 * The compiler options the arm reads the tree under.
 *
 * They mirror `tools/tsconfig.base.json` rather than loading it, and the difference is deliberate: this
 * program spans packages whose own tsconfigs differ, so adopting any one of them would describe
 * the others wrongly. What matters to a TYPE question is the resolution mode, and `NodeNext`
 * against the workspace's own `node_modules` is what every package here already uses.
 *
 * Nothing is emitted and no diagnostic is read — the checker is asked about named expressions only.
 */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * A program over `files`, optionally with some of them replaced by text that is not on disk.
 *
 * The overlay is what lets a control plant a binding without writing into the tree. A planted file
 * keeps a path inside a REAL directory, so its imports resolve exactly as its neighbours' do —
 * which is the whole reason the control is evidence: a fixture whose `sql` is a local declaration
 * would prove the classifier reads a tag named `sql`, and nothing about the tag this code uses.
 */
export function bindingsProgram(
  { root, files, overlay = new Map<string, string>() }:
  { root: string; files: string[]; overlay?: ReadonlyMap<string, string> },
): ts.Program {
  const abs = files.map((f) => (f.startsWith("/") ? f : `${root}/${f}`));
  const host = ts.createCompilerHost(OPTIONS, true);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => overlay.get(name) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const planted = overlay.get(name);
    return planted === undefined
      ? getSourceFile(name, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(name, planted, languageVersion, true);
  };
  host.fileExists = (name) => overlay.has(name) || existsSync(name);
  return ts.createProgram([...new Set([...abs, ...overlay.keys()])], OPTIONS, host);
}

/**
 * Is this type the JavaScript `Date` — the object with no column encoder?
 *
 * By SYMBOL and by where that symbol is DECLARED, never by the type's printed name. Both halves
 * were measured: the printed name admits `SQL.Aliased<Date>`, which binds nothing, and a symbol
 * named `Date` from anywhere at all would admit a class somebody wrote and called Date, which is a
 * different question. A type ALIAS is transparent here — `type Instant = Date` carries the same
 * symbol — which is the behaviour a census wants and a pattern could not have.
 */
function isJsDate(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (symbol?.getName() !== "Date") return false;
  return (symbol.getDeclarations() ?? [])
    .some((d) => /(^|[/\\])lib\.[^/\\]*\.d\.ts$/.test(d.getSourceFile().fileName));
}

/**
 * Is this type a JavaScript boolean — `true`, `false` or their union? `node:sqlite` refuses one
 * outright ("Provided value cannot be bound"), and a host that coerces it does so by its own rule,
 * so a raw fragment binds a literal or goes through the column it is compared with.
 */
function isJsBoolean(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.BooleanLike) !== 0;
}

/** Every constituent of a union or intersection, flattened — a Date hides in either. */
function constituents(type: ts.Type): ts.Type[] {
  if (type.isUnionOrIntersection()) return type.types.flatMap(constituents);
  return [type];
}

/** The tag this arm reads. Asked as a whole word so a `mySql` helper is not mistaken for it. */
const SQL_TAG = /^sql$/;

/**
 * Every value a `sql` template binds in `files`, classified.
 *
 * Only the DIRECT interpolations of a tagged template are read. A nested `sql` template is a
 * separate tagged template and is visited on its own account, so a fragment composed of fragments
 * is measured once per fragment rather than once per nesting depth.
 */
export function sqlBindings(
  program: ts.Program, { root, files }: { root: string; files: string[] },
): Binding[] {
  const checker = program.getTypeChecker();
  const found: Binding[] = [];
  for (const rel of files) {
    const source = program.getSourceFile(rel.startsWith("/") ? rel : `${root}/${rel}`);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)
        && SQL_TAG.test(node.tag.getText().trim())
        && ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) {
          const type = checker.getTypeAtLocation(span.expression);
          const parts = constituents(type);
          const kind: BindingKind = parts.some(isJsDate)
            ? "date"
            : parts.some(isJsBoolean)
              ? "boolean"
            : parts.some((p) => (p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
              ? "unresolved"
              : "value";
          const { line } = source.getLineAndCharacterOfPosition(span.expression.getStart());
          found.push({
            file: rel, line: line + 1, kind,
            expr: span.expression.getText().replace(/\s+/g, " ").slice(0, 60),
            type: checker.typeToString(type).slice(0, 60),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Every tagged-template TAG in `files`, counted — the completeness check for {@link SQL_TAG}.
 *
 * A pattern that cannot match reports as a file with nothing in it, and this arm rests entirely on
 * one tag name. So the tags are enumerated rather than assumed: the day a second spelling of a
 * statement builder appears, the arm that would have read it says so instead of reading zero.
 */
export function templateTags(
  program: ts.Program, { root, files }: { root: string; files: string[] },
): Map<string, number> {
  const tags = new Map<string, number>();
  for (const rel of files) {
    const source = program.getSourceFile(rel.startsWith("/") ? rel : `${root}/${rel}`);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText().trim();
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return tags;
}

/** One citation line, in the shape the other two arms print. */
export function citeBinding(b: Binding): string {
  return `${b.file}:${b.line} — ${b.expr} is ${b.type}`;
}
