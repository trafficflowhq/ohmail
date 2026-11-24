import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * THE VERDICT'S SENTENCE ONLY FOR A MESSAGE STILL IN JUNK — a census over the withheld resolvers'
 * callers. The resolver can only tell a husk in the spam pile from one moved out of it when it is
 * handed the message's folder; a call site passing the marker alone would put "your spam verdict
 * filed this message" back under a message the person has already moved. Parsed for the CALL
 * (never a text match), over the parts the hosts' entries draw a letter with (the new reader and
 * the packages under it), with the known caller as the positive control. The mailbox's status
 * rides too: a letter emptied for space in a removed mailbox gets no text back. The new reader
 * resolves the sentence with `withheldKeyOf(body, folder)` and reads the mailbox's status beside it
 * (`useMailboxStatus`), where today's views called `withheldCopyKey(marker, folder, status)`: both
 * resolvers are counted, each by its own arity, and a file that resolves the sentence reads the status.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["packages/app/src", "packages/app-logic/src", "packages/letter-body/src"].map((r) => path.join(ROOT, r));
/** Each resolver and the arguments a call must pass: the marker (or the body that carries it), the folder, the status. */
const ARITY: Record<string, number> = { withheldCopyKey: 3, withheldKeyOf: 2 };

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function calls(file: string): Array<{ name: string; line: number; args: number }> {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: Array<{ name: string; line: number; args: number }> = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (name in ARITY || name === "useMailboxStatus") {
        out.push({ name, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, args: n.arguments.length });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

describe("withheldCopyKey is always handed the message's folder and its mailbox's status", () => {
  const found = ROOTS.flatMap(sources).flatMap((f) => calls(f).map((c) => ({ file: path.relative(ROOT, f), ...c })));
  const resolving = found.filter((c) => c.name in ARITY);

  it("CONTROL: the census sees the reader surfaces it exists for", () => {
    const files = new Set(resolving.map((c) => c.file));
    for (const f of ["packages/app/src/reader/Letter.tsx"]) {
      expect(files.has(f), `${f} resolves the withheld sentence`).toBe(true);
    }
  });

  it("every call passes the marker, the folder AND the mailbox's status", () => {
    const short = resolving.filter((c) => c.args !== ARITY[c.name]).map((c) => `${c.file}:${c.line}`);
    expect(short).toEqual([]);
    /* The new resolver takes no status: the file that resolves with it reads the mailbox's status beside it. */
    const withoutStatus = [...new Set(resolving.filter((c) => c.name === "withheldKeyOf").map((c) => c.file))].filter(
      (f) => !found.some((c) => c.file === f && c.name === "useMailboxStatus"),
    );
    expect(withoutStatus).toEqual([]);
  });
});
