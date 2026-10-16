import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALONE_MARKER, SHARDS, SQLITE_SHARDS, aloneFiles, checkMap, checkSqliteMap, dovecotPinned, hashShard, readMap, readSqliteMap,
  shardFiles, sqliteShardFiles, testFiles, verifyReport, verifySqliteReport,
  type ShardMap, type SqliteShardMap,
} from "./support/ci-shards.mjs";
import { publicRel } from "./support/public-root.mjs";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

/**
 * THE SUITE WORKFLOW AND ITS SHARD MAP. Every test file runs exactly once: in the shard the map names,
 * in the shard its path hashes to when the map does not name it, or alone. And every job that runs the
 * suite does it against a database of its own: TF_REQUIRE_PG set (unset, every pg file skips green),
 * the lane database made first (absent, every pg file refuses at collection), the shared box never
 * named. Each refusal below is also driven against a mutated copy, so none is green for want of a subject.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The suite workflow, where this checkout keeps it (test/support/public-root.mjs). */
const WORKFLOW = publicRel("github/workflows/ci.yml", ROOT);
const workflowText = readFileSync(join(ROOT, WORKFLOW), "utf8");
const composeText = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const dockerignoreText = readFileSync(join(ROOT, "apps/webapp/Dockerfile.dockerignore"), "utf8");
/** Every directory name a checkout holds under apps/ and packages/ (git's tracked set: a fresh checkout's). */
const TRACKED_DIRS = new Set(execFileSync("git", ["ls-files", "-z", "--", "apps", "packages"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\0").filter(Boolean).flatMap((p) => p.split("/").slice(0, -1)));

/** The directory names the web image's context drops (`**\/<name>` in its dockerignore) that a checkout holds. */
function imageDrops(dockerignore: string, dirs: Set<string> = TRACKED_DIRS): string[] {
  return [...new Set(dockerignore.split("\n").map((l) => /^\*\*\/([\w.-]+)$/.exec(l.trim())?.[1])
    .filter((n): n is string => !!n && dirs.has(n)))].sort();
}

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, unknown> };
type Job = { name?: string; permissions?: unknown; env?: Record<string, unknown>; steps: Step[]; services?: Record<string, { image: string; env?: Record<string, string>; ports?: string[]; options?: string }> };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };

/** Every refusal the workflow earns, read from its text against the compose file's and the web image's dockerignore. */
function workflowProblems(text: string, compose: string, imageDrop: string[] = imageDrops(dockerignoreText)): string[] {
  const wf = yaml.load(text) as Workflow;
  const services = (yaml.load(compose) as { services: Record<string, { image: string; shm_size?: string; environment?: Record<string, string>; ports?: string[]; volumes?: string[] }> }).services;
  const problems: string[] = [];
  /* Read-only, set once: no job widens it, and nothing here reads a secret, so a fork's pull request runs it. */
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read" })) problems.push(`PERMISSIONS the workflow grants ${JSON.stringify(wf.permissions)}, not contents: read`);
  for (const [id, job] of Object.entries(wf.jobs)) if (job.permissions !== undefined) problems.push(`PERMISSIONS ${id} sets its own permissions`);
  /* Every action at a full commit, its tag in a comment: a tag can be moved, a commit cannot. */
  for (const line of text.split("\n").filter((l) => /^\s*(-\s+)?uses:/.test(l))) {
    if (!/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.]*$/.test(line)) problems.push(`PIN ${line.trim()} is not a full commit with its tag in a comment`);
  }
  /* GreenMail's port opens before its IMAP server answers, so the wait reads the greeting, never the port alone. */
  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const st of job.steps) if (/Wait for GreenMail/.test(st.name ?? "") && !(st.run ?? "").includes('"* OK"')) problems.push(`GREETING ${id} waits for an open port, not GreenMail's greeting`);
  }
  /* next build type-checks every .ts it can see, and the web image's context drops what its dockerignore
     names: a job that builds the web app drops exactly those a checkout holds, first, or it builds a tree
     no image ever builds. */
  const drops = (r: string) => [...r.matchAll(/-type d -name (\S+) -prune -exec rm -rf \{\} \+/g)].map((m) => m[1]!);
  for (const id of ["webapp-build", "proxy-e2e"]) {
    const runs = (wf.jobs[id]?.steps ?? []).map((st) => st.run ?? "");
    const build = runs.findIndex((r) => /next build|proxy\.e2e\.test\.ts/.test(r) && !drops(r).length && !r.startsWith("cp "));
    const drop = runs.findIndex((r) => drops(r).length > 0);
    if (drop < 0 || build < 0 || drop > build) problems.push(`IMAGE_TREE ${id} builds the web app over test directories the image never sees`);
    const got = [...new Set(runs.flatMap(drops))].sort();
    if (drop >= 0 && got.join(",") !== imageDrop.join(",")) problems.push(`IMAGE_TREE ${id} drops [${got.join(", ")}], the web image's context drops [${imageDrop.join(", ")}]`);
  }
  /* The suite's tests load packages' built output, so every job running the suite builds first (tsc -b). */
  for (const id of ["suite", "alone", "sqlite"]) {
    const runs = (wf.jobs[id]?.steps ?? []).map((st) => st.run ?? "");
    const buildAt = runs.findIndex((r) => /^npm run build$/m.test(r));
    const vitestAt = runs.findIndex((r) => /\bvitest run\b/.test(r));
    if (buildAt < 0 || vitestAt < 0 || buildAt > vitestAt) problems.push(`BUILD ${id} runs vitest before npm run build`);
  }
  /* The required `typecheck` check: the project build, and the web app's own program over its tests too. */
  const typecheckRuns = (Object.values(wf.jobs).find((j) => j.name === "typecheck")?.steps ?? []).map((st) => st.run ?? "");
  if (!typecheckRuns.some((r) => /^npm run build$/m.test(r))) problems.push("TYPECHECK the typecheck job does not run npm run build");
  if (!typecheckRuns.some((r) => r.includes("tsc --noEmit -p apps/webapp/tsconfig.json"))) problems.push("TYPECHECK the typecheck job does not compile the web app's program");
  if (typecheckRuns.some((r) => drops(r).length)) problems.push("TYPECHECK the typecheck job drops test directories, and the web app's program reads its tests");
  /* The desktop job runs the desktop's own files on the desktop's own install, and reads its report back. */
  const desktopRuns = (wf.jobs.desktop?.steps ?? []).map((st) => st.run ?? "");
  const installAt = desktopRuns.findIndex((r) => r.includes("cd apps/desktop && npm ci"));
  const deskVitestAt = desktopRuns.findIndex((r) => /\bvitest run\b/.test(r));
  if (installAt < 0 || deskVitestAt < 0 || installAt > deskVitestAt) problems.push("DESKTOP the desktop job runs vitest before it installs apps/desktop's own tree");
  if (!desktopRuns.some((r) => r.includes("node test/support/ci-shards.mjs --desktop"))) problems.push("DESKTOP the desktop job does not take its files from the shard map");
  if (!desktopRuns.some((r) => r.includes("node test/support/ci-shards.mjs --verify-report desktop"))) problems.push("DESKTOP the desktop job does not read its report back");
  if (text.includes("OHMAIL_FREEZE")) problems.push("FREEZE the workflow names OHMAIL_FREEZE — the shared box is never a CI database");
  for (const [id, job] of Object.entries(wf.jobs)) {
    const runs = job.steps.map((s) => s.run ?? "");
    const vitestAt = runs.findIndex((r) => /\bvitest run\b/.test(r));
    /* The desktop job's files dial no database (test/ci-shards-desktop.test.ts holds that), so it starts none. */
    if (vitestAt < 0 || id === "desktop") continue;
    const step = job.steps[vitestAt];
    if (String(job.env?.TF_REQUIRE_PG ?? step.env?.TF_REQUIRE_PG) !== "1") problems.push(`REQUIRE_PG ${id} runs vitest without TF_REQUIRE_PG "1"`);
    const laneAt = runs.findIndex((r) => r.includes("scripts/lane-db.sh"));
    if (laneAt < 0 || laneAt > vitestAt) problems.push(`LANE_DB ${id} runs vitest before it makes its own database with scripts/lane-db.sh`);
  }
  const hostPort = (p: string) => p.split(":").slice(-2).join(":");
  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const [name, svc] of Object.entries(job.services ?? {})) {
      const twin = services[name === "postgres" ? "db" : name];
      if (!twin) { problems.push(`SERVICE ${id}.${name} has no twin in docker-compose.yml`); continue; }
      if (svc.image !== twin.image) problems.push(`IMAGE ${id}.${name} is ${svc.image}, docker-compose.yml runs ${twin.image}`);
      const want = (twin.ports ?? []).map((p) => hostPort(p.replace(/\s+#.*$/, ""))).sort();
      if (JSON.stringify([...(svc.ports ?? [])].sort()) !== JSON.stringify(want)) problems.push(`PORTS ${id}.${name} maps ${svc.ports}, docker-compose.yml ${want}`);
      for (const [k, v] of Object.entries(twin.environment ?? {})) {
        if (svc.env?.[k] !== v) problems.push(`ENV ${id}.${name} ${k} differs from docker-compose.yml`);
      }
      if (twin.shm_size && !(svc.options ?? "").includes(`--shm-size=${twin.shm_size}`)) problems.push(`SHM ${id}.${name} lacks --shm-size=${twin.shm_size}`);
    }
  }
  /* MinIO and Dovecot start by `docker run` (a service cannot be given a command or a checkout file). */
  const runText = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");
  for (const [name, port] of [["minio", "3902:9000"], ["dovecot", "3144:143"]] as const) {
    if (!runText.includes(services[name].image)) problems.push(`IMAGE ${name} is not started at docker-compose.yml's ${services[name].image}`);
    if (!runText.includes(`-p 127.0.0.1:${port}`)) problems.push(`PORTS ${name} is not published at 127.0.0.1:${port}`);
  }
  if (!runText.includes("/test/dovecot/dovecot.conf:/etc/dovecot/dovecot.conf:ro")) problems.push("DOVECOT_CONF the checkout's dovecot.conf is not mounted");
  return problems;
}

describe("the suite workflow", () => {
  const wf = yaml.load(workflowText) as Workflow;

  it("is admitted whole: every vitest job requires Postgres, makes its database first, and runs compose's services", () => {
    expect(workflowProblems(workflowText, composeText)).toEqual([]);
    // The census has subjects: the jobs it judged really run vitest, and the services are really there.
    const vitestJobs = Object.entries(wf.jobs).filter(([, j]) => j.steps.some((s) => /\bvitest run\b/.test(s.run ?? ""))).map(([id]) => id);
    expect(vitestJobs.sort()).toEqual(["alone", "desktop", "proxy-e2e", "sqlite", "suite"]);
    expect(Object.keys(wf.jobs.suite.services ?? {}).sort()).toEqual(["greenmail", "postgres"]);
  });

  it("refuses a vitest job without TF_REQUIRE_PG, a lane database made after the run, and the shared box", () => {
    const noRequire = workflowText.replace(/(\n {4}env:\n(?: {6}.*\n)*?) {6}TF_REQUIRE_PG: "1"\n/, "$1");
    expect(noRequire).not.toBe(workflowText);
    expect(workflowProblems(noRequire, composeText)).toEqual([expect.stringMatching(/^REQUIRE_PG suite /)]);

    const laneAfter = workflowText.replace("bash scripts/lane-db.sh \"$GITHUB_WORKSPACE\"\n\n      - name: Test shard",
      "echo no database yet\n\n      - name: Test shard").replace("--verify-report \"$SHARD\"", "--verify-report \"$SHARD\" && bash scripts/lane-db.sh \"$GITHUB_WORKSPACE\"");
    expect(laneAfter).not.toBe(workflowText);
    expect(workflowProblems(laneAfter, composeText)).toEqual([expect.stringMatching(/^LANE_DB suite /)]);

    const freeze = workflowText.replace('      TF_REQUIRE_PG: "1"\n', '      TF_REQUIRE_PG: "1"\n      OHMAIL_FREEZE: "1"\n');
    expect(workflowProblems(freeze, composeText)).toEqual([expect.stringMatching(/^FREEZE /)]);
  });

  it("refuses a service image or port that is not docker-compose.yml's", () => {
    const tag = workflowText.replace(/image: ghcr\.io\/trafficflowhq\/mirror-postgres:\S+\n/, "image: postgres:17\n");
    expect(tag).not.toBe(workflowText);
    expect(workflowProblems(tag, composeText)).toEqual([expect.stringMatching(/^IMAGE suite\.postgres is postgres:17/)]);
    const port = workflowText.replace('ports: ["3143:3143", "3025:3025"]', 'ports: ["3144:3143", "3025:3025"]');
    expect(workflowProblems(port, composeText)).toEqual([expect.stringMatching(/^PORTS suite\.greenmail /)]);
    const minio = workflowText.replace("-p 127.0.0.1:3902:9000", "-p 127.0.0.1:9000:9000");
    expect(workflowProblems(minio, composeText)).toEqual([expect.stringMatching(/^PORTS minio /)]);
  });

  it("refuses a workflow that grants more than contents: read, a job that sets its own, and an action not pinned to a commit", () => {
    const write = workflowText.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n");
    expect(write).not.toBe(workflowText);
    expect(workflowProblems(write, composeText)).toEqual([expect.stringMatching(/^PERMISSIONS the workflow grants/)]);
    const widened = workflowText.replace("    name: suite · sqlite (${{ matrix.shard }})\n", "    name: suite · sqlite (${{ matrix.shard }})\n    permissions:\n      contents: write\n");
    expect(widened).not.toBe(workflowText);
    expect(workflowProblems(widened, composeText)).toEqual(["PERMISSIONS sqlite sets its own permissions"]);
    const tag = workflowText.replace(/actions\/setup-node@[0-9a-f]{40} # v7/, "actions/setup-node@v7");
    expect(tag).not.toBe(workflowText);
    expect(workflowProblems(tag, composeText)).toEqual([expect.stringMatching(/^PIN - uses: actions\/setup-node@v7 /)]);
    const bare = workflowText.replace(/(actions\/checkout@[0-9a-f]{40}) # v7/, "$1");
    expect(workflowProblems(bare, composeText)).toEqual([expect.stringMatching(/^PIN /)]);
  });

  it("refuses a GreenMail wait that reads only an open port, and a web build over the test directories", () => {
    const portOnly = workflowText.replace(/if \(exec 3<>\/dev\/tcp\/127\.0\.0\.1\/3143 && read -r -t 5 greeting <&3 && \[\[ "\$greeting" == "\* OK"\* \]\]\) 2>\/dev\/null; then/, "if (exec 3<>/dev/tcp/127.0.0.1/3143) 2>/dev/null; then");
    expect(portOnly).not.toBe(workflowText);
    expect(workflowProblems(portOnly, composeText)).toEqual([expect.stringMatching(/^GREETING suite /)]);
    const overTests = workflowText.replace("      - name: The tree the web image builds\n        run: find apps packages -path '*/node_modules' -prune -o -type d -name test -prune -exec rm -rf {} +\n\n", "");
    expect(overTests).not.toBe(workflowText);
    expect(workflowProblems(overTests, composeText)).toEqual(["IMAGE_TREE webapp-build builds the web app over test directories the image never sees"]);
  });

  it("reads the web image's drop set from its dockerignore, and refuses a job dropping another", () => {
    expect(imageDrops(dockerignoreText)).toEqual(["test"]);
    // A planted dockerignore that also drops a directory the checkout holds asks the jobs for it.
    expect(imageDrops(`${dockerignoreText}\n**/fixtures\n`)).toEqual(["fixtures", "test"]);
    expect(workflowProblems(workflowText, composeText, ["fixtures", "test"])).toEqual([
      "IMAGE_TREE webapp-build drops [test], the web image's context drops [fixtures, test]",
      "IMAGE_TREE proxy-e2e drops [test], the web image's context drops [fixtures, test]",
    ]);
    // A name no checkout holds is no drop a job owes.
    expect(imageDrops(`${dockerignoreText}\n**/no-such-directory-anywhere\n`)).toEqual(["test"]);
  });

  it("refuses a suite job without the build, a typecheck that drops tests or skips a half, and a desktop job off its own install", () => {
    const noBuild = workflowText.replace("      # tsc -b over the project graph: the tests that load a package's built output read this.\n      - name: The project build\n        run: npm run build\n\n", "");
    expect(noBuild).not.toBe(workflowText);
    expect(workflowProblems(noBuild, composeText)).toEqual(["BUILD suite runs vitest before npm run build"]);
    const dropping = workflowText.replace("        run: ./node_modules/.bin/tsc --noEmit -p apps/webapp/tsconfig.json",
      "        run: |\n          find apps packages -path '*/node_modules' -prune -o -type d -name test -prune -exec rm -rf {} +\n          ./node_modules/.bin/tsc --noEmit -p apps/webapp/tsconfig.json");
    expect(dropping).not.toBe(workflowText);
    expect(workflowProblems(dropping, composeText)).toEqual(["TYPECHECK the typecheck job drops test directories, and the web app's program reads its tests"]);
    const noWeb = workflowText.replace("        run: ./node_modules/.bin/tsc --noEmit -p apps/webapp/tsconfig.json", "        run: echo skipped");
    expect(workflowProblems(noWeb, composeText)).toEqual(["TYPECHECK the typecheck job does not compile the web app's program"]);
    const rootOnly = workflowText.replace("        run: cd apps/desktop && npm ci --ignore-scripts --no-audit --no-fund", "        run: echo root tree only");
    expect(rootOnly).not.toBe(workflowText);
    expect(workflowProblems(rootOnly, composeText)).toEqual(["DESKTOP the desktop job runs vitest before it installs apps/desktop's own tree"]);
  });

  it("runs on pull requests, nightly and by hand — never on push, never on a merge queue", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
  });

  it("names its checks so they never collide with the checks the public repository already requires", () => {
    const names = Object.values(wf.jobs).map((j) => j.name ?? "");
    for (const taken of ["every commit is signed off", "engine · typecheck · build", "engine-bearing UI · scan · smoke"]) {
      expect(names).not.toContain(taken);
    }
    expect(wf.jobs.suite.name).toBe("suite (${{ matrix.shard }})");
    // The repository's ruleset requires this check by its name: exactly "typecheck", chosen once.
    expect(wf.jobs.typecheck.name).toBe("typecheck");
    for (const [id, j] of Object.entries(wf.jobs)) if (id !== "typecheck") expect(j.name!.startsWith("suite"), id).toBe(true);
  });

  it("hands every shard's files to vitest through the map, and reads the report back", () => {
    const run = wf.jobs.suite.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("node test/support/ci-shards.mjs --shard \"$SHARD\"");
    expect(run).toContain("node test/support/ci-shards.mjs --verify-report \"$SHARD\"");
    expect(run).toContain("node test/support/ci-shards.mjs --needs-dovecot \"$SHARD\"");
  });

  it("splits the SQLite run by its own map, over the file set vitest lists for it, and reads each report back", () => {
    expect(wf.jobs.sqlite.name).toBe("suite · sqlite (${{ matrix.shard }})");
    const run = wf.jobs.sqlite.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("npx vitest list --config vitest.sqlite.config.ts --filesOnly --json=build/sqlite-files.json");
    expect(run).toContain("node test/support/ci-shards.mjs --sqlite-shard \"$SHARD\" build/sqlite-files.json");
    expect(run).toMatch(/npx vitest run --config vitest\.sqlite\.config\.ts [^\n]*"\$\{files\[@\]\}"/);
    expect(run).toContain("node test/support/ci-shards.mjs --verify-sqlite-report \"$SHARD\" build/sqlite-files.json");
    const plan = wf.jobs.plan.steps.map((s) => s.run ?? "").join("\n");
    expect(plan).toContain("node test/support/ci-shards.mjs --sqlite-indexes");
  });

  it("plans the alone jobs from the marker and refuses a list the shard map's own walk disagrees with", () => {
    const plan = wf.jobs.plan.steps.map((s) => s.run ?? "").join("\n");
    expect(plan).toContain(`git grep -l '${ALONE_MARKER}' -- ':(glob)apps/*/test/**' ':(glob)packages/*/test/**'`);
    expect(plan).toContain("node test/support/ci-shards.mjs --alone");
    expect(plan).toContain("node test/support/ci-shards.mjs --check");
  });
});

describe("the shard map of this tree", () => {
  const map = readMap(ROOT);
  const files = testFiles(ROOT);
  const alone = new Set(aloneFiles(ROOT, files));

  it("holds SHARDS shards and nothing stale, and was measured", () => {
    expect(map.shards).toHaveLength(SHARDS);
    expect(checkMap(ROOT, map)).toEqual([]);
    expect(map.measuredAt).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs every test file exactly once: in one shard, alone, or in the desktop job", async () => {
    const desktop = new Set((await import("./support/ci-shards.mjs")).desktopFiles(ROOT, files));
    const seen = new Map<string, number>();
    for (let n = 0; n < SHARDS; n++) for (const f of shardFiles(n, ROOT, map)) seen.set(f, (seen.get(f) ?? 0) + 1);
    expect([...seen].filter(([, c]) => c > 1)).toEqual([]);
    for (const f of [...alone, ...desktop]) expect(seen.has(f), `${f} runs alone or in the desktop job, and in a shard`).toBe(false);
    expect([...desktop].filter((f) => alone.has(f))).toEqual([]);
    expect(files.filter((f) => !seen.has(f) && !alone.has(f) && !desktop.has(f))).toEqual([]);
    expect(seen.size + alone.size + desktop.size).toBe(files.length);
    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds the files that run alone by their marker, the deployment-wide pg twins among them", () => {
    for (const f of alone) expect(readFileSync(join(ROOT, f), "utf8")).toContain(ALONE_MARKER);
    expect([...alone]).toEqual(expect.arrayContaining([
      "packages/services/test/account-lifecycle-pass.pg.test.ts",
      "packages/services/test/unsubscribe-drain-cursor.pg.test.ts",
      "packages/services/test/unsubscribe-idempotency.pg.test.ts",
      "packages/services/test/unsubscribe-switch.pg.test.ts",
    ]));
  });

  it("packs every file that dials Dovecot into one shard, which is a shard that starts it", () => {
    expect(map.pins.dovecot.length).toBeGreaterThan(0);
    const holders = new Set(map.pins.dovecot.map((f) => map.shards.findIndex((s) => s.includes(f))));
    expect([...holders]).toHaveLength(1);
    const [n] = [...holders];
    expect(n).toBeGreaterThanOrEqual(0);
    expect(shardFiles(n, ROOT, map).some((f) => dovecotPinned(ROOT, f))).toBe(true);
    for (const f of map.pins.dovecot) expect(dovecotPinned(ROOT, f), `${f} is pinned and dials nothing`).toBe(true);
  });
});

describe("the map's two rules, on a planted tree", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ohmail-ci-shards-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const plant = (rel: string, text = "export {};\n") => {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    writeFileSync(join(scratch, rel), text);
  };
  for (let i = 0; i < SHARDS + 2; i++) plant(`packages/p/test/f${i}.test.ts`);
  plant("packages/p/test/twin.pg.test.ts", `// ${ALONE_MARKER}\n`);
  /* The private app's file, spelled in pieces: a published tree holds no such app, and the whole path would
     read as a citation of it. */
  const privateAppFile = ["apps", "admin", "test", "console.test.ts"].join("/");
  plant(privateAppFile);
  const map: ShardMap = { measuredAt: "0".repeat(40), shards: Array.from({ length: SHARDS }, (_, i) => [`packages/p/test/f${i}.test.ts`]), pins: { dovecot: [] } };

  it("runs a file no shard names in the shard its path hashes to, and nowhere else", () => {
    const planted = [`packages/p/test/f${SHARDS}.test.ts`, `packages/p/test/f${SHARDS + 1}.test.ts`];
    for (const f of planted) {
      const holders = [...Array(SHARDS).keys()].filter((n) => shardFiles(n, scratch, map).includes(f));
      expect(holders, f).toEqual([hashShard(f)]);
    }
    // The alone file and the private app's file run in no shard.
    for (let n = 0; n < SHARDS; n++) {
      expect(shardFiles(n, scratch, map)).not.toContain("packages/p/test/twin.pg.test.ts");
      expect(shardFiles(n, scratch, map)).not.toContain(privateAppFile);
    }
  });

  it("refuses a mapped file that is gone, and a mapped file that runs alone", () => {
    expect(checkMap(scratch, map)).toEqual([]);
    const stale = { ...map, shards: map.shards.map((s, i) => (i === 3 ? [...s, "packages/p/test/gone.test.ts"] : s)) };
    expect(checkMap(scratch, stale)).toEqual(["STALE packages/p/test/gone.test.ts (shard 3) is not a test file in this tree"]);
    const aloneMapped = { ...map, shards: map.shards.map((s, i) => (i === 0 ? [...s, "packages/p/test/twin.pg.test.ts"] : s)) };
    expect(checkMap(scratch, aloneMapped)).toEqual([expect.stringMatching(/^ALONE packages\/p\/test\/twin\.pg\.test\.ts/)]);
  });

  it("reads a shard's report back: a file that did not run and a file nobody asked for both refuse", () => {
    const want = shardFiles(2, scratch, map);
    const row = (f: string) => ({ name: join(scratch, f), startTime: 0, endTime: 1 });
    expect(verifyReport(2, { testResults: want.map(row) }, scratch, map)).toEqual({ missing: [], extra: [] });
    expect(verifyReport(2, { testResults: [] }, scratch, map).missing).toEqual(want);
    expect(verifyReport(2, { testResults: [...want, "packages/p/test/f0.test.ts"].map(row) }, scratch, map).extra)
      .toEqual(want.includes("packages/p/test/f0.test.ts") ? [] : ["packages/p/test/f0.test.ts"]);
  });
});

describe("the SQLite shard map of this tree", () => {
  const map = readSqliteMap(ROOT);

  it("holds SQLITE_SHARDS shards, nothing stale and nothing twice, and was measured", () => {
    expect(map.shards).toHaveLength(SQLITE_SHARDS);
    expect(checkSqliteMap(ROOT, map)).toEqual([]);
    expect(map.measuredAt).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs every file of the sqlite project exactly once, and names no file outside it", async () => {
    const config = (await import("../vitest.sqlite.config.ts")).default as { test: { include: string[] } };
    const listed = [...config.test.include].sort();
    expect(listed.length).toBeGreaterThan(100);
    const seen = new Map<string, number>();
    for (let n = 0; n < SQLITE_SHARDS; n++) for (const f of sqliteShardFiles(n, listed, map)) seen.set(f, (seen.get(f) ?? 0) + 1);
    expect([...seen].filter(([, c]) => c > 1)).toEqual([]);
    expect(listed.filter((f) => !seen.has(f))).toEqual([]);
    expect(map.shards.flat().filter((f) => !listed.includes(f))).toEqual([]);
  });
});

describe("the SQLite map's rules, on a planted list", () => {
  const listed = Array.from({ length: SQLITE_SHARDS + 3 }, (_, i) => `packages/p/test/s${i}.test.ts`);
  const map: SqliteShardMap = {
    measuredAt: "0".repeat(40),
    shards: Array.from({ length: SQLITE_SHARDS }, (_, i) => [`packages/p/test/s${i}.test.ts`]),
  };

  it("runs a listed file no shard names in the shard its path hashes to, and a mapped file only while listed", () => {
    for (const f of listed.slice(SQLITE_SHARDS)) {
      const holders = [...Array(SQLITE_SHARDS).keys()].filter((n) => sqliteShardFiles(n, listed, map).includes(f));
      expect(holders, f).toEqual([hashShard(f, SQLITE_SHARDS)]);
    }
    const without0 = listed.filter((f) => f !== "packages/p/test/s0.test.ts");
    expect(sqliteShardFiles(0, without0, map)).not.toContain("packages/p/test/s0.test.ts");
  });

  it("reads a shard's report back: a file that did not run and a file nobody asked for both refuse", () => {
    const want = sqliteShardFiles(1, listed, map);
    const row = (f: string) => ({ name: join(ROOT, f), startTime: 0, endTime: 1 });
    expect(verifySqliteReport(1, listed, { testResults: want.map(row) }, ROOT, map)).toEqual({ missing: [], extra: [] });
    expect(verifySqliteReport(1, listed, { testResults: [] }, ROOT, map).missing).toEqual(want);
    expect(verifySqliteReport(1, listed, { testResults: [...want, "packages/p/test/s0.test.ts"].map(row) }, ROOT, map).extra)
      .toEqual(["packages/p/test/s0.test.ts"]);
  });
});
