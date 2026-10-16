import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE TWO STANDING REDS OF THE PUBLISHED BUILD, AS SETTINGS THE FILE ASSERTS.
 *
 * Read on 2026-09-24 over the public build's last 30 runs: 28 failed and 2 were cancelled. The
 * flatpak job failed every time, the last 10 on two linter checks only Flathub's own build can
 * pass; the perf smoke ran 26 times, forgiven each time, over an engine that never started. So:
 * the perf step requires a verdict and its corpus fits its window, and the linter's two
 * Flathub-only ids are filtered BY NAME while every other finding stays red. Every census below
 * refuses a zero match, because a finder that reads nothing passes everything.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = publicRel("github/workflows/build.yml");
const WF = readFileSync(resolve(ROOT, WORKFLOW), "utf8");

/** One step's lines, from its `- name:` to the next step, by exact name. */
export function stepText(text: string, name: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `      - name: ${name}`);
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && /^ {6}- (name|uses): /.test(l));
  return lines.slice(at, end < 0 ? lines.length : end).join("\n");
}

/** A step's `run: |` body, dedented to column zero. */
export function runBody(step: string): string {
  const lines = step.split("\n");
  const r = lines.findIndex((l) => l === "        run: |");
  if (r < 0) return "";
  const body: string[] = [];
  for (const l of lines.slice(r + 1)) {
    if (l !== "" && !l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

/** `KEY: "value"` pins in a step's env block, every occurrence. */
export function envPins(text: string, key: string): string[] {
  return [...text.matchAll(new RegExp(`^ +${key}: "([^"]*)"$`, "gm"))].map((m) => m[1]!);
}

/* ── THE PERF SMOKE ─────────────────────────────────────────────────────────────────────────── */

/**
 * THE RATE THE CORPUS IS SIZED BY, until a runner prints its own. A rehearsal of this step on
 * the maintainer's host, the released 0.24.0 AppImage restricted to four CPUs, imported
 * HOST_RATE messages a second; a hosted runner's core is taken as RUNNER_FACTOR times slower.
 * The corpus, plus the engine's boot, must finish inside HALF the window.
 */
export const HOST_RATE_MSG_PER_S = 74;
export const RUNNER_FACTOR = 2.5;
export const BOOT_ALLOWANCE_S = 30;

export function corpusFits(messages: number, windowS: number): boolean {
  const runnerRate = HOST_RATE_MSG_PER_S / RUNNER_FACTOR;
  return runnerRate > 0 && BOOT_ALLOWANCE_S + messages / runnerRate <= windowS / 2;
}

describe("the perf smoke produces a verdict on every main build", () => {
  const serve = WF.split("\n").find((l) => /^ {6}- name: Serve a .*-message mailbox$/.test(l)) ?? "";
  const serveStep = stepText(WF, serve.replace(/^ {6}- name: /, ""));
  const measure = stepText(WF, "The packaged app's start and memory on that mailbox");

  it("finds both steps (a census of nothing is not a pass)", () => {
    expect(serve, "no 'Serve a …-message mailbox' step").not.toBe("");
    expect(serveStep.length).toBeGreaterThan(0);
    expect(measure.length, "the measuring step is not in the workflow").toBeGreaterThan(0);
  });

  it("requires a verdict: PERF_SMOKE_REQUIRED is \"1\", declared once", () => {
    const pins = envPins(WF, "PERF_SMOKE_REQUIRED");
    expect(pins, "PERF_SMOKE_REQUIRED is not declared").toHaveLength(1);
    expect(pins[0]).toBe("1");
  });

  it("states its window and its corpus as numbers, one corpus for both steps", () => {
    const windows = envPins(measure, "PERF_SMOKE_WINDOW_S");
    expect(windows, "the window is not a CI setting in the measuring step").toHaveLength(1);
    expect(windows[0]).toMatch(/^[1-9]\d*$/);
    const served = envPins(serveStep, "PERF_FIXTURE_MESSAGES");
    const measured = envPins(measure, "PERF_FIXTURE_MESSAGES");
    expect(served).toHaveLength(1);
    expect(measured).toEqual(served);
    expect(served[0]).toMatch(/^[1-9]\d*$/);
  });

  it("sizes the corpus to finish inside half the window at the runner's rate", () => {
    const windowS = Number(envPins(measure, "PERF_SMOKE_WINDOW_S")[0]);
    const messages = Number(envPins(measure, "PERF_FIXTURE_MESSAGES")[0]);
    expect(corpusFits(messages, windowS), `${messages} messages do not fit ${windowS} s with 2x margin`).toBe(true);
    // The rule refuses what the step carried for eleven days, so it is not true of everything.
    expect(corpusFits(10000, 420)).toBe(false);
  });

  it("hands the engine its key through OHMAIL_KEK, the one path a runner reaches", () => {
    const body = runBody(measure);
    expect(body).toMatch(/^ +OHMAIL_KEK="\$KEK" \\$/m);
    expect(body).toMatch(/^KEK="\$\(node -e /m);
    // The key file is unreachable where no keystore opens, and a step that writes it is a claim.
    expect(body).not.toContain("install-key");
  });

  it("prints its budget row and refuses a checker that printed no verdict", () => {
    const body = runBody(measure);
    expect(body).toContain('--window-s "$PERF_SMOKE_WINDOW_S"');
    expect(body).toMatch(/^grep -a -q '\^PERF_SMOKE: ' perf-smoke\/verdict\.txt \|\| RC=4$/m);
  });
});

/* ── THE FLATPAK LINT ───────────────────────────────────────────────────────────────────────── */

export const FLATHUB_ONLY = ["appstream-screenshots-not-mirrored-in-ostree", "appstream-external-screenshot-url"];

/** The repository pass's output on the public build of 2026-09-24, as the linter printed it. */
export const REAL_REPO_LINT = `{
    "errors": [
        "appstream-screenshots-not-mirrored-in-ostree",
        "appstream-external-screenshot-url"
    ],
    "warnings": [
        "runtime-update-available-to-org.gnome.Platform-51"
    ],
    "info": [
        "appstream-external-screenshot-url: Screenshots are not mirrored to https://dl.flathub.org/media",
        "runtime-update-available-to-org.gnome.Platform-51: Please consider updating to the latest runtime version"
    ],
    "message": "See https://docs.flathub.org/linter for details and exceptions"
}
`;

/** The filter as the step runs it: from its id list to the end of the body, over a given output. */
export function runFilter(filter: string, lintRc: number, output: string): { rc: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "flatpak-lint-"));
  writeFileSync(join(dir, "flatpak-lint-repo.json"), output);
  writeFileSync(join(dir, "filter.sh"), `set -euo pipefail\nLINT_RC=${lintRc}\n${filter}\n`);
  const r = spawnSync("bash", ["filter.sh"], { cwd: dir, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the flatpak lint expects Flathub's two mirror checks to fail offline, and nothing else", () => {
  const body = runBody(stepText(WF, "flatpak-builder-lint"));
  const lines = body.split("\n");
  const idsAt = lines.findIndex((l) => l.startsWith("FLATHUB_ONLY="));
  const filter = idsAt < 0 ? "" : lines.slice(idsAt).join("\n");

  it("names exactly the two ids, with the reason beside them in five lines or fewer", () => {
    expect(idsAt, "no FLATHUB_ONLY list in the lint step").toBeGreaterThan(0);
    expect(/^FLATHUB_ONLY="([^"]*)"$/.exec(lines[idsAt]!)?.[1]?.split(" ")).toEqual(FLATHUB_ONLY);
    const comment: string[] = [];
    for (let i = idsAt - 1; i >= 0 && lines[i]!.startsWith("#"); i--) comment.unshift(lines[i]!);
    expect(comment.length, "the filter carries no reason").toBeGreaterThan(0);
    expect(comment.length).toBeLessThanOrEqual(5);
    expect(comment.join(" ")).toContain("only a Flathub-side mirror can pass these two");
  });

  it("captures the repository pass and hands its exit code to the filter", () => {
    expect(body).toMatch(/repo flatpak-repo > flatpak-lint-repo\.json\nLINT_RC=\$\?\n/);
    expect(body).toContain(`' "$LINT_RC" flatpak-lint-repo.json $FLATHUB_ONLY`);
  });

  it("admits the real red run's output: the two ids dropped, the step green", () => {
    const r = runFilter(filter, 1, REAL_REPO_LINT);
    expect(r.out).toContain("flatpak-builder-lint: GREEN -- expected offline: " + FLATHUB_ONLY.join(" "));
    expect(r.rc).toBe(0);
  });

  it("keeps a third id red, and says which", () => {
    const planted = REAL_REPO_LINT.replace(
      '"appstream-external-screenshot-url"\n',
      '"appstream-external-screenshot-url",\n        "finish-args-arbitrary-dbus-access"\n',
    );
    expect(planted).not.toBe(REAL_REPO_LINT);
    const r = runFilter(filter, 1, planted);
    expect(r.out).toContain("flatpak-builder-lint: RED -- finish-args-arbitrary-dbus-access");
    expect(r.rc).toBe(1);
  });

  it("refuses every output that is not the linter's verdict", () => {
    for (const [lintRc, output, why] of [
      [1, "", "its output is not the JSON it prints"],
      [1, REAL_REPO_LINT.slice(0, 60), "its output is not the JSON it prints"],
      [1, '{"errors": []}\n', "exited 1 and named no error"],
      [2, REAL_REPO_LINT, "exited 2, which is neither of its verdicts"],
    ] as const) {
      const r = runFilter(filter, lintRc, output);
      expect(r.out, `lint rc ${lintRc}`).toContain(why);
      expect(r.rc, `lint rc ${lintRc} over ${JSON.stringify(output.slice(0, 20))} finished green`).toBe(1);
    }
    expect(runFilter(filter, 0, '{"errors": [], "warnings": ["w"]}\n').rc).toBe(0);
  });
});
