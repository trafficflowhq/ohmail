/**
 * NOTHING THAT SERVES MAIL OR HOLDS A LEASE IMPORTS THE DIAGNOSTIC FILE'S BUILDER. The file is a
 * thing a person writes and sends by hand; the day a server or the organizer can build one, it can
 * send one. Scanned: `packages/services/src`, `apps/worker/src`, the engine (`apps/sidecar/src`,
 * whose lease handling is spread through engine, roster, identity and the passes) and every core
 * module outside `diagnostics/` itself, the barrel and the lease adapter included. A planted import
 * in each spelling is the positive control; a comment naming the leaf is the negative one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIAGNOSTICS_DIR = join(ROOT, "packages/core/src/diagnostics");

/** Every root read, and the fewest files each must yield — a root that moved reads as zero. */
const ROOTS: [rel: string, atLeast: number][] = [
  ["packages/services/src", 50],
  ["apps/worker/src", 20],
  // The worker's passes that moved to the organizer's package (ruling:organizer-cut): a root of its
  // own, since the worker's root no longer reads them.
  ["packages/organizer/src", 40],
  ["apps/sidecar/src", 50],
  ["packages/core/src", 50],
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || p === DIAGNOSTICS_DIR) continue;
      out.push(...sources(p));
    } else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g;

/** THE DECIDING RULE: does this specifier, written in `file`, reach the diagnostics leaf? */
function reachesDiagnostics(file: string, specifier: string): boolean {
  if (specifier === "@trafficflow/core/diagnostics" || specifier.startsWith("@trafficflow/core/diagnostics/")) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(file), specifier);
  return target === DIAGNOSTICS_DIR || target.startsWith(`${DIAGNOSTICS_DIR}/`) || target.startsWith(`${DIAGNOSTICS_DIR}.`);
}

function offenders(file: string, text: string): string[] {
  const code = withoutComments(text);
  return [...code.matchAll(SPECIFIER_RE)].map((m) => m[1]!).filter((s) => reachesDiagnostics(file, s));
}

describe("no server graph and no lease code imports the diagnostic builder", () => {
  it.each(ROOTS)("%s imports nothing of it", (rel, atLeast) => {
    const files = sources(join(ROOT, rel));
    expect(files.length, `${rel} yielded ${files.length} files — the root moved or the walk broke`).toBeGreaterThanOrEqual(atLeast);
    const found = files.flatMap((f) => offenders(f, readFileSync(f, "utf8")).map((s) => `${relative(ROOT, f)}: ${s}`));
    expect(found).toEqual([]);
  });

  it("the lease adapter and the core barrel are among the files read", () => {
    const core = sources(join(ROOT, "packages/core/src")).map((f) => relative(ROOT, f));
    expect(core).toContain("packages/core/src/adapters/organizer-lease.ts");
    expect(core).toContain("packages/core/src/index.ts");
    expect(core.filter((f) => f.startsWith("packages/core/src/diagnostics/"))).toEqual([]);
  });

  it("POSITIVE CONTROL — a planted import is found in every spelling", () => {
    const lease = join(ROOT, "packages/core/src/adapters/organizer-lease.ts");
    const worker = join(ROOT, "apps/worker/src/main.ts");
    const planted = [
      [worker, 'import { buildDiagnosticBundle } from "@trafficflow/core/diagnostics";'],
      [worker, 'const d = await import("@trafficflow/core/diagnostics");'],
      [lease, 'export { sha256Hex } from "../diagnostics/sha256.js";'],
      [lease, 'import "../diagnostics/index.js";'],
      [join(ROOT, "packages/core/src/index.ts"), 'export * from "./diagnostics/index.js";'],
      [join(ROOT, "apps/sidecar/src/engine.ts"), 'const x = require' + '("../../../packages/core/src/diagnostics");'],
    ] as const;
    for (const [file, text] of planted) expect(offenders(file, text), text).toHaveLength(1);
  });

  it("NEGATIVE CONTROL — a comment naming the leaf, and a lookalike path, are not imports", () => {
    const lease = join(ROOT, "packages/core/src/adapters/organizer-lease.ts");
    expect(offenders(lease, '// see "@trafficflow/core/diagnostics"\nimport { x } from "../diagnostics-other.js";')).toEqual([]);
    expect(offenders(lease, 'import { y } from "@trafficflow/core/mail";')).toEqual([]);
  });
});
