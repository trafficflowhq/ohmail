// @services: none — its child run dials this file's own listener, never a real service
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs helper, no declarations by design.
import { code, DERIVES_URL, OPENS_PG } from "../scripts/lib/pg-url-own.mjs";

/**
 * ONE PLACE DECIDES WHICH POSTGRES A TEST REACHES — `PG_TEST_URL`, which `scripts/lane-db.sh`
 * redirects to this worktree's own database. A file that spells the URL out again reaches the
 * SHARED box while the box selector says this worktree needs no lock: an unlocked write into
 * another lane's suite.
 *
 * The rule: a test file that OPENS a client may not derive its own URL. One that derives a URL and
 * opens nothing is fixture data, and is admitted — which is what keeps this from being a list of
 * exceptions.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/* The three definitions this census used to carry are now `scripts/lib/pg-url-own.mjs`, because
 * `scripts/box-files.mjs` asks the SAME question under `--lane-db` — a file that decides its own
 * URL cannot be vouched for by a lane database — and two copies of these regexes would be two
 * rules one edit apart. The module's docblock carries the reasoning; the cases below are unchanged. */
/* Typed here rather than at the import: the helper is plain `.mjs` with no declarations, so its
 * exports arrive as `any` and every `.some((re) => …)` below would be an implicit-any parameter. */
const OPENS: RegExp = OPENS_PG;
const DERIVES: RegExp[] = DERIVES_URL;
const strip: (src: string) => string = code;

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:test|spec)\.tsx?$|^_.*\.tsx?$/.test(e)) out.push(relative(REPO, p));
    }
  };
  walk(join(REPO, "test"));
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(REPO, group))) walk(join(REPO, group, pkg, "test"));
  }
  return out.sort();
}

const FILES = testFiles().map((f) => ({ f, src: strip(readFileSync(join(REPO, f), "utf8")) }));

describe("which Postgres a test reaches", () => {
  it("has a suite to measure at all", () => {
    expect(FILES.length).toBeGreaterThan(1000);
  });

  it("lets no client-opening test file derive its own URL", () => {
    const offenders = FILES
      .filter(({ src }) => OPENS.test(src) && DERIVES.some((re) => re.test(src)))
      .map(({ f }) => f);
    expect(offenders,
      "these open a Postgres client AND spell out a test database: take pgTestUrl(import.meta.url) " +
      "from @trafficflow/db/testing (or DB_URL from apps/worker/test/_workerdb.ts) instead").toEqual([]);
  });

  /* The rule above is vacuous if nothing opens a client, and a census that cannot fire is worth
   * less than none — so the population it judges is counted. */
  it("judges a real population — the files that do open a client", () => {
    const opening = FILES.filter(({ src }) => OPENS.test(src));
    expect(opening.length).toBeGreaterThan(60);
    const throughHelper = opening.filter(({ src }) => /\bPG_TEST_URL\b|\bDB_URL\b|\bpgTestUrl\b/.test(src));
    expect(throughHelper.length).toBeGreaterThan(40);
  });

  /* The other half: a file may hold the URL as DATA. These are the config resolver's input and the
   * secret scanner's sample, and the census admits them because they open nothing. */
  it("admits a file that ASSIGNS the resolver's URL into the environment it drives", () => {
    const f = "apps/api-vercel/test/wake-e2e.pg.test.ts";
    const entry = FILES.find((x) => x.f === f);
    expect(entry, `${f} has moved — pick another file that assigns process.env from PG_TEST_URL`)
      .toBeDefined();
    expect(/process\.env\.DATABASE_URL_SESSION\s*=\s*PG_TEST_URL/.test(entry!.src)).toBe(true);
    expect(DERIVES.some((re) => re.test(entry!.src))).toBe(false);
  });

  it("admits a file that names a test database and opens nothing", () => {
    const dataOnly = FILES
      .filter(({ src }) => DERIVES.some((re) => re.test(src)) && !OPENS.test(src))
      .map(({ f }) => f);
    expect(dataOnly.length).toBeGreaterThan(2);
    expect(dataOnly).toContain("apps/worker/test/isolated-db-naming.test.ts");
  });

  it("keeps the fallback URL in one source file and one script", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (e === "node_modules" || e === "dist") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:ts|tsx|mjs)$/.test(e) && /\btrafficflow_test\b/.test(strip(readFileSync(p, "utf8")))) {
          sources.push(relative(REPO, p));
        }
      }
    };
    for (const group of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(REPO, group))) walk(join(REPO, group, pkg, "src"));
    }
    walk(join(REPO, "scripts"));
    expect(sources.sort()).toEqual(["packages/db/src/testing.ts", "scripts/lane-db.mjs"]);
  });
});

/* The files that migrate the database they are handed. Off a lane database that is the shared box,
 * so each must take its URL through the refusal before it migrates. */
const MIGRATING = [
  "packages/core/test/adapters/drizzle-repo.test.ts",
  "packages/db/test/schema.rules.test.ts",
  "apps/worker/test/leader-lock.test.ts",
  ...["another-apps-filing-says-why", "api-move-handoff", "attachments", "external-move", "forward-round-trip",
    "move-expunge-fault", "part-cut-by-move", "passive-folders", "poison-batch", "reconcile-cron",
    "reconcile-cron-promotion", "reconcile-poison", "restart", "screen-out-unsubscribes-once", "send",
    "send-multipart", "send-warm-connection", "sync", "uidvalidity-reset"].map((n) => `apps/worker/test/${n}.e2e.test.ts`),
];

describe("a file that migrates, in a checkout with no lane database", () => {
  /* The real files, under the suite's own config, setup and runner, from a tree that links this one's
   * sources and has no .lane-db.env. Every service the probe reads is a listener that accepts and
   * closes, so nothing is skipped and nothing real is dialed; the box's database name is at that port. */
  it("refuses the shared box by the file's name instead of migrating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ohmail-no-lane-db-"));
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      for (const e of ["apps", "packages", "node_modules", "test", "scripts", "tsconfig.base.json", "tsconfig.json"]) {
        symlinkSync(join(REPO, e), join(root, e));
      }
      copyFileSync(join(REPO, "package.json"), join(root, "package.json"));
      copyFileSync(join(REPO, "vitest.config.ts"), join(root, "vitest.config.ts"));
      writeFileSync(join(root, "vitest.fixture.mts"), `import { mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default mergeConfig(base, { resolve: { preserveSymlinks: true }, cacheDir: ${JSON.stringify(join(root, ".vite"))} });
`);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined || /^(VITEST|TEST$|NODE_OPTIONS$|TF_REQUIRE_|OHMAIL_|DATABASE_URL|IMAP_|SMTP_|TF_RUSTFS_URL$)/.test(k)) continue;
        env[k] = v;
      }
      Object.assign(env, {
        DATABASE_URL_PG_TEST: `postgres://tf@127.0.0.1:${port}/trafficflow_test`,
        IMAP_HOST: "127.0.0.1", IMAP_PORT: String(port), SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port),
        IMAP_CONDSTORE_PORT: String(port), TF_RUSTFS_URL: `http://127.0.0.1:${port}`,
      });
      const out = join(root, "out.json");
      /* Asynchronous, so this process's listener answers the child's dials. */
      let said = "";
      await new Promise<void>((resolve) => {
        const c = spawn(process.execPath, [join(REPO, "node_modules/vitest/vitest.mjs"), "run", "--root", root,
          "--config", join(root, "vitest.fixture.mts"), "--reporter=json", `--outputFile=${out}`, ...MIGRATING],
        { cwd: root, env, timeout: 240_000 });
        c.stdout.on("data", (d) => { said += d; });
        c.stderr.on("data", (d) => { said += d; });
        c.on("close", () => resolve());
      });
      expect(existsSync(out), `vitest wrote no report:\n${said}`).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as { testResults: { name: string; message?: string; assertionResults: { status: string; failureMessages: string[] }[] }[] };
      const verdicts = MIGRATING.map((f) => {
        const t = report.testResults.find((x) => x.name === join(root, f));
        const why = [t?.message ?? "", ...(t?.assertionResults ?? []).flatMap((a) => a.failureMessages)].join("\n");
        const passed = (t?.assertionResults ?? []).some((a) => a.status === "passed");
        return { f, refused: !passed && why.includes(`${f}: this run resolved to the SHARED box database`), why: why.trim().split("\n")[0] };
      });
      expect(verdicts.filter((v) => !v.refused).map((v) => `${v.f}: ${v.why}`)).toEqual([]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
