/**
 * The package is pure, by what is built from it: its bundle holds its own source and nothing else,
 * calls no clock, no network and no process, and reads the platform's zone data in one module only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("cal-core is pure", () => {
  it("bundles from its own source alone, every module of it", async () => {
    // Every module is an entry, not only the ones the index names: a module reached by its own door alone is held to the same.
    const out = await build({
      entryPoints: sourceFiles(),
      bundle: true,
      platform: "neutral",
      format: "esm",
      metafile: true,
      write: false,
      absWorkingDir: PKG,
      outdir: "out",
      outbase: SRC,
      logLevel: "silent",
    });
    const inputs = Object.keys(out.metafile.inputs);
    expect(inputs.filter((p) => !p.startsWith("src/"))).toEqual([]);
    expect(inputs.length).toBe(sourceFiles().length);
    const code = out.outputFiles.map((f) => f.text).join("\n");
    for (const call of ["Date.now(", "new Date()", "resolvedOptions(", "fetch(", "process.", "Math.random(", "setTimeout(", "setInterval("]) {
      expect(code.includes(call), `the bundle calls ${call}`).toBe(false);
    }
    expect(code).not.toMatch(/from\s*["']node:|require\(/);
  });

  it("reads the platform's zone data in time/zones only", async () => {
    const files = sourceFiles();
    const out = await build({ entryPoints: files, bundle: false, format: "esm", write: false, absWorkingDir: PKG, outdir: "out", outbase: SRC, logLevel: "silent" });
    const withIntl = out.outputFiles.filter((f) => /\bIntl\./.test(f.text)).map((f) => relative(join(PKG, "out"), f.path).replace(/\\/g, "/"));
    expect(withIntl).toEqual(["time/zones.js"]);
  });

  it("has a door for every module, and a module behind every door", () => {
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      exports: Record<string, Record<string, string>>;
    };
    expect(manifest.dependencies).toEqual({});
    const doors = Object.entries(manifest.exports).map(([door, to]) => ({ door, source: to["ohmail-source"]! }));
    for (const { door, source } of doors) {
      expect(existsSync(join(PKG, source)), `${door} names ${source}`).toBe(true);
    }
    const named = new Set(doors.map((d) => d.source));
    const modules = sourceFiles().map((f) => `./${relative(PKG, f).replace(/\\/g, "/")}`);
    expect(modules.filter((m) => !named.has(m))).toEqual([]);
  });

  it("opens by its name and by a module's door, as another package would import it", async () => {
    const whole = await import("@ohmail/cal-core");
    const zones = await import("@ohmail/cal-core/time/zones");
    const reply = await import("@ohmail/cal-core/itip/reply");
    expect(typeof whole.readCalendar).toBe("function");
    expect(zones.intlZones).toBe(whole.intlZones);
    expect(reply.replyFor).toBe(whole.replyFor);
  });
});
