import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * THE MODEL PICKER AND THE ENGINE ASK ONE MATCHER. The behaviour half is
 * `apps/desktop/test/ai-model-picker-matches-the-engine.test.tsx`; this half reads source, and it
 * lives here because that file is published and `scripts/lib/source-scan.mjs` is not — an import
 * the mirror could not resolve (`publish-import-closure-tree.test.ts`).
 */
const ROOT = join(import.meta.dirname, "..");
const LEAF = "@trafficflow/core/model-name";
const FORM = "apps/desktop/src/AiProviderForm.tsx";
const PROBE = "packages/core/src/ai/transports/ai-ollama.ts";
/** The probe lives in core, so it names the leaf by its relative path rather than the subpath. */
const LEAF_FROM_CORE = 'from "../../model-name.js"';

/** Source, comments blanked — this file's own prose names the predicate it refuses. */
const src = (rel: string): string => withoutComments(readFileSync(join(ROOT, rel), "utf8"));

/** Every `.ts`/`.tsx` under `dir`, recursively — `node_modules` and `dist` are not source. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("there is one definition of the match, and both surfaces import it", () => {
  it("the form and the engine's probe both import the leaf", () => {
    expect(src(FORM)).toContain(LEAF);
    expect(src(PROBE)).toContain(LEAF_FROM_CORE);
  });

  it("neither consumer decides presence itself", () => {
    /* The defect's own spelling and its neighbours. A second definition written any of these
       ways is a second answer to the question the leaf exists to answer once. */
    const HAND_ROLLED = /models\s*\.\s*(?:includes|some|find|indexOf)\s*\(/;
    for (const rel of [FORM, PROBE]) {
      expect(HAND_ROLLED.test(src(rel)), `${rel} decides model presence on its own`).toBe(false);
    }
  });

  it("the family-and-tag grammar is spelled in exactly one file", () => {
    const hits: string[] = [];
    for (const root of ["apps/desktop/src", "apps/sidecar/src", "packages/core/src"]) {
      for (const f of walk(join(ROOT, root))) {
        if (/\.split\(":",\s*2\)/.test(withoutComments(readFileSync(f, "utf8")))) hits.push(f);
      }
    }
    expect(hits.map((f) => f.slice(f.lastIndexOf("/") + 1))).toEqual(["model-name.ts"]);
  });
});
