import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * EVERY RUSTFS THIS REPOSITORY STARTS CALLS NOBODY, OPENS NO CONSOLE, AND IS HEALTHY ONLY WHEN READY.
 *
 * RustFS 1.0.1 has two defaults the stack does not want, both read off a running container:
 *
 *   · RUSTFS_CHECK_UPDATE (default on): every start fetches the vendor's latest-version file, so
 *     each install's address and version reach a third party. The self-host stack talks to nothing
 *     it does not need, so every RustFS is started with it off.
 *   · RUSTFS_CONSOLE_ENABLE (default on): a web console on :9001 inside the network that accepts
 *     the root credential. Nothing uses it; it is off.
 *
 * And `/health` answers 200 as soon as the listener is up, before storage and IAM are: a container
 * measured from its start answered `/health` 200 and `/health/ready` 503 for its first moments.
 * The bucket's one-shot init waits on the healthcheck, and the self-host init does not restart, so
 * every healthcheck and every wait reads `/health/ready`.
 *
 * Covered: every compose in the repository that runs the RustFS image, the Umbrel store's env file
 * (rendered by the real pre-start hook), the CI suite's `docker run`, and the live test's probe.
 */
const at = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const rd = (rel: string) => readFileSync(at(rel), "utf8");
const ROOT = at("");

const RUSTFS_IMAGE = /(?:^|\/)(?:mirror-rustfs|rustfs\/rustfs)[:@]/;
const QUIET = { RUSTFS_CHECK_UPDATE: "false", RUSTFS_CONSOLE_ENABLE: "false" } as const;

type Service = {
  image?: string;
  environment?: Record<string, string> | string[];
  env_file?: string[] | string;
  healthcheck?: { test?: string[] | string };
};

/** A service's environment as a map, from either compose spelling. */
function envMap(svc: Service): Record<string, string> {
  const e = svc.environment;
  if (!e) return {};
  if (Array.isArray(e)) return Object.fromEntries(e.map((l) => [l.split("=")[0]!, l.slice(l.indexOf("=") + 1)]));
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)]));
}

/** Every compose file in the repository, found by walking, so one added later is covered too. */
function everyCompose(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "build", "dist", ".next", ".vercel", "target"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (/^docker-compose[.\w-]*\.ya?ml$/.test(e.name)) out.push(rel);
    }
  };
  walk("");
  return out;
}

const services = everyCompose().flatMap((file) => {
  // `logLevel: "error"`: the CI overlay's `!override` tag is compose's own, not YAML's.
  const doc = parse(rd(file), { logLevel: "error" }) as { services?: Record<string, Service> };
  return Object.entries(doc.services ?? {}).map(([name, svc]) => ({ file, name, svc }));
});
const stores = services.filter((s) => RUSTFS_IMAGE.test(s.svc.image ?? ""));

/** The Umbrel store's env file, as the real hook renders it on a scratch app directory. */
const scratch = mkdtempSync(join(tmpdir(), "ohmail-rustfs-quiet-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function umbrelStoreEnv(): Record<string, string> {
  mkdirSync(join(scratch, "data", "env"), { recursive: true });
  writeFileSync(join(scratch, "data", "env", "settings.env"), "OHMAIL_ORIGIN=\n");
  execFileSync("bash", [at("deploy/umbrel/ohmail/hooks/pre-start")], {
    env: { ...process.env, APP_DATA_DIR: scratch },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return Object.fromEntries(readFileSync(join(scratch, "data", "env", "rustfs.env"), "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0]!, l.slice(l.indexOf("=") + 1)]));
}

describe("every RustFS a compose starts", () => {
  it("is found: the self-host, Umbrel and workspace stacks each run one", () => {
    expect(stores.map((s) => s.file).sort()).toEqual([
      "deploy/selfhost/docker-compose.yml",
      "deploy/umbrel/ohmail/docker-compose.yml",
      "docker-compose.yml",
    ]);
  });

  it("starts with the update check and the console off", () => {
    for (const { file, name, svc } of stores) {
      if (svc.env_file) continue; // Umbrel's: its env file is rendered by the hook, read below.
      const env = envMap(svc);
      for (const [k, v] of Object.entries(QUIET)) expect(env[k], `${file} ${name}.${k}`).toBe(v);
    }
  });

  it("and so does Umbrel's, whose environment is the env file its pre-start hook writes", () => {
    const umbrel = stores.find((s) => s.file.startsWith("deploy/umbrel/"))!;
    expect(String(umbrel.svc.env_file)).toContain("data/env/rustfs.env");
    const env = umbrelStoreEnv();
    for (const [k, v] of Object.entries(QUIET)) expect(env[k], `Umbrel rustfs.env ${k}`).toBe(v);
  });

  it("no override file turns either back on", () => {
    for (const { file, name, svc } of services) {
      if (svc.image || !/^rustfs$/.test(name)) continue;
      const env = envMap(svc);
      for (const k of Object.keys(QUIET)) {
        if (k in env) expect(env[k], `${file} ${name}.${k}`).toBe(QUIET[k as keyof typeof QUIET]);
      }
    }
  });

  it("reports healthy only when its storage is ready", () => {
    for (const { file, name, svc } of stores) {
      const test = [svc.healthcheck?.test ?? []].flat().join(" ");
      expect(test, `${file} ${name} healthcheck`).toMatch(/http:\/\/localhost:9000\/health\/ready\b/);
    }
  });
});

describe("the RustFS the CI suite starts by `docker run`", () => {
  const wf = parse(rd(".github/workflows/ci.yml")) as {
    jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string; env?: Record<string, string> }> }>;
  };
  const isStart = (s: { run?: string }) => /docker run[\s\S]*mirror-rustfs:/.test(s.run ?? "");
  const starts = Object.values(wf.jobs).flatMap((j) => j.steps).filter(isStart);

  it("is started with the update check and the console off", () => {
    expect(starts.length, "no step starts RustFS — the checks below would be vacuous").toBeGreaterThan(0);
    for (const s of starts) {
      for (const [k, v] of Object.entries(QUIET)) {
        expect(s.env?.[k], `the step's ${k}`).toBe(v);
        expect(s.run, `the docker run does not pass ${k}`).toMatch(new RegExp(`-e ${k}\\b`));
      }
    }
  });

  it("is waited for until ready, not merely listening", () => {
    for (const s of starts) {
      expect(s.run).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:3902\/health\/ready\b/);
      expect(s.run).not.toMatch(/\/health(?!\/ready)\b/);
    }
  });

  it("makes the live test required, so a job that starts RustFS can never pass that file by skipping it", () => {
    const jobs = Object.entries(wf.jobs).filter(([, j]) => j.steps.some(isStart));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [id, j] of jobs) expect(j.env?.TF_REQUIRE_RUSTFS, `${id}.env.TF_REQUIRE_RUSTFS`).toBe("1");
  });

  it("and the live test probes the same readiness", () => {
    expect(rd("packages/db/test/attachment-staging-s3.rustfs.test.ts")).toMatch(/\/health\/ready`/);
  });
});
