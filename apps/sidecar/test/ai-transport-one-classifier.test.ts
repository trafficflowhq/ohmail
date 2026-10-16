import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ THE PROVIDERS SHARE ONE READING OF A NON-2XX ANSWER ═══════════════════════════════════
 *
 * Both model providers turned an HTTP status into a `ProbeFailure` with their own copy of the
 * same four lines, beside a shared transport module that already held `failureOf` and
 * `fetchWithDeadline`. The mapping is what a person is shown when their key does not work — one
 * copy drifting means the same 403 reads "your key was refused" on one provider and "the model
 * answered something we could not read" on the other, and only one of those tells them what to
 * do. The same argument is why the two option bags are one shape.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
// The providers and their seam moved into core together; the census reads there and here, so a
// second copy planted back in the engine's own source is still a second copy.
const DIRS = [join(HERE, "../../../packages/core/src/ai/transports"), join(HERE, "../src")];

const FILES = DIRS.flatMap((dir) => readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, code: withoutCommentsAndLiterals(readFileSync(join(dir, f), "utf8")) })));

const DECL = /\bfunction\s+statusFailure\s*\(/g;
const SHAPE = /\bapiKey\s*:\s*string\s*;\s*classifyModel\s*:\s*string\s*;/g;

describe("the model providers share one transport reading", () => {
  it("the status-to-failure mapping is declared once", () => {
    const holders = FILES.filter((f) => (f.code.match(DECL) ?? []).length > 0).map((f) => f.name);
    expect(holders, `declared in: ${holders.join(", ") || "(nowhere)"}`).toEqual(["ai-transport.ts"]);
  });

  it("the transport option bag is declared once", () => {
    const holders = FILES.filter((f) => (f.code.match(SHAPE) ?? []).length > 0).map((f) => f.name);
    expect(holders, `declared in: ${holders.join(", ") || "(nowhere)"}`).toEqual(["ai-transport.ts"]);
  });

  it("the census can see a planted second copy of each", () => {
    for (const [what, re] of [["statusFailure", DECL], ["the option bag", SHAPE]] as const) {
      const one = FILES.filter((f) => (f.code.match(re) ?? []).length > 0);
      expect(one, `${what} is declared nowhere — the census reads nothing`).toHaveLength(1);
      const planted = [...FILES, { name: "synthetic-copy.ts", code: one[0]!.code }];
      expect(planted.filter((f) => (f.code.match(re) ?? []).length > 0), `${what}`).toHaveLength(2);
    }
  });
});
