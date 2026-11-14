import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY SURFACE READS THE HELD-RELEASE OFFER THROUGH ONE DOOR, AND THE DOOR HONOURS THE DISMISSAL.
 *
 * Measured on 0.25.0: "Not now" on the web left the offer on the paired desktop, because the one
 * read was asked once per shell mount and nothing re-asked it. The dismissal now rings the settings
 * doorbell and the engine re-asks at a drain's settle. This census keeps that shape: the adapter's
 * read is reached from `refreshHeldReleases` alone, the drain rings the bell, the bell re-asks
 * that door, and no surface (web, desktop, phone) fetches the route, reads the rows around the
 * selectors, or renders the groups without the server's dismissal.
 */

const ROOT = resolve(__dirname, "../../..");
/** The engine: its door and every file of its folder (the door stands in one, the drain that rings in another). */
const ENGINE = ["packages/client-engine/src/engine.ts", "packages/client-engine/src/engine"];
const engineText = (): string => [join(ROOT, ENGINE[0]!), ...readdirSync(join(ROOT, ENGINE[1]!)).sort().map((n) => join(ROOT, ENGINE[1]!, n))]
  .map((f) => readFileSync(f, "utf8")).join("\n");
const SURFACE_ROOTS = ["apps/webapp/app", "packages/app-logic/src", "apps/desktop/src", "apps/mobile/src"];
/** The adapter wrapper that FORWARDS the capability; forwarding is not a read. */
const FORWARDER = "packages/app-logic/src/session/sync-scheduler.ts";

const call = (name: string) => new RegExp(`\\b${name}\\s*\\(`);

/** The body of the class method `name`, comments blanked, or null when it is not declared. */
export function methodBody(src: string, name: string): string | null {
  const code = withoutComments(src);
  const m = new RegExp(`\\n\\s*(?:private\\s+|protected\\s+|async\\s+)*${name}\\s*\\([^)]*\\)[^{;]*\\{`).exec(code);
  if (!m) return null;
  const s = bracketSpan(code, m.index + m[0].length - 1, "{", "}");
  return s.closed ? code.slice(s.start, s.end) : null;
}

/** What the engine's side of the rule refuses, by name. Empty = admitted. */
export function engineRefusals(engineSrc: string): string[] {
  const out: string[] = [];
  const code = withoutComments(engineSrc);
  const reads = code.match(/\.heldReleases\b/g)?.length ?? 0;
  const door = methodBody(engineSrc, "refreshHeldReleases");
  if (door === null) return ["NO-DOOR: refreshHeldReleases is not declared"];
  if (reads !== 1 || !/\.heldReleases\b/.test(door)) {
    out.push(`SECOND-READ: the adapter's heldReleases is reached ${reads} time(s); only refreshHeldReleases may`);
  }
  const drain = methodBody(engineSrc, "drain");
  if (drain === null || !call("ringHeldReleaseBell").test(drain)) out.push("NO-BELL: the drain never rings the offer's bell");
  const bell = methodBody(engineSrc, "ringHeldReleaseBell");
  if (bell === null || !call("refreshHeldReleases").test(bell) || !call("settingsStamp").test(bell)) {
    out.push("DEAF-BELL: the bell does not re-ask the door on a moved settings stamp");
  }
  return out;
}

/** What one surface file may not do. `path` is repo-relative. */
export function surfaceRefusals(path: string, src: string): string[] {
  const out: string[] = [];
  const code = withoutComments(src);
  if (/\/screener\/held-releases\b/.test(code)) out.push(`${path}: ROUTE — fetches the offer around the engine's door`);
  if (/\bHELD_RELEASE_TYPE\b|["'`]held_release_group["'`]/.test(code)) out.push(`${path}: ROWS — reads the offer's rows around the selectors`);
  if (path !== FORWARDER && /\.heldReleases\b/.test(code)) out.push(`${path}: ADAPTER — calls the adapter's read directly`);
  if (call("heldReleaseGroups").test(code) && !call("heldReleaseDismissedOf").test(code)) {
    out.push(`${path}: UNDISMISSED — renders the groups without the server's dismissal`);
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("the engine keeps one held-release door with a bell", () => {
  it("the real engine is admitted", () => {
    expect(engineRefusals(engineText())).toEqual([]);
  });

  const door = "  async refreshHeldReleases(): Promise<void> {\n    const w = await this.adapter.heldReleases();\n  }\n";
  const bell = "  private ringHeldReleaseBell(): void {\n    if (this.settingsStamp() === s) return;\n    void this.refreshHeldReleases();\n  }\n";
  const drain = (body: string) => `  private async drain(): Promise<void> {\n    ${body}\n  }\n`;

  it("admits the synthetic shape it is written against", () => {
    expect(engineRefusals(`class E {\n${door}${bell}${drain("this.ringHeldReleaseBell();")}}`)).toEqual([]);
  });
  it("refuses a second read of the adapter", () => {
    const second = "  async other(): Promise<void> {\n    await this.adapter.heldReleases();\n  }\n";
    expect(engineRefusals(`class E {\n${door}${second}${bell}${drain("this.ringHeldReleaseBell();")}}`).join()).toMatch(/SECOND-READ/);
  });
  it("refuses a drain that never rings, even when a comment names the call", () => {
    expect(engineRefusals(`class E {\n${door}${bell}${drain("// this.ringHeldReleaseBell();")}}`).join()).toMatch(/NO-BELL/);
  });
  it("refuses a bell that does not read the stamp", () => {
    const deaf = "  private ringHeldReleaseBell(): void {\n    void this.refreshHeldReleases();\n  }\n";
    expect(engineRefusals(`class E {\n${door}${deaf}${drain("this.ringHeldReleaseBell();")}}`).join()).toMatch(/DEAF-BELL/);
  });
});

describe("no surface reads the offer around the door", () => {
  const files = SURFACE_ROOTS.flatMap((r) => walk(join(ROOT, r)));

  it("every surface file is admitted", () => {
    const refusals = files.flatMap((f) => surfaceRefusals(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(refusals).toEqual([]);
  });

  /** Positive controls: the walk reached the renderer and the forwarder, on all three roots. */
  it("the walk reached every root, the renderer and the forwarder", () => {
    for (const r of SURFACE_ROOTS) {
      expect(files.filter((f) => relative(ROOT, f).startsWith(`${r}/`)).length, r).toBeGreaterThan(10);
    }
    const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
    expect(call("heldReleaseDismissedOf").test(withoutComments(src("apps/webapp/app/shell/screener-state.ts")))).toBe(true);
    expect(/\.heldReleases\b/.test(withoutComments(src(FORWARDER)))).toBe(true);
  });

  it("refuses each way around the door by name", () => {
    const at = "apps/mobile/src/ui/Offer.tsx";
    expect(surfaceRefusals(at, `fetch("/api/screener/held-releases")`).join()).toMatch(/ROUTE/);
    expect(surfaceRefusals(at, `engine.read().list(HELD_RELEASE_TYPE)`).join()).toMatch(/ROWS/);
    expect(surfaceRefusals(at, `await adapter.heldReleases()`).join()).toMatch(/ADAPTER/);
    expect(surfaceRefusals(at, `const g = heldReleaseGroups(engine.read());`).join()).toMatch(/UNDISMISSED/);
    expect(surfaceRefusals(at, `const g = heldReleaseGroups(r); const d = heldReleaseDismissedOf(r);`)).toEqual([]);
    expect(surfaceRefusals(at, `// fetch("/api/screener/held-releases")`)).toEqual([]);
  });
});
