import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NODE_BASE } from "./support/published-base.js";
import { publicPath } from "./support/public-root.mjs";

/**
 * EVERY TOOLCHAIN A PUBLIC WORKFLOW INSTALLS IS AN EXACT RELEASE.
 *
 * A channel or a bare major is whatever was published that morning, installed beside the secrets
 * a job holds. Every setup-node names the Node the published images' base carries; rustup installs
 * one exact Rust, never `stable`, before the first step that compiles; a rust-toolchain file, if
 * one is ever added where cargo runs, must name the same release.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = publicPath("github/workflows");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Step = { name?: unknown; uses?: unknown; run?: unknown; with?: Record<string, unknown> };
type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, { steps?: Step[] }> };

const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const load = (text: string) => yaml.load(text) as Workflow;
const PIN_VAR = "RUST_TOOLCHAIN";
/** Where rustup would find a toolchain file for the crate the workflows compile: its dir and each parent. */
const TOOLCHAIN_FILE_DIRS = ["", "apps/", "apps/desktop/", "apps/desktop/src-tauri/"];

/** A run: block as bash reads it, roughly: comment lines dropped, continuations joined. */
const lines = (run: string) => run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\\\n/g, " ").split("\n");

/** Each setup-node step's node-version, as `<file> <job>: <value>`. */
function nodeVersions(file: string, wf: Workflow): Array<{ at: string; version: unknown; keys: string[] }> {
  return Object.entries(wf.jobs ?? {}).flatMap(([id, job]) => (job.steps ?? [])
    .filter((s) => String(s.uses ?? "").startsWith("actions/setup-node@"))
    .map((s) => ({ at: `${file} ${id}`, version: s.with?.["node-version"], keys: Object.keys(s.with ?? {}).sort() })));
}

/** What refuses in one workflow's Rust: a channel, a toolchain other than the pin, a job compiling before it installs. */
function rustFindings(file: string, wf: Workflow, pin: string): string[] {
  const out: string[] = [];
  const named = (w: string) => w.replace(/["']/g, "") === `$${PIN_VAR}` || w.replace(/["']/g, "") === `\${${PIN_VAR}}` || w === pin;
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    let installed = false;
    let defaulted = false;
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      for (const l of lines(step.run)) {
        const at = `${file} ${id}: ${l.trim().slice(0, 100)}`;
        if (/\brustup\s+(?:self\s+)?update\b/.test(l)) out.push(`${at} — rustup update moves the toolchain to whatever was released`);
        const tc = /\brustup\s+(?:toolchain\s+install|install|default|override\s+set)\s+(\S+)/.exec(l);
        if (tc && !named(tc[1])) out.push(`${at} — the toolchain is ${tc[1]}, not $${PIN_VAR}`);
        if (tc && /\brustup\s+(?:toolchain\s+install|install)\b/.test(l) && named(tc[1])) installed = true;
        if (tc && /\brustup\s+default\b/.test(l) && named(tc[1])) defaulted = true;
        const plus = /\bcargo\s+\+(\S+)/.exec(l);
        if (plus && plus[1] !== pin) out.push(`${at} — cargo +${plus[1]} names another toolchain`);
        const env = /\bRUSTUP_TOOLCHAIN=(\S+)/.exec(l);
        if (env && !named(env[1])) out.push(`${at} — RUSTUP_TOOLCHAIN is ${env[1]}`);
        const compiles = /(?:^|[\s;&|(])cargo\s+(?:\+\S+\s+)?(?:build|test|run|check|install|bench|rustc|doc|tauri)\b|\bnpm run app:build\b|\btauri build\b/.test(l);
        if (compiles && !(installed && defaulted)) out.push(`${at} — compiles before the job installs and defaults to $${PIN_VAR}`);
      }
    }
  }
  return out;
}

/** A RUST_TOOLCHAIN a workflow or one of its jobs sets that is not build.yml's: its own Rust, unchecked. */
function pinFindings(file: string, wf: Workflow, pin: string): string[] {
  const envs: Array<[string, Record<string, unknown> | undefined]> = [["env", wf.env], ...Object.entries(wf.jobs ?? {}).map(([id, j]) => [`${id}.env`, (j as { env?: Record<string, unknown> }).env] as [string, Record<string, unknown> | undefined])];
  return envs.filter(([, e]) => e && PIN_VAR in e && String(e[PIN_VAR]) !== pin).map(([at, e]) => `${file} ${at}: ${PIN_VAR} is ${String(e![PIN_VAR])}, build.yml's is ${pin}`);
}

/** The channel a rust-toolchain(.toml) names: `channel = "x"` in the TOML form, the first line otherwise. */
const fileChannel = (name: string, text: string) =>
  name.endsWith(".toml") ? /^\s*channel\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "" : text.split("\n")[0].trim();

const WORKFLOWS = FILES.map((f) => ({ f, wf: load(readFileSync(`${DIR}/${f}`, "utf8")) }));
const PIN = String(WORKFLOWS.find(({ f }) => f === "build.yml")?.wf.env?.[PIN_VAR] ?? "");

describe("every setup-node names one exact Node: the one the published base carries", () => {
  const all = WORKFLOWS.flatMap(({ f, wf }) => nodeVersions(f, wf));

  it("reads every setup-node step, and each names node-version and nothing else", () => {
    expect(all.length, "the reader found too few setup-node steps").toBeGreaterThanOrEqual(13);
    expect(all.filter((s) => s.keys.join(",") !== "node-version").map((s) => `${s.at}: ${s.keys.join(",")}`)).toEqual([]);
  });

  it(`each is ${NODE_BASE.node}, the Node in ${NODE_BASE.image} at its pinned digest`, () => {
    expect(all.filter((s) => String(s.version) !== NODE_BASE.node).map((s) => `${s.at}: ${String(s.version)}`)).toEqual([]);
  });

  it("refuses a bare major, a range, an LTS alias and a version file", () => {
    const wf = (w: string) => load(`jobs:\n  j:\n    steps:\n      - uses: actions/setup-node@${"a".repeat(40)} # v7\n        with:\n          ${w}\n`);
    expect(nodeVersions("x", wf(`node-version: ${NODE_BASE.node}`)).map((s) => String(s.version)), "the positive control").toEqual([NODE_BASE.node]);
    for (const w of ["node-version: 22", "node-version: 22.x", "node-version: lts/*", "node-version-file: .nvmrc"]) {
      const [s] = nodeVersions("x", wf(w));
      expect(s.keys.join(",") !== "node-version" || String(s.version) !== NODE_BASE.node, w).toBe(true);
    }
  });
});

describe("every Rust a public workflow compiles with is one exact release", () => {
  it(`build.yml names it once, as ${PIN_VAR}, an exact x.y.z`, () => {
    expect(PIN, `${PIN_VAR} is not an exact release in build.yml's env`).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(FILES)("%s: a RUST_TOOLCHAIN it sets is build.yml's", (f) => {
    expect(pinFindings(f, WORKFLOWS.find((w) => w.f === f)?.wf ?? {}, PIN)).toEqual([]);
  });

  it("refuses a second workflow pinning another release", () => {
    expect(pinFindings("x", load(`env:\n  ${PIN_VAR}: "${PIN}"\n`), PIN), "the positive control").toEqual([]);
    expect(pinFindings("x", load(`env:\n  ${PIN_VAR}: "1.98.0"\n`), PIN)).toHaveLength(1);
    expect(pinFindings("x", load(`jobs:\n  j:\n    env:\n      ${PIN_VAR}: "1.98.0"\n`), PIN), "a job's own env").toHaveLength(1);
  });

  it.each(FILES)("%s: no channel, no other toolchain, and every compiling job installs the pin first", (f) => {
    expect(rustFindings(f, WORKFLOWS.find((w) => w.f === f)?.wf ?? {}, PIN)).toEqual([]);
  });

  it("the four desktop jobs are the ones that compile, each installing and defaulting to the pin", () => {
    const wf = WORKFLOWS.find(({ f }) => f === "build.yml")?.wf ?? {};
    const compiling = Object.entries(wf.jobs ?? {})
      .filter(([, j]) => (j.steps ?? []).some((s) => typeof s.run === "string" && /(?:^|[\s;&|(])cargo\s+test\b|\bnpm run app:build\b/m.test(s.run)))
      .map(([id]) => id).sort();
    expect(compiling).toEqual(["linux", "linux-arm64", "macos", "windows"]);
  });

  it("a rust-toolchain file where cargo runs, if there is one, names the same release", () => {
    for (const d of TOOLCHAIN_FILE_DIRS) for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
      const p = `${ROOT}${d}${name}`;
      if (existsSync(p)) expect(fileChannel(name, readFileSync(p, "utf8")), p).toBe(PIN);
    }
    expect(fileChannel("rust-toolchain.toml", `[toolchain]\nchannel = "${PIN}"\n`), "the positive control").toBe(PIN);
    expect(fileChannel("rust-toolchain.toml", "[toolchain]\nchannel = \"stable\"\n"), "a channel in the file").not.toBe(PIN);
    expect(fileChannel("rust-toolchain", "1.98.0\n"), "another release in the plain form").not.toBe(PIN);
  });

  it("refuses rustup update, a channel, another release, cargo +toolchain, and a job compiling before it installs", () => {
    const job = (run: string) => load(`jobs:\n  j:\n    steps:\n      - name: t\n        run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`);
    const setup = `rustup toolchain install "$${PIN_VAR}" --profile minimal --no-self-update\nrustup default "$${PIN_VAR}"`;
    expect(rustFindings("x", job(`${setup}\ncargo test --locked`), PIN), "the positive control").toEqual([]);
    // Each plant trips exactly one rule: the pinned setup comes first wherever the rule is not the order.
    for (const [what, run] of [
      ["rustup update", `${setup}\nrustup update stable\ncargo test`],
      ["a channel as the default", `${setup}\nrustup default stable\ncargo test`],
      ["another release installed", `${setup}\nrustup toolchain install 1.98.0\ncargo test`],
      ["a nightly by cargo +", `${setup}\ncargo +nightly build`],
      ["a RUSTUP_TOOLCHAIN override", `${setup}\nRUSTUP_TOOLCHAIN=stable cargo build`],
      ["compiling with the runner's own Rust", "cargo test --locked"],
      ["packaging before the install", `npm run app:build:engine\n${setup}`],
      ["installing the pin without making it the default", `rustup toolchain install "$${PIN_VAR}"\ncargo test`],
    ] as Array<[string, string]>) expect(rustFindings("x", job(run), PIN), what).toHaveLength(1);
  });
});
