import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * `message_bodies.headers` IS WRITTEN BY THE INGEST INSERT, AND AFTER IT ONLY IN ONE MODULE.
 * Readers take a stored block as what the letter arrived with. A letter gone from the server has
 * its block cut down, and gets it back whole when it returns (`gone-letter-headers.ts`). So: every
 * `update(messageBodies).set({…})` outside {@link HEADER_DOOR} carries no `headers` key, every
 * `insert(messageBodies)` ends in `onConflictDoNothing` (never `onConflictDoUpdate`), no raw
 * `update message_bodies` names it, and the door holds exactly two writes: the cut
 * (`goneLetterHeaders(…)`) and the restore. (The restore once withdrew the Screener floor mark
 * beside it; the mark's column went with mail 0201.)
 */

/** The one module that may write a stored header map after ingest. */
const HEADER_DOOR = "packages/db/src/gone-letter-headers.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ROOTS = ["packages/core/src", "packages/services/src", "packages/db/src", "apps/worker/src", "apps/server/src"];

interface Finding { at: string; why: string }

function files(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, into);
    else if (extname(name) === ".ts") into.push(p);
  }
  return into;
}

/** The statement a builder chain belongs to: from `at` to the first `;` at bracket depth 0. */
function statementEnd(walk: string, at: number): number {
  let depth = 0;
  for (let j = at; j < walk.length; j++) {
    const c = walk[j];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { if (depth === 0) return j; depth--; }
    else if (c === ";" && depth === 0) return j;
  }
  return walk.length;
}

/** Every finding in one source text. `name` labels it; the reading is pure so a fixture drives it. */
export function headerWrites(name: string, src: string): { findings: Finding[]; writers: number } {
  const code = withoutComments(src) as string;
  const walk = withoutCommentsAndLiterals(src) as string;
  const findings: Finding[] = [];
  let writers = 0;
  for (const m of walk.matchAll(/\.update\(\s*messageBodies\s*\)/g)) {
    writers++;
    const end = statementEnd(walk, m.index! + m[0].length);
    const set = walk.indexOf(".set(", m.index!);
    if (set < 0 || set > end) { findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "an update with no .set( read" }); continue; }
    const body = bracketSpan(walk, set + 4);
    if (!body.closed) { findings.push({ at: `${name}:${lineOf(src, set)}`, why: "a .set( that never closes" }); continue; }
    const keys = code.slice(body.start, body.end);
    if (/(^|[{,\s])headers\s*(:|,|\})/.test(keys)) {
      findings.push({ at: `${name}:${lineOf(src, set)}`, why: "an update sets message_bodies.headers" });
    }
  }
  for (const m of walk.matchAll(/\.insert\(\s*messageBodies\s*\)/g)) {
    writers++;
    const chain = walk.slice(m.index!, statementEnd(walk, m.index! + m[0].length));
    if (/\.onConflictDoUpdate\(/.test(chain) || !/\.onConflictDoNothing\(/.test(chain)) {
      findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "an insert of message_bodies that is not do-nothing on conflict" });
    }
  }
  for (const m of code.matchAll(/update\s+("?message_bodies"?|\$\{messageBodies\})\s+set\b[^;`]*?\bheaders\b/gi)) {
    writers++;
    findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "raw SQL sets message_bodies.headers" });
  }
  return { findings, writers };
}

/**
 * Inside {@link HEADER_DOOR}: the `update(messageBodies).set({ headers })` writes, told apart as
 * the cut (a direct `goneLetterHeaders(…)` call) and the restore.
 */
export function doorFindings(name: string, src: string): { cuts: number; restores: number; writes: number } {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
  let cuts = 0;
  let restores = 0;
  /** The `.set({…})` object of an `update(messageBodies)` chain this call heads, or null. */
  const setOf = (call: ts.CallExpression): ts.ObjectLiteralExpression | null => {
    const arg = call.arguments[0];
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "update") return null;
    if (!arg || !ts.isIdentifier(arg) || arg.text !== "messageBodies") return null;
    let node: ts.Node = call;
    while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
      const next = node.parent.parent;
      if (node.parent.name.text === "set") {
        const obj = next.arguments[0];
        return obj && ts.isObjectLiteralExpression(obj) ? obj : null;
      }
      node = next;
    }
    return null;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const headers = setOf(n)?.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "headers");
      if (headers) {
        const cut = ts.isPropertyAssignment(headers) && ts.isCallExpression(headers.initializer)
          && ts.isIdentifier(headers.initializer.expression) && headers.initializer.expression.text === "goneLetterHeaders";
        if (cut) cuts++; else restores++;
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return { cuts, restores, writes: cuts + restores };
}

describe("message_bodies.headers is written once", () => {
  it("no server-side writer rewrites a stored header map, but the gone-letter door", () => {
    const all: Finding[] = [];
    let writers = 0;
    let doorWrites = 0;
    for (const root of ROOTS) {
      for (const p of files(join(REPO, root))) {
        const rel = relative(REPO, p).split("\\").join("/");
        const text = readFileSync(p, "utf8");
        const r = headerWrites(rel, text);
        writers += r.writers;
        if (rel !== HEADER_DOOR) { all.push(...r.findings); continue; }
        // In the door an update may set the block; every other shape is refused there too.
        all.push(...r.findings.filter((f) => f.why !== "an update sets message_bodies.headers"));
        const door = doorFindings(rel, text);
        expect({ cuts: door.cuts, restores: door.restores }, "the door's two writes").toEqual({ cuts: 1, restores: 1 });
        doorWrites += door.writes;
      }
    }
    // The census read something: the ingest insert and the seven body updates are its subjects.
    expect(writers, "the census found no message_bodies writer at all").toBeGreaterThanOrEqual(8);
    // …and the door holds both writes: the cut and the restore.
    expect(doorWrites, "the gone-letter door was not read").toBe(2);
    console.info(`message_bodies writers read: ${writers}; header rewrites: ${all.length}`);
    expect(all).toEqual([]);
  });

  it("refuses each shape it exists for, beside the ordinary writer it admits", () => {
    const update = `await tx.update(messageBodies).set({ text: "", headers: {} }).where(x);`;
    const shorthand = `await tx.update(messageBodies).set({ headers, text }).where(x);`;
    const upsert = `await db.insert(messageBodies).values({ messageId, headers }).onConflictDoUpdate({ target: t, set: { headers } });`;
    const bare = `await db.insert(messageBodies).values({ messageId, headers });`;
    const raw = "await tx.execute(sql`update message_bodies set headers = ${h} where message_id = ${id}`);";
    for (const src of [update, shorthand, upsert, bare, raw]) {
      expect(headerWrites("fixture.ts", src).findings, src).toHaveLength(1);
    }
    const ordinary = `await tx.update(messageBodies).set({ text: "", html: null }).where(x);
      // a comment naming headers: {} creates nothing
      await db.insert(messageBodies).values({ messageId, headers }).onConflictDoNothing({ target: t });`;
    const r = headerWrites("fixture.ts", ordinary);
    expect(r.writers).toBe(2);
    expect(r.findings).toEqual([]);
  });

  it("refuses a header write outside the door, and tells the door's cut from its restore", () => {
    const cut = "await tx.update(messageBodies).set({ headers: goneLetterHeaders(stored) }).where(x);";
    expect(headerWrites("packages/core/src/elsewhere.ts", cut).findings, "a cut outside the door").toHaveLength(1);
    const door = `
      export async function restoreLetterHeaders(tx, accountId, messageId, headers) {
        await tx.update(messageBodies).set({ headers: { ...headers } }).where(x);
      }
      export async function reduceGoneHeaders(tx, accountId, messageId) {
        await tx.update(messageBodies).set({ headers: goneLetterHeaders(stored) }).where(x);
      }`;
    expect(doorFindings(HEADER_DOOR, door)).toEqual({ cuts: 1, restores: 1, writes: 2 });
    // A second restore, or a write that is no header write, is counted as what it is.
    expect(doorFindings(HEADER_DOOR, `${door}
      async function again(tx) { await tx.update(messageBodies).set({ headers: {} }).where(x); }`).restores).toBe(2);
    expect(doorFindings(HEADER_DOOR, "await tx.update(messageBodies).set({ text: '' }).where(x);").writes).toBe(0);
  });
});
