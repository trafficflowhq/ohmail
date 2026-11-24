import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/* A private JS scanner, deliberately untyped; `packages/api/test` is not a payload root, so
   importing it here is allowed — the module's own header states that rule. */
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE LOCAL DOOR'S MODULE GRAPH CARRIES NO MANAGED-SERVICE ADMINISTRATION.
 *
 * `src/local.ts` is the entry the standalone engine mounts, and its docblock exists to keep the
 * hosted route table out. It stopped holding: `app.ts` — which `local.ts` re-exports `createApp`
 * from — took a module-level value import of the staff step-up, which imports the staff route
 * module and the cloud schema. The published desktop engine went from 752 bundled inputs to 1204
 * with `staff_users` and `password_hash` in the bytes, and the engine census refused it.
 *
 * That census is the judge, and it needs a full workspace build to speak. This reads the same
 * boundary off the source in milliseconds, so the lane that crosses it finds out before a landing
 * does.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ENTRY = join(SRC, "local.ts");

/** Modules the standalone door may not reach, by path under `packages/api/src`. */
const isAdminModule = (rel: string): boolean =>
  rel.startsWith("routes/admin") || rel === "staff-step-up.ts";

/**
 * Bare specifiers the standalone door may not reach. The cloud schema is the private half itself;
 * the `@trafficflow/services` BARREL is refused where its leaves are not, because a value import
 * from it conveys the hosted admin service — the rule AGENTS.md states as "import from the leaf".
 */
const REFUSED_BARE: ReadonlySet<string> = new Set(["@trafficflow/db/cloud", "@trafficflow/services"]);

interface Graph {
  /** Reached files, relative to `packages/api/src`. */
  files: string[];
  /** Bare specifiers, each with the reaching file. */
  bare: { from: string; specifier: string }[];
}

/**
 * Every RUNTIME specifier in one source: `import`/`export … from "x"` and `import("x")`, with
 * `import type` / `export type` statements dropped because they are erased and reach no bundle.
 * Comments are blanked by the repo's one-pass scanner first — a two-regex strip reads a comment
 * opener quoted inside a line comment as real and deletes to the next terminator.
 */
function specifiersIn(src: string): string[] {
  const text: string = withoutComments(src);
  const out: string[] = [];
  const from = /(^|[\s;}])(import|export)\s+([\s\S]*?)from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(from)) {
    const clause = m[3] ?? "";
    /* `import type { X } from` and `export type { X } from` are erased whole. An inline
       `{ type X }` inside a value clause is not: the statement still creates the edge. */
    if (/^type[\s{]/.test(clause.trimStart())) continue;
    out.push(m[4]!);
  }
  const side = /(^|[\s;}])import\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(side)) out.push(m[2]!);
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(dyn)) out.push(m[1]!);
  return out;
}

/**
 * Walk from `entry`, following relative specifiers only. `inject` adds edges to a named file
 * WITHOUT touching the tree — the positive control's mechanism. A specifier that resolves to no
 * file throws: a walker that silently drops an edge reports a clean graph for a broken one.
 */
function walk(entry: string, inject: Readonly<Record<string, readonly string[]>> = {}): Graph {
  const seen = new Set<string>();
  const bare: { from: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(SRC, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const specs = [...specifiersIn(readFileSync(file, "utf8")), ...(inject[rel] ?? [])];
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        bare.push({ from: rel, specifier: spec });
        continue;
      }
      const guess = resolve(dirname(file), spec);
      const target = guess.endsWith(".js") ? `${guess.slice(0, -3)}.ts` : `${guess}.ts`;
      if (!existsSync(target)) throw new Error(`${rel} imports "${spec}", which resolves to no file`);
      queue.push(target);
    }
  }
  return { files: [...seen].sort(), bare };
}

describe("the standalone door's graph", () => {
  const graph = walk(ENTRY);

  /**
   * A guard for an absence passes when the walker returns nothing, so the size and three known
   * members are asserted first. `app.ts` is the module the refusal came through.
   */
  it("is actually walked — the entry reaches the pipeline it composes", () => {
    expect(graph.files.length).toBeGreaterThan(20);
    for (const f of ["local.ts", "app.ts", "router.ts", "middleware.ts", "routes/local.ts"]) {
      expect(graph.files, `${f} missing — the walk did not reach the door it measures`).toContain(f);
    }
  });

  it("names no admin route module and no staff step-up", () => {
    expect(graph.files.filter(isAdminModule)).toEqual([]);
  });

  it("reaches the cloud schema and the services barrel through nothing", () => {
    const refused = graph.bare
      .filter((b) => REFUSED_BARE.has(b.specifier))
      .map((b) => `${b.from} → ${b.specifier}`);
    expect(refused).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL — the edge that caused the refusal, injected in memory. A guard for an
   * absence goes green when its subject is deleted; this drives the walker over a graph that HAS
   * the property and asserts both readings go red, naming the module and the barrel.
   */
  it("goes red on the edge that caused the refusal, injected into app.ts", () => {
    const red = walk(ENTRY, { "app.ts": ["./staff-step-up.js"] });
    expect(red.files.filter(isAdminModule).sort())
      .toEqual(["routes/admin-staff.ts", "staff-step-up.ts"]);
    expect(red.bare.some((b) => b.specifier === "@trafficflow/services")).toBe(true);
  });

  /** And it reads source, not text: an import written inside a comment is not an edge. */
  it("does not take an import inside a comment for an edge", () => {
    expect(specifiersIn('// import { x } from "./routes/admin-staff.js";\n')).toEqual([]);
    expect(specifiersIn('/* import "@trafficflow/db/cloud"; */\nimport { y } from "./app.js";'))
      .toEqual(["./app.js"]);
  });

  /** A type-only statement is erased, so it is not an edge either — and a value one still is. */
  it("drops an erased type import and keeps the value import beside it", () => {
    expect(specifiersIn('import type { M } from "./middleware.js";')).toEqual([]);
    expect(specifiersIn('import { withCsrf, type M } from "./middleware.js";'))
      .toEqual(["./middleware.js"]);
  });

  /** A specifier resolving to no file is a refusal, never a silently dropped edge. */
  it("refuses rather than dropping an edge it cannot resolve", () => {
    expect(() => walk(ENTRY, { "app.ts": ["./no-such-module.js"] }))
      .toThrow(/resolves to no file/);
  });
});
