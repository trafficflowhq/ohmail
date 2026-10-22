// @services: none — reads test source as text; its fixture tree dials nothing
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { aloneFiles, dovecotPinned, readSqliteMap, testFiles } from "./support/ci-shards.mjs";
import { classify, homeMadeProbe, markersOf, type Classified } from "./support/service-needs.mjs";
// @ts-expect-error — plain .mjs helper, no declarations by design.
import { code, OPENS_PG } from "../scripts/lib/pg-url-own.mjs";
import { OPENS_IMAP } from "../scripts/lib/imap-host-own.mjs";

/**
 * WHICH TEST FILES NEED A TEST SERVICE, as the runner's gate reads them (`test/support/service-needs.mjs`).
 * Without the services the suite skips a file that needs a missing one, so a file that needs one and is
 * not classified fails on a contributor's machine, and a file that decides for itself whether a service
 * is up answers differently from the run's one probe. Both are held here.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
/* This census's own controls spell the shapes it refuses, on purpose. */
const SELF = "test/service-needs.test.ts";
const FILES = testFiles(REPO);
const memo = new Map<string, Set<string>>();
const BY = new Map<string, Classified>(FILES.map((f) => [f, classify(f, REPO, memo)]));
const raw = (f: string) => readFileSync(join(REPO, f), "utf8");
const DIALS: RegExp[] = [OPENS_PG as RegExp, OPENS_IMAP as RegExp, /\b(?:net\.connect|createConnection)\s*\(/];
const strip = code as (s: string) => string;

/** Every helper module under a test directory: what a test file imports its service from. */
function helperFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(REPO, rel))) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      const c = `${rel}/${e}`;
      if (statSync(join(REPO, c)).isDirectory()) walk(c);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(c);
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const d of readdirSync(join(REPO, top))) {
      try { if (statSync(join(REPO, top, d, "test")).isDirectory()) walk(`${top}/${d}/test`); } catch { /* no test dir */ }
    }
  }
  walk("test");
  return out.sort();
}

describe("the population the gate reads", () => {
  it("classifies the service files, with its anchors", () => {
    const needing = FILES.filter((f) => BY.get(f)!.needs.length > 0);
    expect(needing.length).toBeGreaterThanOrEqual(550);
    for (const f of FILES.filter((x) => /\.pg\.test\.tsx?$/.test(x))) expect(BY.get(f)!.needs, f).toContain("pg");
    expect(BY.get("apps/worker/test/sync.e2e.test.ts")).toEqual({ needs: ["greenmail", "pg"], gated: [], gate: ["greenmail", "pg"] });
    expect(BY.get("apps/sidecar/test/send.e2e.test.ts")!.gate).toContain("greenmail");
    expect(BY.get("apps/mobile/test/engine-bundle-first-sync.imap.test.ts")!.gate).toContain("greenmail");
    expect(BY.get("packages/core/test/adapters/imap.changes.fastpath.test.ts")!.gated).toEqual(["dovecot"]);
    expect(BY.get("packages/db/test/attachment-staging-s3.rustfs.test.ts")).toEqual({ needs: ["rustfs"], gated: ["rustfs"], gate: [] });
    /* A file that only uses PGlite needs nothing: the walk stops at package source. */
    expect(BY.get("packages/db/test/testing-template.test.ts")!.needs).toEqual([]);
  });
});

describe("the classifier, on text it is handed", () => {
  const root = mkdtempSync(join(tmpdir(), "ohmail-service-needs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const DIAL = 'import { ImapFlow } from "imapflow";\nconst c = new ImapFlow({ host: process.env.IMAP_HOST ?? "127.0.0.1", port: 1 });\n';
  put("apps/x/test/raw.test.ts", DIAL);
  put("apps/x/test/prose.test.ts", `/*\n${DIAL}*/\n// const c = new ImapFlow({ host: process.env.IMAP_HOST });\nexport {};\n`);
  put("apps/x/test/_rig.ts", `export const PORT = Number(process.env.IMAP_PORT ?? 1);\n`);
  put("apps/x/test/via-rig.test.ts", 'import { PORT } from "./_rig.js";\nexport const p = PORT;\n');
  put("apps/x/test/data.test.ts", "// @services: none — a port as a value\nexpect(3143).toBe(3143);\n");
  put("apps/x/test/added.test.ts", "// @services: rustfs, pg\nexport {};\n");
  put("apps/x/test/gated.test.ts", 'const s = serviceUp("greenmail");\nconst h = process.env.IMAP_HOST;\n');
  put("apps/x/test/condstore.test.ts", "const p = await probeCondstore();\n");
  put("apps/x/test/_cs.ts", "export const P = process.env.IMAP_CONDSTORE_PORT;\n");
  put("apps/x/test/via-cs.test.ts", 'import { P } from "./_cs.js";\nexport const p = P;\n');

  it("reads a raw dial as its service, and the same text in a comment as nothing", () => {
    expect(classify("apps/x/test/raw.test.ts", root)).toEqual({ needs: ["greenmail"], gated: [], gate: ["greenmail"] });
    expect(classify("apps/x/test/prose.test.ts", root).needs).toEqual([]);
  });

  it("passes a helper's needs to its importer, Dovecot excepted", () => {
    expect(classify("apps/x/test/via-rig.test.ts", root).gate).toEqual(["greenmail"]);
    expect(classify("apps/x/test/_cs.ts", root).needs).toEqual(["dovecot"]);
    expect(classify("apps/x/test/via-cs.test.ts", root).needs).toEqual([]);
  });

  it("reads the markers and the file's own gates", () => {
    expect(classify("apps/x/test/data.test.ts", root).needs).toEqual([]);
    expect(classify("apps/x/test/added.test.ts", root).gate).toEqual(["pg", "rustfs"]);
    expect(classify("apps/x/test/gated.test.ts", root)).toEqual({ needs: ["greenmail"], gated: ["greenmail"], gate: [] });
    expect(classify("apps/x/test/condstore.test.ts", root)).toEqual({ needs: ["dovecot"], gated: ["dovecot"], gate: [] });
    expect(() => markersOf("// @services: none\n", "x")).toThrow("needs its reason");
    expect(() => markersOf("// @services: redis\n", "x")).toThrow("not a test service");
  });

  it("gives a Windows-shaped path the same answer", () => {
    for (const f of ["apps/x/test/raw.test.ts", "apps/x/test/via-rig.test.ts", "apps/x/test/gated.test.ts"]) {
      expect(classify(f.split("/").join("\\"), root)).toEqual(classify(f, root));
    }
  });

  it("knows a home-made probe when it sees one", () => {
    expect(homeMadeProbe("function imapAnswers(host, port) { return true; }")).toMatch(/imapAnswers/);
    expect(homeMadeProbe("const up = await (async () => {\n  try { await c.connect(); return true; } catch { return false; }\n})();")).toMatch(/awaited/);
    expect(homeMadeProbe("const s = createConnection({ host: HOST, port: PORT });")).toMatch(/raw connect/);
    expect(homeMadeProbe('const up = serviceUp("greenmail").up;')).toBeNull();
  });
});

describe("the files the gate reads", () => {
  it("leaves no home-made probe: a file asks the run's one probe (serviceUp, realPgAvailable, probeCondstore)", () => {
    const left = [...FILES, ...helperFiles()].filter((f) => f !== SELF).map((f) => [f, homeMadeProbe(raw(f))] as const).filter(([, p]) => p !== null)
      .map(([f, p]) => `${f}: ${p}`);
    expect(left, "these decide for themselves whether a service is up: take serviceUp(...) from @trafficflow/db/testing").toEqual([]);
  });

  it("marks only files that dial nothing with @services: none", () => {
    const marked = FILES.filter((f) => markersOf(raw(f), f).none);
    expect(marked.length).toBeGreaterThan(10);
    const dialing = marked.filter((f) => f !== SELF && DIALS.some((re) => re.test(strip(raw(f)))));
    expect(dialing, "these say they need no service and open a client").toEqual([]);
  });

  it("places every Dovecot file where CI starts Dovecot, and keeps the jobs without it clear", () => {
    const dovecot = FILES.filter((f) => BY.get(f)!.needs.includes("dovecot"));
    expect(dovecot.length).toBeGreaterThan(10);
    expect(dovecot.filter((f) => !dovecotPinned(REPO, f)), "classified Dovecot, not pinned beside it in ci-shards").toEqual([]);
    const noDovecotOrRustfs = [...aloneFiles(REPO, FILES), ...readSqliteMap(REPO).shards.flat()];
    const ungated = noDovecotOrRustfs.filter((f) => BY.get(f)?.gate.some((s) => s === "dovecot" || s === "rustfs"));
    expect(ungated, "these run in a job that starts no Dovecot or RustFS, and need one ungated").toEqual([]);
  });

  it("classifies every file that spells out a test service's port, or marks it", () => {
    const loose = FILES.filter((f) => /\b(?:5433|3143|3025|3144|3902)\b/.test(strip(raw(f))))
      .filter((f) => BY.get(f)!.needs.length === 0 && !markersOf(raw(f), f).none);
    expect(loose, "these name a test service's port and no service: classify them or mark @services: none — <why>").toEqual([]);
  });
});
