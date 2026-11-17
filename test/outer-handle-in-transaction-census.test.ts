import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A STATEMENT ON THE OUTER HANDLE INSIDE A TRANSACTION HANGS ON THE DESKTOP. PGlite is one
// connection and its `transaction()` holds the mutex its `query()` waits on, so a callback that
// reaches past its own `tx` to `db`/`ctx.db` waits on itself for ever — measured on the local
// store: no answer after 3 s — where Postgres answers from a second connection and every
// server-side test stays green. `apps/sidecar/test/pglite-concurrent-dispatch.test.ts` holds the
// half this census cannot: that another CALLER's statement waits outside an open transaction.
const ROOT = new URL("../", import.meta.url).pathname;

// The roots the desktop's local engine runs on its PGlite handle. `dist`, `node_modules` and
// declaration files are skipped: they are build output or another package's source.
const ENGINE_ROOTS = [
  "packages/services/src", "packages/db/src", "packages/core/src", "packages/api/src",
  "apps/sidecar/src", "apps/worker/src", "packages/organizer/src",
];
const TX_CALLEES = new Set(["transaction", "withAccountTx", "withTx", "withTransaction"]);
const VERBS = new Set(["select", "selectDistinct", "insert", "update", "delete", "execute", "query", "exec", "transaction"]);
const OUTER = /^(ctx\.db|db|this\.db|deps\.db|opts\.db)$/;

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return n === "node_modules" || n === "dist" ? [] : walk(p);
  return /\.tsx?$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
});

/** Every statement on an outer handle inside a transaction callback, and how many callbacks were read. */
function outerHandleStatements(file: string, text: string): { callbacks: number; hits: string[] } {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let callbacks = 0;
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
        : ts.isIdentifier(n.expression) ? n.expression.text : "";
      const cb = n.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      const param = cb?.parameters[0]?.name;
      if (TX_CALLEES.has(callee) && cb && param && ts.isIdentifier(param)) {
        callbacks += 1;
        const inner = (m: ts.Node): void => {
          if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && VERBS.has(m.expression.name.text)) {
            const recv = m.expression.expression.getText(src);
            if (OUTER.test(recv) && recv !== param.text) {
              hits.push(`${file}:${src.getLineAndCharacterOfPosition(m.getStart()).line + 1} ${recv}.${m.expression.name.text}`);
            }
          }
          ts.forEachChild(m, inner);
        };
        ts.forEachChild(cb.body, inner);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return { callbacks, hits };
}

describe("no transaction callback on the local engine's roots reaches past its own handle", () => {
  it("CONTROL: the census reads the shape, and not a callback whose own handle is named db", () => {
    const fixture = [
      "async function f(ctx: any) {",
      "  await ctx.db.transaction(async (tx: any) => { await tx.insert(t); await ctx.db.select().from(t); });",
      "  await withAccountTx(ctx, async (db: any) => { await db.select().from(t); });",
      "}",
    ].join("\n");
    const read = outerHandleStatements("fixture.ts", fixture);
    expect(read.callbacks).toBe(2);
    expect(read.hits).toEqual(["fixture.ts:2 ctx.db.select"]);
  });

  it("finds none across the engine's roots", () => {
    let callbacks = 0;
    const hits: string[] = [];
    for (const root of ENGINE_ROOTS) {
      for (const f of walk(join(ROOT, root))) {
        const read = outerHandleStatements(f.slice(ROOT.length), readFileSync(f, "utf8"));
        callbacks += read.callbacks;
        hits.push(...read.hits);
      }
    }
    expect(callbacks, "the walk read no transaction callbacks — it measured nothing").toBeGreaterThan(100);
    expect(hits, "use the callback's own handle: on PGlite this statement never answers").toEqual([]);
  });
});
