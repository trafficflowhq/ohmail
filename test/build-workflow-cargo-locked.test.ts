import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE TAG BUILD'S CARGO STEPS RUN `--locked`.
 *
 * Measured 2026-09-19: Cargo.toml gained a dependency on
 * Sep 16 without the lockfile's ohmail block gaining the entry, and NOTHING went red — any cargo
 * run quietly rewrites a drifted lock, so the first `cargo test` in each CI job healed the drift
 * for every later step and the refusal was left for a packager's `cargo build --locked` on
 * another machine. The workflow's own comment already promised reproducibility ("`cargo build
 * --locked` from a fresh clone must reproduce the exact build CI made") while its steps ran
 * unlocked.
 *
 * So: every cargo invocation in the published build workflow carries `--locked` (the FIRST cargo
 * step per job is the one that decides — unlocked it rewrites the lock and blinds everything
 * after), and every bundler step passes `--locked` through to the runner (`app:build:engine`'s
 * trailing args reach `tauri build [ARGS]...`, whose contract hands them to cargo after `--`).
 * A zero-match census is refused (census-zero's rule): the assertions demand the lines EXIST.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = publicRel("github/workflows/build.yml");

/** Every cargo invocation line in a run block (never comments), kept whole for the refusal. */
export function cargoInvocations(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s*cargo\s+(test|build|check|run)\b/.test(l));
}

/** The bundler steps: every `run:` line that invokes app:build:engine. */
export function bundlerRuns(text: string): string[] {
  return text.split("\n").filter((l) => /^\s*run:\s*npm run app:build:engine\b/.test(l));
}

export function unlockedCargo(text: string): string[] {
  return cargoInvocations(text).filter((l) => !/\s--locked\b/.test(l));
}

export function bundlersWithoutLocked(text: string): string[] {
  return bundlerRuns(text).filter((l) => !/\s--\s--locked\s*$/.test(l));
}

describe("the published tag build runs cargo --locked", () => {
  const text = readFileSync(resolve(ROOT, WORKFLOW), "utf8");

  it("every cargo invocation carries --locked, and there are some (a zero census is not a pass)", () => {
    const all = cargoInvocations(text);
    // Four jobs (macOS, Windows, Linux x64, Linux aarch64) × two configurations.
    expect(all.length, `no cargo invocation found in ${WORKFLOW} — the census read nothing`).toBeGreaterThanOrEqual(8);
    expect(unlockedCargo(text), "cargo steps without --locked (each rewrites a drifted lock and blinds every later step)").toEqual([]);
  });

  it("every bundler step passes --locked through to the runner", () => {
    const runs = bundlerRuns(text);
    expect(runs.length, "no app:build:engine step found — the census read nothing").toBeGreaterThanOrEqual(4);
    expect(bundlersWithoutLocked(text), "bundler steps whose trailing args do not end in `-- --locked`").toEqual([]);
  });

  it("refuses the offending shapes (the checker is watched failing, not assumed)", () => {
    // The exact pre-fix lines, as build.yml carried them until 2026-09-19.
    const offender = "          cargo test\n          cargo test --features local-engine\n";
    expect(unlockedCargo(offender)).toHaveLength(2);
    const bundler = "        run: npm run app:build:engine -- --bundles nsis\n";
    expect(bundlersWithoutLocked(bundler)).toHaveLength(1);
    // And the admitted shapes pass through the same readers.
    expect(unlockedCargo("          cargo test --locked --features local-engine\n")).toEqual([]);
    expect(bundlersWithoutLocked("        run: npm run app:build:engine -- --bundles nsis -- -- --locked\n")).toEqual([]);
    // A comment line is not an invocation: the workflow's own prose may name unlocked cargo.
    expect(cargoInvocations("      # cargo build --locked from a fresh clone\n")).toEqual([]);
  });
});
