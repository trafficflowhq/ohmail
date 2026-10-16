import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SHARDS, checkMap, desktopFiles, readMap, shardFiles, testFiles, verifyReport, type ShardMap } from "./support/ci-shards.mjs";

/**
 * THE DESKTOP JOB'S FILES. apps/desktop installs from its own lock, and its vite config imports
 * @vitejs/plugin-react, which only that tree carries: a desktop test importing the config runs in the
 * desktop job on that install, and in no shard (installed beside the root for a whole shard, the desktop
 * tree puts a second React into every shell test). The class is read from the import, so a new file
 * that imports the config moves on its own.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the desktop job's files in this tree", () => {
  const files = desktopFiles(ROOT);

  it("are the desktop tests that import the desktop's vite config, and the map names none of them", () => {
    expect(files).toEqual([
      "apps/desktop/test/desktop-messages.test.ts",
      "apps/desktop/test/desktop-shell.test.ts",
      "apps/desktop/test/host-client-arm.test.ts",
      "apps/desktop/test/host-client-no-engine-door.test.ts",
    ]);
    expect(readMap(ROOT).shards.flat().filter((f) => files.includes(f))).toEqual([]);
  });

  it("dial no database: the desktop job starts none", () => {
    /* The three markers spelled in pieces, so box-files.mjs does not read this file as one that dials. */
    const dials = new RegExp(["realPg" + "Available", "DATABASE" + "_URL", "lane" + "-db"].join("|"));
    for (const f of files) {
      expect(f).not.toMatch(/\.pg\.test\./);
      expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(dials);
    }
  });
});

describe("the desktop class, on a planted tree", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ohmail-ci-shards-desktop-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const plant = (rel: string, text = "export {};\n") => {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    writeFileSync(join(scratch, rel), text);
  };
  for (let i = 0; i < SHARDS; i++) plant(`packages/p/test/f${i}.test.ts`);
  plant("apps/desktop/test/imports-config.test.ts", 'import { X } from "../vite.config.js";\n');
  plant("apps/desktop/test/imports-config-bare.test.ts", "import { X } from '../vite.config';\n");
  plant("apps/desktop/test/builds-with-config.test.ts", 'await build({ configFile: path.join(APP, "vite.config.ts") });\n');
  plant("apps/desktop/test/reads-config-as-text.test.ts", 'const t = read("vite.config.ts");\n');
  plant("packages/p/test/imports-another-config.test.ts", 'import { X } from "../vite.config.js";\n');
  const map: ShardMap = { measuredAt: "0".repeat(40), shards: Array.from({ length: SHARDS }, (_, i) => [`packages/p/test/f${i}.test.ts`]), pins: { dovecot: [] } };
  const desktop = ["apps/desktop/test/builds-with-config.test.ts", "apps/desktop/test/imports-config-bare.test.ts", "apps/desktop/test/imports-config.test.ts"];

  it("takes a desktop test by its import of the config or its build with it, never by a mention, and nothing outside apps/desktop", () => {
    expect(desktopFiles(scratch)).toEqual(desktop);
    expect(testFiles(scratch)).toEqual(expect.arrayContaining([...desktop, "apps/desktop/test/reads-config-as-text.test.ts"]));
  });

  it("runs them in no shard, even mapped, and refuses the map that names one", () => {
    const mapped = { ...map, shards: map.shards.map((s, i) => (i === 5 ? [...s, desktop[0]!] : s)) };
    for (let n = 0; n < SHARDS; n++) for (const f of desktop) expect(shardFiles(n, scratch, mapped)).not.toContain(f);
    expect(checkMap(scratch, map)).toEqual([]);
    expect(checkMap(scratch, mapped)).toEqual([`DESKTOP ${desktop[0]} (shard 5) imports the desktop's vite config and runs in the desktop job`]);
  });

  it("reads the desktop job's report back by the same class", () => {
    const row = (f: string) => ({ name: join(scratch, f), startTime: 0, endTime: 1 });
    expect(verifyReport("desktop", { testResults: desktop.map(row) }, scratch, map)).toEqual({ missing: [], extra: [] });
    expect(verifyReport("desktop", { testResults: [row(desktop[0]!), row("packages/p/test/f0.test.ts")] }, scratch, map))
      .toEqual({ missing: desktop.slice(1), extra: ["packages/p/test/f0.test.ts"] });
  });
});
