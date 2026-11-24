import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_PASSES } from "../src/pass-registry.js";
import { TAIL_SECTION_PLAN } from "../src/cycle-tail-plan.js";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "./_start-function.js";

/**
 * THE CYCLE TAIL NEVER REACHES A MAILBOX CONNECTION, AND ITS TABLE IS THE REGISTRY'S. Every module a
 * `cycle-tail` row names is read with comments and literals blanked and refused if it names the
 * adapter factory, the runtime map, `attach(` or a lease permit: the organizer lease is reachable
 * only through those, so a tail pass that named one could become a second organizer. `index.ts` is
 * read between its TAIL_IMPL markers only. The plan's passes and the registry's rows are one set.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * Where the registry's cycle-tail modules stand: the worker's program in its two folders, and the one module of the
 * shared library a tail row names. Named here so a change of any of them selects this census.
 */
const PROGRAM_ROOTS = ["apps/worker/src/", "packages/organizer/src/"] as const;
const LIBRARY_MODULES = ["packages/core/src/message-search.ts"] as const;
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["adapterFactory", /\badapterFactory\b/],
  ["runtimes", /\bruntimes\b/],
  ["attach(", /\battach\s*\(/],
  ["acquireLeasePermit", /\bacquireLeasePermit\b/],
];

/** The forbidden names a source's CODE carries — comments and string bodies are not code. */
function imapReachIn(source: string): string[] {
  const code = withoutCommentsAndLiterals(source);
  return FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/** The table's block in the worker entry, which also holds the rotation (and so the runtimes). */
function tailImplSlice(entry: string): string {
  const begin = entry.split("// BEGIN TAIL_IMPL");
  const end = entry.split("// END TAIL_IMPL");
  expect(begin.length, "the BEGIN TAIL_IMPL marker must appear exactly once").toBe(2);
  expect(end.length, "the END TAIL_IMPL marker must appear exactly once").toBe(2);
  const slice = begin[1]!.split("// END TAIL_IMPL")[0]!;
  for (const s of TAIL_SECTION_PLAN) {
    expect(slice.includes(`\n      ${s.name}: {`), `the TAIL_IMPL block has no row for ${s.name}`).toBe(true);
  }
  return slice;
}

const tailRows = WORKER_PASSES.filter((p) => p.triggers.includes("cycle-tail"));

describe("the cycle tail census", () => {
  it("reads a fixture module that names each forbidden door as refused, and a clean one as admitted", () => {
    for (const [name] of FORBIDDEN) {
      const call = name === "attach(" ? "attach(rt)" : `${name}.get(id)`;
      expect(imapReachIn(`export async function fixturePass(db) {\n  await ${call};\n}\n`), name).toEqual([name]);
    }
    const clean = "// runtimes and attach( in prose only\nexport const s = \"adapterFactory\";\nexport async function p(db) { return db; }\n";
    expect(imapReachIn(clean), "a comment or a string was read as a door").toEqual([]);
  });

  it("finds no mailbox door in any cycle-tail module", () => {
    expect(tailRows.length, "no cycle-tail rows were read").toBeGreaterThan(10);
    const modules = [...new Set(tailRows.map((r) => r.module))];
    for (const module of modules) {
      expect([...PROGRAM_ROOTS, ...LIBRARY_MODULES].some((at) => module.startsWith(at)), `${module} stands nowhere this census names`).toBe(true);
      const text = readSource(join(REPO, module));
      const scope = module.endsWith("/index.ts") ? tailImplSlice(text) : text;
      expect(imapReachIn(scope), `${module} reaches a mailbox connection from the cycle tail`).toEqual([]);
    }
  });

  it("walks exactly the registry's cycle-tail passes, each section with a unique name", () => {
    const names = TAIL_SECTION_PLAN.map((s) => s.name);
    expect(new Set(names).size, "two sections share a name").toBe(names.length);
    const planned = new Set(TAIL_SECTION_PLAN.flatMap((s) => [...s.passes]));
    const registered = new Set(tailRows.map((r) => r.name));
    expect([...planned].sort(), "the plan and the registry disagree about the tail").toEqual([...registered].sort());
  });
});
