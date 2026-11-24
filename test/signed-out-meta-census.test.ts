import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isEnginePart, readAsUnit } from "./support/engine-unit.js";

/**
 * NOTHING BUT WHERE A MAILBOX LIVES IS WRITTEN INTO `mailboxes.signed_out_meta` (mail 0127).
 * Parsed, not grepped: every object-literal property, assignment or shorthand named
 * `signedOutMeta` in `packages/*\/src` and `apps/*\/src` must be `null` or a call of
 * `signedOutMetaOf`, the one allow-list builder; the column's SQL name may appear only where it
 * is declared or probed. SCANNED ROOTS, not touched packages — run it by name.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the column is declared (the schema twins, the inlined device migration) and probed. */
const DECLARED_IN = new Set([
  "packages/db/src/schema-mail.ts",
  "packages/db/src/schema-mail-sqlite.ts",
  "packages/db-mail/src/sqlite-journal.ts",
  "packages/api/src/routes/health-markers.ts",
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(path.join(REPO, group))) {
      const src = path.join(REPO, group, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src: not a scanned root */ }
    }
  }
  return out;
}

interface Reading { admitted: string[]; refused: string[] }

/** The census over one file's text; `rel` decides the declaration exemption. */
function read(rel: string, text: string): Reading {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Reading = { admitted: [], refused: [] };
  const where = (n: ts.Node): string => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const judge = (n: ts.Node, value: ts.Expression | undefined): void => {
    const ok = value !== undefined && (value.kind === ts.SyntaxKind.NullKeyword
      || (ts.isCallExpression(value) && ts.isIdentifier(value.expression)
        && value.expression.text === "signedOutMetaOf"));
    (ok ? out.admitted : out.refused).push(where(n));
  };
  const declared = DECLARED_IN.has(rel);
  const visit = (n: ts.Node): void => {
    if (!declared && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "signedOutMeta") {
      judge(n, n.initializer);
    } else if (!declared && ts.isShorthandPropertyAssignment(n) && n.name.text === "signedOutMeta") {
      judge(n, undefined);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(n.left) && n.left.name.text === "signedOutMeta") {
      judge(n, n.right);
    } else if (!declared && (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n)
      || ts.isTemplateTail(n)) && n.text.includes("signed_out_meta")) {
      out.refused.push(where(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("mailboxes.signed_out_meta takes nothing but the allow-list builder's value", () => {
  it("every write in the tree is null or signedOutMetaOf(...), and the SQL name stays declared", () => {
    const all: Reading = { admitted: [], refused: [] };
    const files = sourceFiles().filter((f) => !isEnginePart(f));
    expect(files.length, "the walk found no source").toBeGreaterThan(500);
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join("/");
      const r = read(rel, readAsUnit(f));
      all.admitted.push(...r.admitted);
      all.refused.push(...r.refused);
    }
    expect(all.refused).toEqual([]);
    /* The sign-out's write and the removal's clear: a census that admits nothing measured nothing. */
    expect(all.admitted.some((a) => a.startsWith("apps/sidecar/src/engine.ts:"))).toBe(true);
    expect(all.admitted.some((a) => a.startsWith("packages/services/src/mailbox-service.ts:"))).toBe(true);
  });

  it("CONTROL — the reader refuses each shape that could carry a secret, and admits the two", () => {
    const f = "apps/x/src/f.ts";
    expect(read(f, "db.update(t).set({ signedOutMeta: signedOutMetaOf(rows) });").admitted).toHaveLength(1);
    expect(read(f, "db.update(t).set({ signedOutMeta: null });").admitted).toHaveLength(1);
    for (const bad of [
      "db.update(t).set({ signedOutMeta: row.meta });",
      "db.update(t).set({ signedOutMeta: { imap: { host, pass } } });",
      "const signedOutMeta = x; db.update(t).set({ signedOutMeta });",
      "row.signedOutMeta = before[0].meta;",
      "await db.execute(sql`update mailboxes set signed_out_meta = ${x}`);",
      "await db.execute(\"update mailboxes set signed_out_meta = '{}'\");",
    ]) {
      expect(read(f, bad).refused, bad).toHaveLength(1);
    }
    /* The declaration exemption is by file: the same property in a schema twin is not a write. */
    expect(read("packages/db/src/schema-mail.ts", 'signedOutMeta: jsonb("signed_out_meta"),').refused).toEqual([]);
  });
});
