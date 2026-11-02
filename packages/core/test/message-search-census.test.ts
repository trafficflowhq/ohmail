import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * THE SEARCH DOCUMENT'S TWO CENSUSES (mail 0125). WRITERS: every function that stores body TEXT
 * (an `insert(messageBodies)`, an `update(…).set({ text })` other than the empty husk, or the
 * `insertMessageBody` port) also writes the message's document — the port by its fourth argument
 * — or a restored body stays unfindable by its own words. A husk keeps its document (the cap
 * governs stored bytes, never findability) unless the letter left the server: the expunge husk
 * deletes it (`drizzle-repo.ts`, a reader below). READERS: the table holds full body text, so the modules
 * that may name it are a CLOSED set; a model prompt, the knowledge base or an embedding path
 * reaching it is red here by file.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC_ROOTS = ["packages/core/src", "packages/services/src", "packages/db/src", "packages/api/src",
  "apps/worker/src", "apps/sidecar/src"];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const WRITE_CALLS = new Set(["upsertMessageSearch", "upsertMessageSearchRows", "reindexMessageSearch", "messageSearchUpsert"]);

/** A body-text write site: the file, the innermost function holding it, and what kind it is. */
interface Site { file: string; fn: string; kind: "insert" | "update" | "port"; line: number; covered: boolean }

function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Does this `update(messageBodies)` chain set `text` to anything but the empty string? */
function setsContentText(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.parent && ts.isCallExpression(node.parent.parent)) {
    const next = node.parent.parent;
    if (node.parent.name.text === "set") {
      const arg = next.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
      for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === "text") {
          return !(ts.isStringLiteral(p.initializer) && p.initializer.text === "");
        }
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === "text") return true;
        if (ts.isSpreadAssignment(p)) return true;
      }
      return false;
    }
    node = next;
  }
  return true;
}

function functionName(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  let p: ts.Node | undefined = fn.parent;
  while (p && !(ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p))) p = p.parent;
  return p && "name" in p && p.name ? (p.name as ts.Node).getText() : "<anonymous>";
}

/** Every body-text write in one source, each with whether its function writes the document. */
export function writeSitesIn(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: Site[] = [];
  const visit = (node: ts.Node, fns: ts.Node[]): void => {
    const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
    const stack = isFn ? [...fns, node] : fns;
    if (ts.isCallExpression(node) && stack.length > 0) {
      const name = calleeName(node.expression);
      const arg0 = node.arguments[0];
      const onBodies = arg0 !== undefined && ts.isIdentifier(arg0) && arg0.text === "messageBodies";
      let kind: Site["kind"] | null = null;
      if (name === "insert" && onBodies) kind = "insert";
      else if (name === "update" && onBodies && setsContentText(node)) kind = "update";
      else if (name === "insertMessageBody" && !ts.isMethodDeclaration(node.parent)) kind = "port";
      // The port carries the document as its fourth argument, written by the body's own statement.
      const carriesDocument = kind === "port" && node.arguments.length >= 4;
      if (kind !== null) {
        // The nearest NAMED function holding the write decides, so a transaction callback's write
        // and its caller's document write are one site, and a factory's inner writers are apart.
        const named = (f: ts.Node): boolean => (ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f))
          ? f.name !== undefined
          : ts.isVariableDeclaration(f.parent) || ts.isPropertyAssignment(f.parent);
        const outer = [...stack].reverse().find(named) ?? stack[0]!;
        let covered = false;
        const find = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && WRITE_CALLS.has(calleeName(n.expression) ?? "")) covered = true;
          n.forEachChild(find);
        };
        find(outer);
        if (carriesDocument) covered = true;
        sites.push({
          file, fn: functionName(outer), kind, covered,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
    }
    node.forEachChild((c) => visit(c, stack));
  };
  visit(sf, []);
  return sites;
}

/**
 * The writes that do not write a document, each with its reason. Keyed `file#function`, so a
 * second write in the same function is not covered by the first's reason.
 */
const EXEMPT: Record<string, string> = {
  "apps/sidecar/src/cloud-mirror.ts#storeBodies":
    "the Cloud-mode mirror copies bodies the hosted store already indexed; the local documents are " +
    "built by the store-only backfill the desktop composition runs",
};

const ALL_SITES = SRC_ROOTS.flatMap((r) => tsFiles(join(ROOT, r)))
  .flatMap((abs) => writeSitesIn(relative(ROOT, abs), readFileSync(abs, "utf8")));

describe("every stored body text has its search document", () => {
  it("finds the writers it exists for — a census that reads nothing is green for nothing", () => {
    const where = new Set(ALL_SITES.map((s) => `${s.file}#${s.fn}`));
    for (const known of [
      "packages/core/src/pipeline.ts#commitChange",
      "packages/core/src/husk-restore.ts#unhuskJunkFiledBody",
      "packages/core/src/adapters/drizzle-repo.ts#restoreWithheldBody",
      "apps/worker/src/sensitive-backfill.ts#repairOne",
      "apps/worker/src/redacted-restore.ts#restoreOne",
    ]) expect(where, known).toContain(known);
  });

  it("refuses a content writer with no document write in its function", () => {
    const naked = ALL_SITES.filter((s) => !s.covered && EXEMPT[`${s.file}#${s.fn}`] === undefined);
    expect(naked.map((s) => `${s.file}:${s.line} ${s.fn} (${s.kind})`)).toEqual([]);
  });

  it("carries no exemption for a writer that no longer exists", () => {
    const where = new Set(ALL_SITES.map((s) => `${s.file}#${s.fn}`));
    for (const key of Object.keys(EXEMPT)) expect(where, key).toContain(key);
  });

  it("the classifier itself: a husk passes, a content write without a document is refused", () => {
    const src = `
      async function husk(tx) { await tx.update(messageBodies).set({ text: "", html: null }); }
      async function restore(tx) { await tx.update(messageBodies).set({ text: fresh, html: h }); }
      async function restored(tx) {
        await tx.transaction(async (t) => { await t.update(messageBodies).set({ text: fresh }); });
        await reindexMessageSearch(tx, a, m);
      }
      async function ingest(repo) { await repo.insertMessageBody(id, body, st); }
      async function ingested(repo) { await repo.insertMessageBody(id, body, st, doc); }`;
    const sites = writeSitesIn("fixture.ts", src);
    expect(sites.map((s) => [s.fn, s.kind, s.covered])).toEqual([
      ["restore", "update", false],
      ["restored", "update", true],
      ["ingest", "port", false],
      ["ingested", "port", true],
    ]);
  });
});

/**
 * The modules that may name the search document, by path. Everything else — a prompt builder, the
 * knowledge base, an embedding or a model door — reaching it is a disclosure of full body text.
 */
const READERS = new Set([
  "packages/db/src/schema-mail.ts",
  "packages/db/src/schema-mail-sqlite.ts",
  "packages/db/src/search-setup.ts",
  "packages/db/src/closed-sets.ts",
  "packages/db/src/dialect/index.ts",
  "packages/db/src/dialect/pg.ts",
  "packages/db/src/dialect/sqlite.ts",
  "packages/core/src/message-search.ts",
  "packages/core/src/adapters/drizzle-repo.ts",
  "packages/services/src/search-service.ts",
  "packages/services/src/account-deletion-service.ts",
  "packages/db/src/mailbox-erasure.ts",
  "packages/api/src/routes/health-markers.ts",
  "apps/sidecar/src/local-mirror.ts",
  // Two more deleters and the store's statistics list: the Cloud mirror's delete walk takes the
  // document before its message, and the desktop store ANALYZEs the table search reads.
  "apps/sidecar/src/cloud-mirror.ts",
  "apps/sidecar/src/db.ts",
]);

/** The AI, knowledge-base and embedding graph, by path shape — none of it may be a reader. */
const MODEL_GRAPH = /(^|\/)(ai|kb|embed\w*|redact\w*|classify\w*|draft-prompt|classify-prompt|ai-\w+|kb-\w+)(\/|\.|-)/;

function namesTheDocument(text: string): boolean {
  // The identifier or the table name in code — a comment naming it is prose.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return /\bmessageSearch\b|\bmessage_search\b/.test(code);
}

describe("the search document is read by a closed set of modules, none of them a model's", () => {
  const files = SRC_ROOTS.flatMap((r) => tsFiles(join(ROOT, r))).map((abs) => relative(ROOT, abs));
  const readers = files.filter((f) => namesTheDocument(readFileSync(join(ROOT, f), "utf8")));

  it("reads the modules it exists for", () => {
    expect(readers.length).toBeGreaterThanOrEqual(8);
    expect(readers).toContain("packages/services/src/search-service.ts");
  });

  it("no module outside the closed set names it", () => {
    expect(readers.filter((f) => !READERS.has(f))).toEqual([]);
  });

  it("no member of the closed set is on the model or knowledge-base graph", () => {
    expect([...READERS].filter((f) => MODEL_GRAPH.test(f))).toEqual([]);
    // The shape reads the graph it is for.
    expect(MODEL_GRAPH.test("packages/services/src/kb-service.ts")).toBe(true);
    expect(MODEL_GRAPH.test("packages/core/src/ai/classify.ts")).toBe(true);
  });
});
