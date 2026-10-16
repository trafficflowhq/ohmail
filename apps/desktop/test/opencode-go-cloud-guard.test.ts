import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * OPENCODE GO IS A DESKTOP PROVIDER; NOTHING THE CLOUD RUNS NAMES IT.
 *
 * The served host client is checked from its bytes (scan:host, marker "opencode"). This is the
 * source half for the Cloud: no file of the server, worker, API, shared packages or the web app's
 * code names OpenCode, and no web source reads the Go copy's namespaces. The copy itself sits in
 * the shared catalogue as data, beside the desktop's Ollama and OpenAI lines. The one exception is
 * the transports' own directory in core, which is not a tree the Cloud web client shares: the
 * transport may live there and nowhere else — never in `client-engine` or another shared package.
 *
 * @reads: apps/server apps/worker apps/api-vercel packages apps/webapp/app apps/webapp/i18n
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLOUD = ["apps/server", "apps/worker", "apps/api-vercel", "packages", "apps/webapp/app", "apps/webapp/i18n"];
const SKIP = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
const TRANSPORTS = "packages/core/src/ai/transports/";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|js|mjs|cjs|json|css)$/.test(name)) out.push(path);
  }
  return out;
}

const files = CLOUD.flatMap((d) => sources(join(ROOT, d)));
const rel = (p: string) => relative(ROOT, p);

describe("OpenCode Go stays out of the Cloud", () => {
  it("scans the Cloud trees at all", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => rel(f) === "apps/webapp/app/shell/AppShell.tsx")).toBe(true);
  });

  it("no Cloud source names OpenCode, outside the transports' own directory", () => {
    const naming = files.filter((f) => /opencode/i.test(readFileSync(f, "utf8"))).map(rel);
    expect(naming.filter((f) => !f.startsWith(TRANSPORTS))).toEqual([]);
    // The exception is a real one: the Go transport lives there, so the filter above removed something.
    expect(naming.some((f) => f.startsWith(TRANSPORTS))).toBe(true);
  });

  it("no web source reads the namespaces the Go copy lives in", () => {
    const web = files.filter((f) => rel(f).startsWith("apps/webapp/"));
    const reads = web.filter((f) => /["'](aiProvider|desktopScreener)["']/.test(readFileSync(f, "utf8")));
    expect(reads.map(rel)).toEqual([]);
  });
});
