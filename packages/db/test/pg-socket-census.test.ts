import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments, withoutCommentsAndLiterals, bracketSpan, lineOf } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY POSTGRES.JS POOL IN SHIPPED CODE DIALS THROUGH `pg-socket.ts`, OR SAYS WHY NOT.
 *
 * postgres@3.4.9 keeps a dead connection's unsent bytes and a spent flush timer, so the next handshake
 * never leaves and the connection dies at connect_timeout until the bytes pass 1024 (pg-socket.ts). A pool
 * built without `withPgSocket` meets that after any cut with a write buffered: the worker's write-race test
 * did (2 of 60 runs, all five connections wedged ~5 min). Every `postgres(` call under apps/<app>/src and
 * packages/<pkg>/src is found by its import binding and must pass `withPgSocket(...)`; the rest are
 * single-connection sessions, counted below with why. A new raw call, or a pool without the socket, reads red.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The raw sites: single-connection sessions (`max: 1`) only, each one-shot or ended by its first close:
 * the leader lock (a close resolves `lost` and the worker exits; plain statements, never begin/reserve),
 * the migration session (a close marks it lost), the hand-run CLI and DDL scripts, and the test helpers.
 * The count is pinned so a new raw session reads red too, and says where.
 */
const RAW_SINGLE_SESSIONS = 9;

const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const MODULE = `["']postgres["']`;
/** `import postgres from "postgres"`, with or without named imports beside it; never `import type`. */
const DEFAULT_IMPORT = new RegExp(`\\bimport\\s+(?!type\\b)([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*${MODULE}`, "g");
/** Any other way to reach the module's value: a namespace or renamed default import, import(), require(). */
const OTHER_FORM = new RegExp(`\\bimport\\s*\\*\\s*as\\s+\\w+\\s*from\\s*${MODULE}|\\bimport\\s*\\{[^}]*\\bdefault\\b[^}]*\\}\\s*from\\s*${MODULE}|\\bimport\\s*\\(\\s*${MODULE}|\\brequire\\s*\\(\\s*${MODULE}`);

interface Call { line: number; socketed: boolean; single: boolean }

/** Every call of the module's default export in one file, and whether its options pass through `withPgSocket`. */
function postgresCalls(raw: string): { calls: Call[]; otherForm: boolean } {
  const code = withoutComments(raw);
  const blank = withoutCommentsAndLiterals(raw);
  const names = [...code.matchAll(DEFAULT_IMPORT)].map((m) => m[1]!);
  const calls: Call[] = [];
  for (const name of names) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*(?:<[^>()]*>)?\\s*\\(`, "g");
    for (const m of blank.matchAll(call)) {
      const open = m.index! + m[0].length - 1;
      const { start, end } = bracketSpan(blank, open);
      const args = blank.slice(start, end);
      calls.push({ line: lineOf(blank, m.index!), socketed: /\bwithPgSocket\s*\(/.test(args), single: /\bmax\s*:\s*1\b/.test(args) });
    }
  }
  return { calls, otherForm: OTHER_FORM.test(code) };
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE.test(e) && !e.endsWith(".d.ts")) out.push(relative(REPO, p));
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const d of readdirSync(join(REPO, top))) {
      const src = join(REPO, top, d, "src");
      if (existsSync(src)) walk(src);
    }
  }
  return out.sort();
}

describe("the census reads a postgres.js call the way it is written", () => {
  it("finds a raw call, a socketed one, a renamed binding and the module reached another way", () => {
    expect(postgresCalls(`import postgres from "postgres";\nconst a = postgres(url, { max: 5 });`).calls)
      .toEqual([{ line: 2, socketed: false, single: false }]);
    expect(postgresCalls(`import pg, { type Sql } from 'postgres';\nconst a = pg<{}>(url, withPgSocket({ max: 5 }));`).calls)
      .toEqual([{ line: 2, socketed: true, single: false }]);
    expect(postgresCalls(`import type postgres from "postgres";\ntype S = ReturnType<typeof postgres>;`).calls).toEqual([]);
    expect(postgresCalls(`import postgres from "postgres";\n// postgres(url)\nconst s = "postgres(url)"; x.postgres(url);`).calls).toEqual([]);
    expect(postgresCalls(`const pg = await import("postgres");`).otherForm).toBe(true);
    expect(postgresCalls(`import * as pg from "postgres";`).otherForm).toBe(true);
  });
});

describe("every postgres.js pool in apps/*/src and packages/*/src dials through withPgSocket", () => {
  const census = sourceFiles().map((file) => ({ file, ...postgresCalls(readFileSync(join(REPO, file), "utf8")) }))
    .filter((f) => f.calls.length > 0 || f.otherForm);

  it("finds the socketed pools it exists to hold (an empty census would pass everything below)", () => {
    const socketed = census.flatMap((f) => f.calls.filter((c) => c.socketed).map((c) => `${f.file}:${c.line}`));
    expect(socketed.length, socketed.join("\n")).toBeGreaterThanOrEqual(4);
    expect(socketed.some((s) => s.startsWith("packages/db/src/client.ts:")), "makeOwnedDb's pool").toBe(true);
  });

  it("reaches the module only through a default import", () => {
    expect(census.filter((f) => f.otherForm).map((f) => f.file)).toEqual([]);
  });

  it("has no raw pool, and exactly the raw single-connection sessions it counts", () => {
    const raw = census.flatMap((f) => f.calls.filter((c) => !c.socketed).map((c) => ({ at: `${f.file}:${c.line}`, single: c.single })));
    expect(raw.filter((r) => !r.single).map((r) => r.at), "a postgres.js pool without withPgSocket").toEqual([]);
    expect(raw.length, `raw single-connection sessions: ${raw.map((r) => r.at).join(", ")}`).toBe(RAW_SINGLE_SESSIONS);
  });

});
