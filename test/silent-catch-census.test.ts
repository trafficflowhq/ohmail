import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutCommentsAndLiterals, lineOf } from "../scripts/lib/source-scan.mjs";
import { presentRoots } from "./support/public-root.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY SILENT `catch` SAYS WHY IT IS ALLOWED TO BE SILENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A `catch` arm that neither rethrows, logs, nor returns is a swallowed fault unless somebody
 * MEANT it — and the review of 2026-09-18 found 37 such arms with
 * nothing saying so. Sampled, every one was a deliberate capture-into-verdict shape (the failure
 * becomes the value the next line reads, or a rendered sentence, or a counted page), but a reader
 * cannot tell those from a dropped error without re-deriving each site. The sweep gave each one
 * a one-line comment naming the invariant, and this census keeps the set closed: a NEW silent
 * catch either says why in its own body, or this file names it.
 *
 * The allow-list is the COMMENT ITSELF — file:line-independent, so the census does not shift
 * under insertions, and removing the explanation is what reddens it (the mutation this shipped
 * with). The verb list mirrors the review's classifier: a body that throws, logs, records,
 * returns or hands the error to a callback is not silent.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOTS = presentRoots([
  "packages/api/src", "packages/services/src", "packages/db/src", "packages/db-mail/src",
  "packages/core/src", "apps/worker/src", "apps/sidecar/src", "apps/admin/app", "apps/admin/lib",
], REPO);

/**
 * A body containing any of these is not a swallow. The words are the review classifier's, and
 * they are deliberately generous: this census exists to catch the arm that does NOTHING with the
 * failure and says nothing, not to relitigate every handler's vocabulary.
 */
const NOT_SILENT =
  /throw|log|Log|console|report|record|warn|error|errorResponse|reject|fault|notice|retry|fallback|return/;

interface SilentCatch {
  at: string;
  documented: boolean;
}

/** Every silent catch in one source, with whether its RAW body carries a comment. */
function silentCatchesOf(raw: string, name: string): SilentCatch[] {
  const src = withoutCommentsAndLiterals(raw);
  const found: SilentCatch[] = [];
  for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start + 1, i);
    if (NOT_SILENT.test(body)) continue;
    const rawBody = raw.slice(start + 1, i);
    found.push({
      at: `${name}:${lineOf(src, m.index)}`,
      documented: rawBody.includes("/*") || rawBody.includes("//"),
    });
  }
  return found;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e === ".next") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e)) out.push(p);
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out.sort();
}

describe("silent-catch census", () => {
  it("finds a silent catch, honours its comment, and ignores a handler — the mechanism, watched", () => {
    // The classifier itself is the deciding line, so it is driven with subjects that HAVE each
    // property: undocumented-silent (flagged), commented-silent (admitted by its comment), and a
    // rethrowing arm (not silent at all). A regex change that stops matching catches makes the
    // first expectation fail — the census cannot go green by matching nothing.
    const silent = `try { f(); } catch { x = 1; }`;
    const commented = `try { f(); } catch { x = 1; /* captured: x is the verdict */ }`;
    const handled = `try { f(); } catch (e) { throw e; }`;
    expect(silentCatchesOf(silent, "s")).toEqual([{ at: "s:1", documented: false }]);
    expect(silentCatchesOf(commented, "c")).toEqual([{ at: "c:1", documented: true }]);
    expect(silentCatchesOf(handled, "h")).toEqual([]);
  });

  it("every silent catch in the backend roots carries its one-line reason", () => {
    const files = sourceFiles();
    // The walk is real, not an empty set that would pass vacuously.
    expect(files.length).toBeGreaterThan(300);

    const undocumented: string[] = [];
    let silentTotal = 0;
    for (const f of files) {
      const rel = relative(REPO, f);
      for (const c of silentCatchesOf(readFileSync(f, "utf8"), rel)) {
        silentTotal++;
        if (!c.documented) undocumented.push(c.at);
      }
    }
    // The census found the documented population, so a green below is a reading, not a miss.
    expect(silentTotal).toBeGreaterThan(50);
    expect(
      undocumented,
      "a catch arm that neither rethrows, logs, returns nor explains itself — a swallowed fault " +
        "nobody can tell from a deliberate one. Say why in a comment inside the catch body, " +
        "log it, or rethrow.",
    ).toEqual([]);
  });
});
