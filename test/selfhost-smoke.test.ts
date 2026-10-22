import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_RING_V1 } from "./support/key-ring-env.js";
import { publicPath } from "./support/public-root.mjs";
import { evalIf, type IfContext } from "./support/workflow-if.js";
import { concurrencyFindings, concurrencyOf, concurrencyRuns } from "./workflows-under-pull-requests.test.js";

/**
 * THE SELF-HOST IMAGES BOOT, FROM THE TREE THEY ARE BUILT FROM, BEFORE ANYTHING PUBLISHES THEM.
 *
 * `.github/scripts/selfhost-smoke.sh` boots the self-host stack and runs deploy/selfhost/boot-smoke.mjs over it:
 * `--build` on a pull request (selfhost-smoke.yml) from images it builds under a run-scoped tag, `--staged` in
 * ghcr-images.yml's gate-boot over the images the release run staged. A service with `build:` and `image:` runs
 * whatever image of that name is local, and pulls the published one when none is, so a plain `up -d` boots the last
 * release and reads green on any tree. What must hold:
 *
 *   · the workflow runs on pull requests and by dispatch only, read-only, on hosted runners, superseded runs cancelled;
 *   · the script builds (or requires) exactly the run's tag, starts with --no-build --pull never, and checks that the
 *     running containers are those images and that /health names the commit, before and after the smoke;
 *   · it refuses a published tag, an image that is neither ours nor pinned by digest, and never prints what it mints;
 *   · gate-boot boots the run's own commit, and runs the ceremony on the staged images after the stranger's boot.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string };
type Job = { name?: string; if?: string; needs?: string | string[]; "runs-on"?: unknown; "timeout-minutes"?: number; permissions?: unknown; strategy?: unknown; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; permissions?: unknown; jobs?: Record<string, Job> };

const WF_TEXT = readFileSync(publicPath("github/workflows/selfhost-smoke.yml"), "utf8");
const IMAGES_TEXT = readFileSync(publicPath("github/workflows/ghcr-images.yml"), "utf8");
const SCRIPT = publicPath("github/scripts/selfhost-smoke.sh");
const DIR = publicPath("deploy/selfhost");
const load = (t: string) => yaml.load(t) as Workflow;
const exec = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const GATE = "boot-smoke";
const ctx = (event: string, result: string, selfhost: string): IfContext => ({
  "github.event_name": event, "needs.changes.result": result, "needs.changes.outputs.selfhost": selfhost,
});

/** What departs from the workflow's shape, one line each; [] when it holds. */
export function workflowFindings(text: string): string[] {
  const out: string[] = [];
  const wf = load(text);
  const triggers = Object.keys(wf.on ?? {});
  if (JSON.stringify(triggers) !== JSON.stringify(["pull_request", "workflow_dispatch"])) out.push(`triggers: ${triggers.join(", ")}`);
  for (const [k, v] of Object.entries(wf.on ?? {})) if (v && typeof v === "object" && ("paths" in v || "paths-ignore" in v)) out.push(`${k} is path-filtered`);
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read" })) out.push(`permissions: ${JSON.stringify(wf.permissions)}`);
  for (const [id, j] of Object.entries(wf.jobs ?? {})) {
    if (j["runs-on"] !== "ubuntu-latest") out.push(`${id} runs on ${JSON.stringify(j["runs-on"])}`);
    if (j.permissions !== undefined) out.push(`${id} has its own permissions`);
    if (j.strategy !== undefined) out.push(`${id} has a matrix`);
  }
  const body = exec(text);
  if (/\bsecrets\./.test(body)) out.push("reads a secret");
  if (/uses: actions\/cache[@/]/.test(body)) out.push("uses actions/cache");
  if (/docker\/login-action|packages:/.test(body)) out.push("logs in to a registry or asks for packages");
  const gate = wf.jobs?.[GATE];
  if (!gate) return [...out, `no ${GATE} job`];
  const runs = (c: IfContext, cancelled = false) => evalIf(String(gate.if ?? "true"), c, { cancelled });
  if (runs(ctx("pull_request", "success", "false"))) out.push("runs on a pull request that changes nothing the images read");
  if (!runs(ctx("pull_request", "success", "true"))) out.push("skips a pull request that changes the images");
  if (!runs(ctx("pull_request", "failure", ""))) out.push("skips when changes failed");
  if (!runs(ctx("workflow_dispatch", "skipped", ""))) out.push("skips a dispatch");
  if (runs(ctx("pull_request", "success", "true"), true)) out.push("runs on a cancelled run");
  if (gate["timeout-minutes"] !== 45) out.push(`timeout ${gate["timeout-minutes"]}`);
  const smoke = (gate.steps ?? []).find((s) => /selfhost-smoke\.sh/.test(s.run ?? ""));
  if (!smoke) out.push("no step runs selfhost-smoke.sh");
  else {
    if (!/selfhost-smoke\.sh --build --dir deploy\/selfhost --tag "\$TAG" --commit "\$SHA"/.test(smoke.run!)) out.push(`the smoke step runs: ${smoke.run}`);
    if (smoke.env?.TAG !== "smoke-${{ github.run_id }}-${{ github.run_attempt }}") out.push(`TAG is ${smoke.env?.TAG}`);
    if (smoke.env?.SHA !== "${{ github.sha }}") out.push(`SHA is ${smoke.env?.SHA}`);
  }
  return out;
}

describe("selfhost-smoke.yml: pull requests and dispatch, read-only, hosted, bounded", () => {
  it("holds its shape", () => {
    expect(workflowFindings(WF_TEXT)).toEqual([]);
  });

  it("supersedes a pull request's earlier run and keeps any other", () => {
    expect(concurrencyFindings(concurrencyOf(WF_TEXT), "selfhost-smoke")).toEqual([]);
    expect(concurrencyRuns(concurrencyOf(WF_TEXT), "selfhost-smoke")).toEqual([]);
  });

  it("is watched failing on pull_request_target, a dropped !cancelled(), a self-hosted runner, a secret and a matrix", () => {
    expect(workflowFindings(WF_TEXT.replace(/^ {2}pull_request:$/m, "  pull_request_target:"))).toContain("triggers: pull_request_target, workflow_dispatch");
    expect(workflowFindings(WF_TEXT.replace("!cancelled() && ", ""))).toContain("runs on a cancelled run");
    const boot = /\n {2}boot-smoke:\n(?: {4}.*\n)*? {4}runs-on: ubuntu-latest\n/;
    expect(boot.test(WF_TEXT), "the planting found no runs-on in boot-smoke").toBe(true);
    const hosted = WF_TEXT.replace(boot, (m) => m.replace("runs-on: ubuntu-latest", "runs-on: [self-hosted, linux]"));
    expect(workflowFindings(hosted)).toContain('boot-smoke runs on ["self-hosted","linux"]');
    expect(workflowFindings(WF_TEXT.replace("SHA: ${{ github.sha }}", "SHA: ${{ secrets.X }}"))).toContain("reads a secret");
    expect(workflowFindings(WF_TEXT.replace("    timeout-minutes: 45\n", "    timeout-minutes: 45\n    strategy:\n      matrix:\n        a: [1, 2]\n")))
      .toContain("boot-smoke has a matrix");
    expect(workflowFindings(WF_TEXT.replace("--build --dir", "--staged --dir"))[0]).toMatch(/^the smoke step runs/);
  });
});

// ── The script, with docker and node stubbed ─────────────────────────────────────────────
const COMMIT = "c".repeat(40);
const OURS: Record<string, string> = { web: "ohmail-web", api: "ohmail-server", organizer: "ohmail-worker" };
const OTHERS: Record<string, string> = {
  proxy: "ghcr.io/trafficflowhq/mirror-caddy:2.10.2@sha256:" + "1".repeat(64),
  db: "ghcr.io/trafficflowhq/mirror-postgres:16.15@sha256:" + "2".repeat(64),
  rustfs: "ghcr.io/trafficflowhq/mirror-rustfs:1.0.1@sha256:" + "3".repeat(64),
  "rustfs-init": "ghcr.io/trafficflowhq/mirror-rustfs-rc:v0.1.36@sha256:" + "4".repeat(64),
  mailpit: "ghcr.io/trafficflowhq/mirror-mailpit:v1.24.2@sha256:" + "5".repeat(64),
  greenmail: "greenmail/standalone:2.1.3@sha256:" + "6".repeat(64),
};

/** A docker that answers the calls the script makes from canned files, and logs each one. */
const DOCKER_STUB = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$STUB_DIR/log"
a=" $* "
last=\${@: -1}
case "$a" in
  *" compose "*" config -q "*) exit 0 ;;
  *" compose "*" config --images "*) cat "$STUB_DIR/images"; exit 0 ;;
  *" compose "*" config --format json "*) cat "$STUB_DIR/config.json"; exit 0 ;;
  *" compose "*" build "*) exit 0 ;;
  *" compose "*" pull "*) if [ "$last" = "\${STUB_PULL_FAIL:-}" ]; then echo "pull denied" >&2; exit 1; fi; exit 0 ;;
  *" compose "*" up "*) exit 0 ;;
  *" compose "*" ps "*) echo "cid-$last"; exit 0 ;;
  *" compose "*" logs "*) echo "STUB-SERVICE-LOGS"; exit 0 ;;
  *" compose "*" down "*) exit 0 ;;
  " inspect --format {{.Image}} "*) s=\${last#cid-}; if [ "$s" = "\${STUB_MISMATCH:-}" ]; then echo "sha256:published"; else echo "sha256:id-$s"; fi; exit 0 ;;
  " image inspect --format {{.Id}} "*)
    case "$last" in
      *"\${STUB_MISSING:-no-such-image}"*) echo "Error: No such image: $last" >&2; exit 1 ;;
      */ohmail-web:*) echo "sha256:id-web" ;;
      */ohmail-server:*) echo "sha256:id-api" ;;
      */ohmail-worker:*) echo "sha256:id-organizer" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
esac
echo "stub docker: unexpected call: $*" >&2
exit 99
`;
/** A node that runs the smoke as STUB_SMOKE_RC, and a curl that answers /health with STUB_HEALTH ("<version> <source>"). */
const NODE_STUB = `#!/usr/bin/env bash
printf 'node %s SMOKE_COMPOSE=%s SMOKE_ENV_FILE=%s\\n' "$*" "$SMOKE_COMPOSE" "$SMOKE_ENV_FILE" >> "$STUB_DIR/log"
echo "[11] the stub smoke"
exit "\${STUB_SMOKE_RC:-0}"
`;
const CURL_STUB = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$STUB_DIR/log"
set -- \${STUB_HEALTH:-}
if [ $# -eq 2 ]; then printf '{"ok":true,"version":"%s","buildSource":"%s"}\\n' "$1" "$2"; else echo '{}'; fi
`;

type Run = { status: number | null; out: string; log: string[]; env: string; dir: string };
function smoke(mode: "--build" | "--staged", tag: string, opts: { images?: string[]; env?: Record<string, string>; dir?: string; json?: Record<string, string> } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-smoke-"));
  const services: Record<string, string> = { ...OTHERS };
  for (const [svc, name] of Object.entries(OURS)) services[svc] = `ghcr.io/trafficflowhq/${name}:${tag}`;
  Object.assign(services, opts.json ?? {});
  writeFileSync(join(dir, "images"), `${(opts.images ?? Object.values(services)).join("\n")}\n`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "ohmail-smoke", services: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, { image: v }])) }));
  writeFileSync(join(dir, "log"), "");
  writeFileSync(join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(dir, "node"), NODE_STUB, { mode: 0o755 });
  writeFileSync(join(dir, "curl"), CURL_STUB, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LC_ALL: "C", RUNNER_TEMP: dir, STUB_DIR: dir,
    DOCKER: join(dir, "docker"), NODE: join(dir, "node"), CURL: join(dir, "curl"), STUB_HEALTH: `${COMMIT} file`, ...opts.env,
  };
  const r = spawnSync("bash", [SCRIPT, mode, "--dir", opts.dir ?? DIR, "--tag", tag, "--commit", COMMIT], { encoding: "utf8", env });
  const envFile = join(dir, "selfhost-smoke.env");
  let envText = "";
  try { envText = readFileSync(envFile, "utf8"); } catch { /* not minted */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean), env: envText, dir };
}
const idx = (log: string[], re: RegExp) => log.findIndex((l) => re.test(l));
const lastValue = (env: string, key: string) => [...env.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].pop()?.[1] ?? "";

describe("selfhost-smoke.sh boots exactly the images of this run and the commit they were built from", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("--build: config, build, the other services' pulls, up without build or pull, identity, smoke, /health, down", () => {
    const r = smoke("--build", "smoke-7-1");
    expect(r.status, r.out).toBe(0);
    const at = {
      config: idx(r.log, / config -q$/), build: idx(r.log, / build web api organizer$/), pull: idx(r.log, / pull /),
      up: idx(r.log, / up -d --no-build --pull never$/), identity: idx(r.log, /^docker inspect --format \{\{\.Image\}\} /),
      smoke: idx(r.log, /boot-smoke\.mjs SMOKE_COMPOSE=/), health: idx(r.log, /^curl -fsS http:\/\/localhost:3080\/health$/), down: idx(r.log, / down -v$/),
    };
    for (const [k, v] of Object.entries(at)) expect(v, `${k} never ran:\n${r.log.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(Object.values(at), r.log.join("\n")).toEqual(Object.values(at).slice().sort((a, b) => a - b));
    expect(r.log.at(-1)).toMatch(/ down -v$/);
    const pulled = r.log.filter((l) => / compose .* pull /.test(l)).map((l) => l.split(" ").pop()).sort();
    expect(pulled).toEqual(Object.keys(OTHERS).sort());
    const compose = /SMOKE_COMPOSE=(.*) SMOKE_ENV_FILE=(.*)$/.exec(r.log[at.smoke]!)!;
    expect(compose[1]).toBe(`${join(r.dir, "docker")} compose -f ${DIR}/docker-compose.yml -f ${DIR}/docker-compose.ci.yml --env-file ${join(r.dir, "selfhost-smoke.env")}`);
    expect(compose[2]).toBe(join(r.dir, "selfhost-smoke.env"));
    for (const svc of Object.keys(OURS)) expect(r.out).toContain(`identity: ${svc} runs ghcr.io/trafficflowhq/${OURS[svc]}:smoke-7-1 (sha256:id-${svc})`);
    expect(r.out).toContain(`identity: /health names ${COMMIT}, read from the build's file`);
  });

  it("mints the env file 0600 from the template and never prints a minted value", () => {
    const r = smoke("--build", "smoke-7-1");
    expect(r.status, r.out).toBe(0);
    expect(statSync(join(r.dir, "selfhost-smoke.env")).mode & 0o777).toBe(0o600);
    expect(r.env.startsWith(readFileSync(join(DIR, ".env.example"), "utf8"))).toBe(true);
    expect(lastValue(r.env, "OHMAIL_ORIGIN")).toBe("http://localhost:3080");
    expect(lastValue(r.env, "OHMAIL_PROJECT")).toBe("ohmail-smoke");
    expect(lastValue(r.env, "OHMAIL_MAIL_UI_PORT")).toBe("18025");
    expect(lastValue(r.env, "OHMAIL_IMAGE_TAG")).toBe("smoke-7-1");
    expect(lastValue(r.env, "OHMAIL_BUILD_VERSION")).toBe(COMMIT);
    expect(lastValue(r.env, KEY_RING_V1)).toMatch(/^[0-9a-f]{64}$/);
    expect(lastValue(r.env, "TF_ALERT_SECRET")).toMatch(/^[0-9a-f]{48}$/);
    expect(lastValue(r.env, "TF_ORGANIZER_INSTALL_ID")).toMatch(/^ohmail-selfhost:smoke-[0-9a-f]{12}$/);
    for (const key of ["POSTGRES_PASSWORD", "RUSTFS_ROOT_PASSWORD", KEY_RING_V1, "TF_ALERT_SECRET"]) {
      const v = lastValue(r.env, key);
      expect(v.length, key).toBeGreaterThanOrEqual(32);
      expect(r.out.includes(v), `${key} was printed`).toBe(false);
      expect(r.log.join("\n").includes(v), `${key} reached an argument`).toBe(false);
    }
  });

  it("--staged builds nothing and boots the staged images", () => {
    const r = smoke("--staged", "stage-0.28.1-99-arm64");
    expect(r.status, r.out).toBe(0);
    expect(r.log.filter((l) => / build /.test(l))).toEqual([]);
    expect(idx(r.log, /boot-smoke\.mjs/)).toBeGreaterThan(idx(r.log, / up -d --no-build --pull never$/));
  });

  it("--staged refuses a staged image the runner does not hold, before anything starts", () => {
    const r = smoke("--staged", "stage-0.28.1-99-arm64", { env: { STUB_MISSING: "ohmail-server" } });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("ghcr.io/trafficflowhq/ohmail-server:stage-0.28.1-99-arm64");
    expect(idx(r.log, / up /)).toBe(-1);
    expect(idx(r.log, /boot-smoke\.mjs/)).toBe(-1);
  });

  it("refuses a running api that is not the run's image, before the smoke, and names it", () => {
    const r = smoke("--build", "smoke-7-1", { env: { STUB_MISMATCH: "api" } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/api runs sha256:published, not ghcr\.io\/trafficflowhq\/ohmail-server:smoke-7-1/);
    expect(idx(r.log, /boot-smoke\.mjs/)).toBe(-1);
    expect(r.log.at(-1)).toMatch(/ down -v$/);
  });

  it("a red smoke prints the stack's logs and still tears down", () => {
    const r = smoke("--build", "smoke-7-1", { env: { STUB_SMOKE_RC: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("STUB-SERVICE-LOGS");
    expect(idx(r.log, / logs --no-color$/)).toBeGreaterThan(idx(r.log, /boot-smoke\.mjs/));
    expect(r.log.at(-1)).toMatch(/ down -v$/);
  });

  it("refuses an api whose /health names another commit, or a version that is not the build's file", () => {
    for (const health of [`${"d".repeat(40)} file`, `${COMMIT} variable`, ""]) {
      const r = smoke("--build", "smoke-7-1", { env: { STUB_HEALTH: health } });
      expect(r.status, health).not.toBe(0);
      expect(r.out).toMatch(/\/health names/);
      expect(r.log.at(-1)).toMatch(/ down -v$/);
    }
  });

  it("names the service and the image a pull could not fetch", () => {
    const r = smoke("--build", "smoke-7-1", { env: { STUB_PULL_FAIL: "rustfs" } });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`rustfs  ${OTHERS.rustfs}`);
    expect(idx(r.log, / up /)).toBe(-1);
  });

  it("refuses a published tag, the wrong namespace for its mode, and a path with whitespace, running nothing", () => {
    for (const [mode, tag] of [["--build", "0.28.0"], ["--build", "latest"], ["--build", "stage-0.28.1-1-amd64"], ["--staged", "smoke-7-1"], ["--staged", "0.28.0"]] as const) {
      const r = smoke(mode, tag);
      expect(r.status, `${mode} ${tag}`).not.toBe(0);
      expect(r.log, `${mode} ${tag}`).toEqual([]);
    }
    const spaced = smoke("--build", "smoke-7-1", { dir: `${DIR}/with space` });
    expect(spaced.status).not.toBe(0);
    expect(spaced.out).toMatch(/whitespace/);
    expect(spaced.log).toEqual([]);
  });

  it("refuses an image that is neither ours nor pinned by digest, and an ohmail image under another tag", () => {
    const foreign = smoke("--build", "smoke-7-1", { json: { greenmail: "greenmail/standalone:2.1.3" } });
    expect(foreign.status).not.toBe(0);
    expect(foreign.out).toContain("greenmail/standalone:2.1.3");
    expect(idx(foreign.log, / build /)).toBe(-1);
    const published = smoke("--build", "smoke-7-1", { json: { web: "ghcr.io/trafficflowhq/ohmail-web:0.28.0" } });
    expect(published.status).not.toBe(0);
    expect(published.out).toContain("web is ghcr.io/trafficflowhq/ohmail-web:0.28.0");
    expect(idx(published.log, / build /)).toBe(-1);
  });
});

describe("the CI overlay builds what the stack runs, and names GreenMail by digest", () => {
  /* Compose's own `!override` tag is no YAML js-yaml reads; the value under it is a plain sequence. */
  const overlay = yaml.load(readFileSync(join(DIR, "docker-compose.ci.yml"), "utf8").replace(/ !override$/gm, "")) as { services: Record<string, { image?: string; build?: { args?: Record<string, string> } }> };
  const root = yaml.load(readFileSync(publicPath("docker-compose.yml"), "utf8")) as { services: Record<string, { image?: string }> };

  it("GreenMail is the multi-arch index digest the root compose names", () => {
    expect(overlay.services.greenmail?.image).toBe("greenmail/standalone:2.1.3@sha256:d6db42a4fc258fec0948b1ae7b579fd06947cc92087c162ec0597972a6c36850");
    expect(overlay.services.greenmail?.image).toBe(root.services.greenmail?.image);
  });

  it("each of the three builds bakes the commit it is given", () => {
    for (const svc of ["web", "api", "organizer"]) {
      expect(overlay.services[svc]?.build?.args, svc).toEqual({ TF_BUILD_VERSION: "${OHMAIL_BUILD_VERSION:-}" });
    }
  });
});

// ── gate-boot in ghcr-images.yml ─────────────────────────────────────────────────────────
/** What departs from gate-boot's clone and ceremony, one line each; [] when they hold. */
export function gateFindings(text: string): string[] {
  const out: string[] = [];
  const job = load(text).jobs?.["gate-boot"];
  const steps = job?.steps ?? [];
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s.name ?? ""));
  const clone = steps.find((s) => /git .*mirror/.test(s.run ?? ""));
  if (!clone) out.push("no step clones the mirror");
  else {
    if (/git clone/.test(clone.run!)) out.push("the mirror is a clone of main's head");
    if (!clone.run!.includes('git -C mirror fetch -q --depth 1 https://github.com/trafficflowhq/ohmail.git "$SHA"')) out.push("the mirror does not fetch $SHA");
    if (!/\[ "\$\(git -C mirror rev-parse HEAD\)" = "\$SHA" \]/.test(clone.run!)) out.push("the mirror's HEAD is not checked against $SHA");
    if (clone.env?.SHA !== "${{ github.sha }}") out.push(`the clone's SHA is ${clone.env?.SHA}`);
  }
  const boot = at(/^Boot cold from the staged images/);
  const down = at(/^Tear down the stranger's stack/);
  const ceremony = steps.findIndex((s) => /selfhost-smoke\.sh/.test(s.run ?? ""));
  const node = steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/setup-node@"));
  if (boot < 0) out.push("the stranger's boot is gone");
  if (ceremony < 0) out.push("no step runs the ceremony");
  else {
    const s = steps[ceremony]!;
    if (s.run!.trim() !== 'bash mirror/.github/scripts/selfhost-smoke.sh --staged --dir mirror/deploy/selfhost --tag "$STAGE_TAG" --commit "$SHA"') out.push(`the ceremony runs: ${s.run!.trim()}`);
    if (s.env?.STAGE_TAG !== "stage-${{ needs.version.outputs.version }}-${{ github.run_id }}-${{ matrix.arch }}") out.push(`STAGE_TAG is ${s.env?.STAGE_TAG}`);
    if (s.env?.SHA !== "${{ github.sha }}") out.push(`the ceremony's SHA is ${s.env?.SHA}`);
    if (!(boot >= 0 && down > boot && ceremony > down)) out.push("the ceremony does not follow the stranger's boot and its teardown");
    if (node < 0 || node > ceremony) out.push("no pinned Node before the ceremony");
  }
  if (job?.["timeout-minutes"] !== 40) out.push(`timeout ${job?.["timeout-minutes"]}`);
  return out;
}

describe("gate-boot boots the run's own commit and runs the first-run ceremony on the staged images", () => {
  it("holds", () => {
    expect(gateFindings(IMAGES_TEXT)).toEqual([]);
  });

  it("is watched failing on main's head, a --build ceremony and a missing ceremony", () => {
    const head = IMAGES_TEXT.replace(/ {10}git init -q mirror\n(?: {10}.*\n)*? {10}\[ "\$\(git -C mirror rev-parse HEAD\)".*\n/,
      "          git clone --depth 1 https://github.com/trafficflowhq/ohmail.git mirror\n");
    expect(head).not.toBe(IMAGES_TEXT);
    expect(gateFindings(head)).toEqual(expect.arrayContaining(["the mirror is a clone of main's head", "the mirror does not fetch $SHA"]));
    const built = IMAGES_TEXT.replace("bash mirror/.github/scripts/selfhost-smoke.sh --staged", "bash mirror/.github/scripts/selfhost-smoke.sh --build");
    expect(built).not.toBe(IMAGES_TEXT);
    expect(gateFindings(built)[0]).toMatch(/^the ceremony runs: .*--build/);
    const gone = IMAGES_TEXT.replace(/ {6}- name: The first-run ceremony[^\n]*\n(?: {8}.*\n)+/, "");
    expect(gone).not.toBe(IMAGES_TEXT);
    expect(gateFindings(gone)).toContain("no step runs the ceremony");
  });
});
