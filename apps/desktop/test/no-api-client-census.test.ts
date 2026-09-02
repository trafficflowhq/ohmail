import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ═══ THE REFUSING API CLIENT MUST MIRROR THE REAL ONE'S EXPORT SURFACE ═════════════════════
 *
 * `vite.config.ts` aliases `apps/webapp/app/api-client.ts` to `apps/desktop/src/no-api-client.ts`
 * in BOTH desktop artifacts, so no released binary carries a Cloud client. Shared `shell/` code
 * imports from that module by name, unconditionally. An export the stub is missing is therefore
 * not a missing feature — it is an unresolved import, and the desktop bundle fails to build on
 * every platform.
 *
 * ── WHY NO TYPECHECK CAN CATCH IT, WHICH IS THE WHOLE REASON THIS FILE EXISTS ───────────────
 *
 * The alias is the BUNDLER's, not the compiler's. `tsc` resolves the real module, finds the
 * export, and is green — while the artifact cannot be produced at all. The stub's own header
 * already carried the rule ("when the real module's surface changes, change this one in the same
 * commit") and named the desktop typecheck as its enforcement, which is precisely the thing that
 * is structurally unable to notice. It was missing `push` until a build failed and said so; a
 * later sweep found `devices` and `pair` waiting to do it again.
 *
 * So the rule gets a check that can actually fail: both files are parsed for their top-level
 * export names and compared. Source text rather than an import, because importing the stub
 * EVALUATES it — every value export is a Proxy that throws on property access — and because the
 * question is about the module's surface, which is a fact about the text.
 */

/* `async function` too. Without it the census read `api`, `createPasskey` and
   `assertPasskey` as stub-only extras — a parse gap that would have masked a real
   one-directional drift in exactly the names the shell calls most. */
const NAMES =
  /^export (?:async function|const|class|function|interface|type)\s+([A-Za-z0-9_]+)/gm;

function exportsOf(rel: string): Set<string> {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return new Set([...src.matchAll(NAMES)].map((m) => m[1]!));
}

describe("the desktop's refusing api-client stub", () => {
  it("exports every name the real client does", () => {
    const real = exportsOf("../../webapp/app/api-client.ts");
    const stub = exportsOf("../src/no-api-client.ts");

    // The census is worthless if either parse found nothing; pin the shape it must have found.
    expect(real.size).toBeGreaterThan(20);
    expect(real.has("consent")).toBe(true);
    expect(real.has("push")).toBe(true);

    const missing = [...real].filter((n) => !stub.has(n)).sort();
    expect(
      missing,
      "no-api-client.ts is missing these exports — the desktop bundle will not build",
    ).toEqual([]);
  });

  /**
   * The stub may hold MORE than the real module (a shape it needs locally), so the census is
   * one-directional by design. This records that as a decision rather than an oversight, and
   * keeps the drift visible if it ever grows large.
   */
  it("is allowed to hold names the real client does not, and currently holds none", () => {
    const real = exportsOf("../../webapp/app/api-client.ts");
    const stub = exportsOf("../src/no-api-client.ts");
    expect([...stub].filter((n) => !real.has(n)).sort()).toEqual([]);
  });
});
