import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { publishedSourceRoots } from "./support/published-roots.js";
import { withoutComments } from "../scripts/lib/source-scan.mjs";
import { readSource } from "../apps/worker/test/_start-function.js";

/**
 * THE COST TABLES, THEIR WRITER AND THEIR READERS ARE THE PLANE'S. The open side sends usage
 * lines and prices nothing; a table name or the plane writer's call in published code is the
 * managed service's cost machinery in a public root. Code only: the cloud journal's retired
 * migrations created and dropped the old table, which is history, and comments may name it.
 */
const NEEDLE = /\bai_usage_daily\b|\bai_usage_account_daily\b|\brecordUsage\(tx\b/g;
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function hitsIn(src: string): number {
  return [...withoutComments(src).matchAll(NEEDLE)].length;
}

describe("the plane's AI cost machinery stays out of every published root", () => {
  const roots = publishedSourceRoots(process.cwd());
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter((f) => f !== "" && CODE.test(f) && roots.some((r) => f.startsWith(`${r}/`)));

  it("reads the published code, not nothing", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("packages/db/src/entitlements-client.ts");
    expect(files).toContain("apps/worker/src/index.ts");
  });

  it("names neither table nor the plane writer outside a comment", () => {
    const found = files.filter((f) => hitsIn(readSource(f)) > 0);
    expect(found).toEqual([]);
  });

  it("the plane writer's text, planted, is caught; the same words in a comment are not", () => {
    const planted = "await recordUsage(tx, lines);\nawait tx.execute(sql`insert into plane.ai_usage_account_daily`);\n";
    expect(hitsIn(planted)).toBe(2);
    expect(hitsIn("// recordUsage(tx, lines) writes plane.ai_usage_daily\n/* ai_usage_account_daily */\n")).toBe(0);
  });
});
