import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * THE VERDICT'S SENTENCE ONLY FOR A MESSAGE STILL IN JUNK — a census over `withheldCopyKey`'s
 * callers. The resolver can only tell a husk in the spam pile from one moved out of it when it is
 * handed the message's folder; a call site passing the marker alone would put "your spam verdict
 * filed this message" back under a message the person has already moved. Parsed for the CALL
 * (never a text match), over the whole app, with the known callers as the positive control. The
 * mailbox's status rides too: a letter emptied for space in a removed mailbox gets no text back.
 */
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function calls(file: string): Array<{ line: number; args: number }> {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; args: number }> = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "withheldCopyKey") {
      out.push({ line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, args: n.arguments.length });
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

describe("withheldCopyKey is always handed the message's folder and its mailbox's status", () => {
  const found = sources(APP).flatMap((f) => calls(f).map((c) => ({ file: path.relative(APP, f), ...c })));

  it("CONTROL: the census sees the reader surfaces it exists for", () => {
    const files = new Set(found.map((c) => c.file));
    for (const f of ["shell/MessagePane.tsx", "shell/MessageCard.tsx", "views/ReadsView.tsx", "views/ReceiptsView.tsx"]) {
      expect(files.has(f), `${f} calls withheldCopyKey`).toBe(true);
    }
  });

  it("every call passes the marker, the folder AND the mailbox's status", () => {
    const short = found.filter((c) => c.args !== 3).map((c) => `${c.file}:${c.line}`);
    expect(short).toEqual([]);
  });
});
