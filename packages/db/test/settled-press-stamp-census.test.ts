import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ THE PRESS STAMP HAS ONE WRITER AND ONE READER ═════════════════════════════════════════
 *
 * `rules.settled_press_at` (mail 0159) is the reader belt's ordering stamp: the `decidedAt` of a
 * create that settled with the row already as it asks, so an older press the belt settles later
 * (at a leave) stands down under it. `updated_at` was not moved for that, because the rules
 * surface, the gap pass's rule age and the settings document read it. The stamp stays out of all
 * of them only while nothing else names it: a second writer could stand down a press nobody
 * settled, and a second reader would put the belt's bookkeeping on a surface.
 *
 * So every product reference is counted: the two schema declarations, the one `.set()` in
 * `settleReaderRuleRows` that writes it and the one comparison there that reads it. Its SQL name
 * may appear only where the schema declares it, where the device journal applies the migration
 * and where `/health` probes it. Known limit: a whole-row spread names no column, so a writer
 * copying a selected row into another would not be seen here; none exists.
 */

const HERE = resolve(import.meta.dirname ?? ".");
const REPO = resolve(HERE, "../../..");
const PROPERTY = "settledPressAt";
const COLUMN = "settled_press_at";

/** Every product source root: each app's and package's `src`, and the web app's `app`. */
function roots(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const name of readdirSync(join(REPO, top))) {
      for (const sub of ["src", "app"]) {
        const dir = join(REPO, top, name, sub);
        if (existsSync(dir) && statSync(dir).isDirectory()) out.push(dir);
      }
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...sourceFiles(p)); continue; }
    if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

type Kind = "declare" | "write" | "read" | "sql";
interface Hit { at: string; kind: Kind }

function enclosingFn(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
  }
  return "<module>";
}

/** The call an object literal is an argument of, through nested literals; else null. */
function callOf(obj: ts.ObjectLiteralExpression): ts.CallExpression | null {
  let n: ts.Node = obj;
  while (n.parent && (ts.isObjectLiteralExpression(n.parent) || ts.isPropertyAssignment(n.parent))) n = n.parent;
  return n.parent && ts.isCallExpression(n.parent) ? n.parent : null;
}

function calleeName(call: ts.CallExpression): string {
  const c = call.expression;
  return ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : "";
}

/** A mention of the property: declared in a table, written by a `.set()`/`.values()`, else read. */
function kindOf(id: ts.Identifier): Kind {
  const p = id.parent;
  if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name === id
    && ts.isObjectLiteralExpression(p.parent)) {
    const call = callOf(p.parent);
    const name = call ? calleeName(call) : "";
    if (name === "pgTable" || name === "sqliteTable") return "declare";
    if (name === "set" || name === "values") return "write";
  }
  return "read";
}

/** Every mention in one source text, by `file#function` and kind. Comments are not nodes. */
function hitsIn(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Hit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === PROPERTY) out.push({ at: `${file}#${enclosingFn(n)}`, kind: kindOf(n) });
    else if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      && n.text.includes(COLUMN)) out.push({ at: `${file}#${enclosingFn(n)}`, kind: "sql" });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const TREE: Hit[] = roots().flatMap(sourceFiles)
  .flatMap((p) => hitsIn(relative(REPO, p), readFileSync(p, "utf8")));
const tally = (hits: readonly Hit[]): string[] => hits.map((h) => `${h.kind} ${h.at}`).sort();

describe("the press stamp has one writer and one reader", () => {
  it("names the stamp in the schema, the belt, the device journal and /health, and nowhere else", () => {
    expect(tally(TREE)).toEqual([
      "declare packages/db/src/schema-mail-sqlite.ts#<module>",
      "declare packages/db/src/schema-mail.ts#<module>",
      "read packages/db/src/request-apply.ts#settleReaderRuleRows",
      // The marker, and the journal tag that names the migration.
      "sql packages/api/src/routes/health-markers.ts#<module>",
      "sql packages/api/src/routes/health-markers.ts#<module>",
      // The migration's file name, and its one statement.
      "sql packages/db-mail/src/sqlite-journal.ts#<module>",
      "sql packages/db-mail/src/sqlite-journal.ts#<module>",
      "sql packages/db/src/schema-mail-sqlite.ts#<module>",
      "sql packages/db/src/schema-mail.ts#<module>",
      "write packages/db/src/request-apply.ts#settleReaderRuleRows",
    ]);
  });

  it("CONTROL: a second writer, a reader on a surface and a raw read are each seen", () => {
    const planted = hitsIn("planted.ts", [
      "async function repair(tx) { await tx.update(rules).set({ retroMoved: 0, settledPressAt: new Date() }); }",
      "async function restore(tx, row) { await tx.insert(rules).values({ ...row, settledPressAt: row.at }); }",
      "function toDto(r) { return { id: r.id, at: r.settledPressAt }; }",
      "function fromRow({ settledPressAt }) { return settledPressAt; }",
      "const owed = (t) => t.execute(sql`select id from rules where settled_press_at is not null`);",
      "export const table = pgTable(\"rules\", { settledPressAt: timestamp(\"settled_press_at\") });",
    ].join("\n"));
    expect(tally(planted)).toEqual([
      "declare planted.ts#<module>",
      "read planted.ts#fromRow",
      "read planted.ts#fromRow",
      "read planted.ts#toDto",
      "sql planted.ts#<module>",
      "sql planted.ts#owed",
      "write planted.ts#repair",
      "write planted.ts#restore",
    ]);
  });

  it("CONTROL: the walk reaches every product root it names", () => {
    const scanned = new Set(roots().map((r) => relative(REPO, r)));
    for (const r of ["packages/db/src", "packages/services/src", "packages/api/src", "packages/core/src",
      "apps/worker/src", "apps/sidecar/src", "apps/webapp/app", "packages/client-engine/src"]) {
      expect(scanned.has(r), `${r} is not scanned`).toBe(true);
    }
  });
});
