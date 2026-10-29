import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { rigAppendDate, rigAppendDates } from "./support/rig-append-date.js";

/**
 * NO WALL-CLOCK APPEND DATE OUTSIDE THE HELPER. The rig's GreenMail files a 12:xx UTC APPEND date
 * at 00:xx, so a letter dated `new Date(Date.now() - H)` read back twelve hours early from 13:00 to
 * 14:00 UTC and reordered standalone-open-read.e2e.test.ts every afternoon. Parsed, not grepped:
 * the INTERNALDATE argument of every `.append(path, raw, flags, date)` under a test directory is
 * followed through the file's own declarations; one that reads the wall clock must pass through
 * `rigAppendDates`. A parameter or import is not followed: its file must then call the helper if it
 * reads the clock at all.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = new Set(["rigAppendDates", "rigAppendDate"]);
const H = 3_600_000;

const isClockRead = (n: ts.Node): boolean =>
  (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && (n.arguments ?? []).length === 0)
  || (ts.isCallExpression(n) && n.arguments.length === 0 && ["Date.now", "performance.now"].includes(n.expression.getText()));

/** Declarations by name, file-wide (scope-blind, so it over-follows rather than under-follows). */
function declarations(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: ts.Node | undefined, decl: ts.Node) => {
    if (name && ts.isIdentifier(name)) out.set(name.text, [...(out.get(name.text) ?? []), decl]);
  };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)
      || ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) add(n.name, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Trace = { clock: boolean; helper: boolean; opaque: boolean };

function trace(expr: ts.Node, decls: Map<string, ts.Node[]>): Trace {
  const t: Trace = { clock: false, helper: false, opaque: false };
  const seen = new Set<ts.Node>();
  const follow = (d: ts.Node): void => {
    if (seen.has(d)) return;
    seen.add(d);
    if (ts.isParameter(d) || ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) { t.opaque = true; return; }
    if (ts.isFunctionDeclaration(d)) { if (d.body) visit(d.body); return; }
    let v: ts.Node = d;
    while (ts.isBindingElement(v)) v = v.parent.parent;
    if (ts.isParameter(v)) { t.opaque = true; return; }
    if (ts.isVariableDeclaration(v)) {
      if (v.initializer) visit(v.initializer);
      else if (ts.isForOfStatement(v.parent.parent) || ts.isForInStatement(v.parent.parent)) visit(v.parent.parent.expression);
      else t.opaque = true;
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HELPERS.has(n.expression.text)) { t.helper = true; return; }
    if (isClockRead(n)) t.clock = true;
    if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; }
    if (ts.isIdentifier(n)) for (const d of decls.get(n.text) ?? []) follow(d);
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return t;
}

/** `file:line` of every APPEND whose date reads the wall clock without the helper. */
export function wallClockAppends(name: string, text: string): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const decls = declarations(sf);
  const calls: ts.CallExpression[] = [];
  let readsClock = false;
  let callsHelper = false;
  const visit = (n: ts.Node) => {
    if (isClockRead(n)) readsClock = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HELPERS.has(n.expression.text)) callsHelper = true;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "append"
      && n.arguments.length >= 4) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls.filter((c) => {
    const t = trace(c.arguments[3]!, decls);
    return !t.helper && (t.clock || (t.opaque && readsClock && !callsHelper));
  }).map((c) => `${name}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}`);
}

describe("rigAppendDates keeps every APPEND date out of GreenMail's 12:xx hour", () => {
  const at = (iso: string) => Date.parse(iso);
  it("leaves dates outside the noon hour as asked, floored to the second", () => {
    expect(rigAppendDates([H, 2 * H], at("2026-10-29T16:30:00.750Z")).map((d) => d.toISOString()))
      .toEqual(["2026-10-29T15:30:00.000Z", "2026-10-29T14:30:00.000Z"]);
  });
  it("moves a set with a noon date back together, keeping order and spacing", () => {
    const got = rigAppendDates([H, 2 * H, 3 * H, 3 * 24 * H], at("2026-10-29T13:30:00Z"));
    expect(got.map((d) => d.toISOString())).toEqual([
      "2026-10-29T10:59:59.000Z", "2026-10-29T09:59:59.000Z", "2026-10-29T08:59:59.000Z", "2026-10-26T11:59:59.000Z",
    ]);
  });
  it("keeps shifting while the move carries another date into the noon hour", () => {
    const got = rigAppendDates([0, 40 * 60_000], at("2026-10-29T13:10:00Z"));
    expect(got.map((d) => d.getUTCHours())).not.toContain(12);
    expect(got[0]!.getTime() - got[1]!.getTime()).toBe(40 * 60_000);
  });
  it("one date at noon is filed a second before it", () => {
    expect(rigAppendDate(0, at("2026-10-29T12:00:00Z")).toISOString()).toBe("2026-10-29T11:59:59.000Z");
  });
  it("refuses offsets that cover every hour of the day", () => {
    expect(() => rigAppendDates(Array.from({ length: 24 }, (_, i) => i * H), at("2026-10-29T13:30:00Z"))).toThrow(/12:xx/);
  });
});

describe("no test APPENDs a wall-clock date outside rigAppendDates", () => {
  it("the scan catches the shapes it is for", () => {
    const flagged = (src: string) => wallClockAppends("x.test.ts", src);
    expect(flagged(`await c.append("INBOX", raw, [], new Date(Date.now() - 3_600_000));`)).toEqual(["x.test.ts:1"]);
    expect(flagged(`const base = Date.now();\nconst when = new Date(base - 60);\nawait c.append("INBOX", raw, [], when);`)).toEqual(["x.test.ts:3"]);
    expect(flagged(`const t = Date.now();\nasync function put(at: Date) { await c.append("INBOX", raw, [], at); }`)).toEqual(["x.test.ts:2"]);
    expect(flagged(`const [when] = rigAppendDates([60]);\nawait c.append("INBOX", raw, [], when);`)).toEqual([]);
    expect(flagged(`await c.append("INBOX", raw, [], new Date(Date.UTC(2026, 0, 1)));`)).toEqual([]);
    expect(flagged(`await c.append("INBOX", raw, ["\\\\Seen"]);`)).toEqual([]);
  });

  it("every rig test takes its now-relative APPEND dates from the helper", () => {
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"], { cwd: ROOT, encoding: "utf8" });
    const files = listed.split("\n").filter((f) => /(^|\/)test\//.test(f) && !f.includes("node_modules/") && !f.endsWith(".d.ts"));
    const offenders = files.flatMap((f) => {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      return text.includes(".append(") ? wallClockAppends(f, text) : [];
    });
    expect(files.length, "the scan found no test files").toBeGreaterThan(1000);
    expect(offenders, "take these APPEND dates from test/support/rig-append-date.ts").toEqual([]);
  });
});
