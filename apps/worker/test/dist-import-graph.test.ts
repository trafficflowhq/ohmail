import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE BUILD IS GREEN AND THE PROGRAM CANNOT START.
//
// `tsc` keeps a bare specifier as written, so an import of a `@trafficflow/core` leaf whose
// exports target is a .ts file compiles and typechecks. Node then resolves that .ts at run time,
// strips the types, and fails on the file's OWN `./types.js` — `ERR_MODULE_NOT_FOUND`, at boot,
// in a container, after every gate was green. 0.16.2 shipped exactly that into a worker image.
//
// A missing module is not the only way the graph fails to load. With every workspace leaf on its
// source, Node strips `packages/core/src/adapters/drizzle-repo.ts` and stops at its parameter
// property (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — a load error this file once printed and passed.
//
// So this walks the real graph: it imports the BUILT entry in a subprocess, and the subprocess
// says which way the import settled. The database URL points at a closed port on purpose — a
// connection refusal is the one ACCEPTED failure, named; ANY other error is the finding. Nothing
// here asserts the worker runs; it asserts the worker can be loaded.
const ROOT = new URL("../../../", import.meta.url).pathname;
const ENTRY = `${ROOT}apps/worker/dist/index.js`;

// A port nothing listens on: the boot fails fast rather than hanging on a real server.
const DEAD_DB = "postgres://nobody:nobody@127.0.0.1:1/nothing";

const LOADED = "OHMAIL_GRAPH_LOADED";
const REFUSED = "OHMAIL_GRAPH_REFUSED";

/** What the child prints: the sentinel on a settled import, or the error's code and stack. */
export const probeSource = (entry: string) =>
  `import(${JSON.stringify(entry)}).then(`
  + `() => { process.stdout.write(${JSON.stringify(`${LOADED}\n`)}); process.exit(0); }, `
  + `(e) => { process.stderr.write(${JSON.stringify(`${REFUSED} `)} + String((e && e.code) || "") + "\\n" + String((e && e.stack) || e) + "\\n"); process.exit(3); })`;

/** The verdict over one probe run: "" when the graph loaded or met only the dead database. */
export function loadVerdict(r: { status: number | null; signal: string | null; stdout: string; stderr: string }): string {
  if (r.status === 0 && r.stdout.includes(LOADED)) return "";
  // The one accepted failure: the dead database, by name. Nothing else that reaches the catch is.
  if (r.stderr.includes(`${REFUSED} ECONNREFUSED`)) return "";
  return `the built graph did not load (status=${r.status} signal=${r.signal}):\n${`${r.stderr}${r.stdout}`.slice(0, 800)}`;
}

function probe(entry: string) {
  const r = spawnSync(process.execPath, ["-e", probeSource(entry)], {
    env: {
      ...process.env,
      DATABASE_URL: DEAD_DB,
      DB_URL: DEAD_DB,
      NODE_ENV: "test",
      OHMAIL_WORKER_SELFTEST: "1",
    },
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  expect(r.error?.message ?? "", "the subprocess could not be started").not.toMatch(/ENOENT/);
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("the built worker's module graph resolves under Node", () => {
  it("has a build to read", () => {
    // Refused, not skipped: the class this guards is invisible without a build, and a skip here
    // would read as a pass in exactly the run that matters.
    expect(existsSync(ENTRY), `${ENTRY} is absent — build the workspace's packages before this suite`).toBe(true);
  });

  it("loads, or stops only at the dead database", () => {
    // The finding, named with what Node said. A timeout is not a load either: the import must settle.
    expect(loadVerdict(probe(ENTRY))).toBe("");
  }, 90_000);

  it("the verdict refuses every load error but the dead database", () => {
    /* The case above has one green shape, so it must be watched refusing or it is decoration: the
     * same probe over three graphs that do not load, then the two shapes it admits. */
    const dir = mkdtempSync(join(tmpdir(), "dist-import-graph-"));
    try {
      const cases: Array<[string, string, boolean]> = [
        ["missing.mjs", `import "./nowhere.js";\n`, false],
        ["strip-only.mjs", `import ${JSON.stringify(`${ROOT}packages/core/src/adapters/drizzle-repo.ts`)};\n`, false],
        ["throws.mjs", `throw new Error("boom");\n`, false],
        ["dead-db.mjs", `const e = new Error("connect ECONNREFUSED 127.0.0.1:1"); e.code = "ECONNREFUSED"; throw e;\n`, true],
        ["loads.mjs", `export const ok = 1;\n`, true],
      ];
      for (const [name, body, admitted] of cases) {
        writeFileSync(join(dir, name), body);
        const verdict = loadVerdict(probe(join(dir, name)));
        expect(verdict === "", `${name}: ${verdict || "admitted"}`).toBe(admitted);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
