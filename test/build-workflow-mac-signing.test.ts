import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobText, secretsRead } from "./support/workflow-jobs.js";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE macOS JOB SIGNS AND NOTARIZES WHEN THE APPLE SECRETS EXIST, AND SAYS SO BY NAME
 * WHEN THEY DO NOT.
 *
 * One decision — `SIGNED`, written once by "Import the Developer ID certificate, if there
 * is one" — has to drive four things at once: the identity handed to the bundler, the
 * signature assertion, the notarization steps, and the sentence the run summary prints.
 * Any of the four disagreeing with the other three is a build presented as signed that
 * nobody signed, or a red that means "not configured" and trains everyone to ignore the
 * red that means "broken".
 *
 * So this census reads the job's EXECUTED lines — comments stripped, because the file's
 * prose names every tool and every state it refuses, and a needle a comment can satisfy
 * measures the prose. Each reader is exported and driven over a fixture carrying the
 * defect it exists to catch, then over the real workflow as the positive control.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = publicRel("github/workflows/build.yml");

/** The one admitted spelling of a secret read: on a release tag, and empty on every other ref. */
const TAG_GATED = /^\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && secrets\.([A-Z0-9_]+) \|\| '' \}\}$/;

/** Secrets a job reads in any form OTHER than the release-tag gate — readable from a branch. */
export function ungatedSecretReads(job: string): string[] {
  const exec = job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return [...exec.matchAll(/\$\{\{[^}]*?\bsecrets\.([A-Z0-9_]+)[^}]*\}\}/g)]
    .filter((m) => !TAG_GATED.test(m[0]))
    .map((m) => m[1])
    .sort();
}

/** The job's `environment:` line, as written. */
export function environmentOf(job: string): string | null {
  return job.match(/^ {4}environment: (.+)$/m)?.[1]?.trim() ?? null;
}

/** The lines a runner executes: never a comment, never a blank. */
export function executedLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
}

export type Step = { name: string; if: string | null; body: string };

/** The job's steps, split on the `      - ` that opens each one. */
export function steps(job: string): Step[] {
  const blocks: string[] = [];
  let b: string[] | null = null;
  for (const line of job.split("\n")) {
    if (/^ {6}- /.test(line)) {
      if (b) blocks.push(b.join("\n"));
      b = [line];
      continue;
    }
    if (b) b.push(line);
  }
  if (b) blocks.push(b.join("\n"));
  return blocks.map((x) => ({
    name: (x.match(/^ {6}- name: (.+)$/m) ?? x.match(/^ {6}- uses: (.+)$/m))?.[1]?.trim() ?? "",
    if: x.match(/^ {8}if: (.+)$/m)?.[1]?.trim() ?? null,
    body: x,
  }));
}

/**
 * The executed lines with shell continuations JOINED. Measured 2026-09-22: the step that
 * signs the vendored Node runtime spells `codesign --force … \\` over five lines, so a
 * per-line census never saw it and removing that step's gate was a GREEN mutation.
 */
export function executedCommands(text: string): string[] {
  const out: string[] = [];
  let held = "";
  for (const line of executedLines(text)) {
    const t = line.trim();
    if (t.endsWith("\\")) {
      held += t.slice(0, -1) + " ";
      continue;
    }
    out.push(held + t);
    held = "";
  }
  if (held) out.push(held.trim());
  return out;
}

/**
 * Every command that only a run holding the Apple secrets may ever reach. Each alternative
 * demands the tool's OWN argument: the step that asserts its toolchain spells
 * `for t in security codesign ditto spctl xcrun`, and a bare-name census counted that line
 * as three signing calls — a census satisfied by a symbol appearing. The `[\s/]` admits the
 * absolute paths these steps call the system tools by.
 */
const SIGNING_CALLS =
  /(?:^|[\s/])(xcrun\s+notarytool\s+\w|xcrun\s+stapler\s+\w|spctl\s+-|security\s+create-keychain\s|security\s+import\s|codesign\s[^\n]*\s--sign\s|ditto\s+-c\s)/;

/**
 * A step reaching those commands is gated when its own `if:` reads SIGNED, or its script
 * branches on SIGNED, or its script returns before them when the certificate is absent.
 */
export function ungatedSigningSteps(job: string): string[] {
  return steps(job)
    .filter((s) => executedCommands(s.body).some((l) => SIGNING_CALLS.test(l)))
    .filter((s) => {
      const exec = executedLines(s.body).join("\n");
      const stepIf = s.if ?? "";
      const gatedByIf = /env\.SIGNED\s*==\s*'1'/.test(stepIf);
      const gatedByBranch = /\$\{SIGNED:-0\}/.test(exec);
      const gatedByReturn = /-z\s+"\$\{APPLE_CERTIFICATE:-\}"/.test(exec);
      return !(gatedByIf || gatedByBranch || gatedByReturn);
    })
    .map((s) => s.name);
}

export type SigCase = { admits: string[]; refusesWithExit: boolean };

/** Every `case "$SIG_INFO" in` block in the executed text, with what it admits. */
export function signatureCases(text: string): SigCase[] {
  const exec = executedLines(text);
  const out: SigCase[] = [];
  for (let i = 0; i < exec.length; i++) {
    if (!/case\s+"\$SIG_INFO"\s+in/.test(exec[i])) continue;
    const admits: string[] = [];
    let refusesWithExit = false;
    for (let j = i + 1; j < exec.length && !/^\s*esac\s*$/.test(exec[j]); j++) {
      const arm = exec[j].match(/^\s*(\*\)|.*?\))\s/);
      if (!arm) continue;
      if (/^\s*\*\)/.test(exec[j])) {
        refusesWithExit = /exit\s+1/.test(exec[j]);
      } else {
        admits.push(arm[1].trim());
      }
    }
    out.push({ admits, refusesWithExit });
  }
  return out;
}

/** The run-summary step chooses BOTH sentences from SIGNED, and it holds both. */
export function summaryIsConditional(job: string): boolean {
  const step = steps(job).find((s) => s.name === "Run summary");
  if (!step) return false;
  const exec = executedLines(step.body).join("\n");
  return /\$\{SIGNED:-0\}/.test(exec) && /signed and notarized/.test(exec) && /Open Anyway/.test(exec);
}

const SIGNING_CLAIM = /notariz|ad-hoc|unsigned|Open Anyway|\bsigned\b/i;

/**
 * Any claim about the signature written STRAIGHT into the summary block rather than
 * through the variable the SIGNED branch set. Measured 2026-09-22: a mutation that left
 * the branch standing and echoed the ad-hoc sentence anyway was GREEN against a reader
 * that only asked whether a branch existed — a branch nothing reads is not a condition.
 */
export function summaryClaimsOutsideTheBranch(job: string): string[] {
  const step = steps(job).find((s) => s.name === "Run summary");
  if (!step) return ["<no Run summary step>"];
  const exec = executedCommands(step.body);
  const open = exec.findIndex((l) => l.trim() === "{");
  const close = exec.findIndex((l) => /^\}\s*>>\s*"\$GITHUB_STEP_SUMMARY"/.test(l.trim()));
  if (open < 0 || close < 0 || close < open) return ["<no summary block>"];
  return exec.slice(open + 1, close).filter((l) => SIGNING_CLAIM.test(l)).map((l) => l.trim());
}

/** `set -x` anywhere in a job whose environment holds a certificate and a key. */
export function tracedSteps(job: string): string[] {
  return steps(job)
    .filter((s) => executedLines(s.body).some((l) => /^\s*set\s+[-a-z]*x/.test(l)))
    .map((s) => s.name);
}

describe("the published build workflow's macOS signing half", () => {
  const text = readFileSync(resolve(ROOT, WORKFLOW), "utf8");
  const macos = jobText(text, "macos");

  it("reads the macOS job, and nothing else (a zero census is not a pass)", () => {
    expect(macos.length, `no macos job found in ${WORKFLOW}`).toBeGreaterThan(1000);
    expect(macos).toContain("Import the Developer ID certificate, if there is one");
    // The reader stops at the next job: the Windows job's steps are not in scope.
    expect(macos).not.toContain("ohmail-windows-setup.exe");
    expect(steps(macos).length, "no steps parsed out of the macOS job").toBeGreaterThan(10);
  });

  it("every signing and notarization command is gated on the named secrets", () => {
    const gated = steps(macos).filter((s) =>
      executedCommands(s.body).some((l) => SIGNING_CALLS.test(l)),
    );
    expect(gated.length, "no signing command found — the census read nothing").toBeGreaterThanOrEqual(3);
    expect(ungatedSigningSteps(macos), "steps that sign or notarize on a run given no certificate").toEqual([]);
  });

  it("the signature assertion has exactly two answers, and refuses any third by name", () => {
    const cases = signatureCases(macos);
    expect(cases.length, "no $SIG_INFO assertion found").toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      expect(c.admits, `an assertion admitting ${c.admits.length} states: ${c.admits.join(" ")}`).toHaveLength(1);
      expect(c.refusesWithExit, "an assertion whose fallback does not exit 1").toBe(true);
    }
    // ad-hoc ⇔ no certificate, Developer ID ⇔ certificate, and the hardened runtime with it.
    const admitted = cases.flatMap((c) => c.admits).join(" ");
    expect(admitted).toContain("Signature=adhoc");
    expect(admitted).toContain("Authority=Developer ID Application");
    expect(admitted).toContain("(runtime)");
  });

  it("the run summary's sentence follows the same decision as the signature", () => {
    expect(summaryIsConditional(macos), "the summary prints one sentence whatever the build was").toBe(true);
    expect(
      summaryClaimsOutsideTheBranch(macos),
      "signature claims written into the summary block instead of through the SIGNED branch",
    ).toEqual([]);
  });

  it("the job reads exactly the six signing secrets", () => {
    /* The runbook that tells a maintainer which six to add is checked against this list by
       `test/build-workflow-mac-signing.docs.test.ts`. */
    expect(secretsRead(macos), "the macOS job reads no secrets — the census read nothing").toHaveLength(6);
  });

  /* REPO SPLIT the Apple secrets live in the `release` environment, which admits a run on a release
   * tag and nothing else. The job takes that environment on a `v*` tag only, and every read of a secret
   * is gated on the same ref, so a branch, a pull request or a dispatch from one reads none of them even
   * while a copy still sits at repository level. The runbook's half is in the `.docs` sibling. */
  it("reads the Apple secrets on a release tag only, under the release environment", () => {
    expect(environmentOf(macos)).toBe("${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}");
    expect(secretsRead(macos), "the census read nothing").toHaveLength(6);
    expect(ungatedSecretReads(macos), "secrets the macOS job reads off a release tag").toEqual([]);
  });

  it("the gate's readers are watched failing on the shapes they refuse", () => {
    const bare = "        FOO: ${{ secrets.APPLE_X }}";
    expect(ungatedSecretReads(bare)).toEqual(["APPLE_X"]);
    expect(ungatedSecretReads("        FOO: ${{ startsWith(github.ref, 'refs/tags/v') && secrets.APPLE_X || '' }}")).toEqual([]);
    /* A gate on another ref, or a fallback that is not empty, is not the gate. */
    expect(ungatedSecretReads("        FOO: ${{ startsWith(github.ref, 'refs/heads/') && secrets.APPLE_X || '' }}")).toEqual(["APPLE_X"]);
    expect(ungatedSecretReads("        FOO: ${{ startsWith(github.ref, 'refs/tags/v') && secrets.APPLE_X || secrets.APPLE_Y }}")).toEqual(["APPLE_X"]);
    expect(environmentOf("  macos:\n    environment: release\n")).toBe("release");
    expect(environmentOf("  macos:\n    runs-on: macos-15\n")).toBeNull();
  });

  it("no step traces its shell while the certificate and the key are in its environment", () => {
    expect(tracedSteps(macos)).toEqual([]);
  });

  it("refuses the offending shapes (every reader is watched failing)", () => {
    // A notarization step with no gate at all.
    const ungated = [
      "      - name: Notarize",
      "        run: |",
      "          xcrun notarytool submit build/ohmail.dmg --wait",
    ].join("\n");
    expect(ungatedSigningSteps(ungated)).toEqual(["Notarize"]);
    // The same step, gated the three admitted ways.
    expect(ungatedSigningSteps(ungated.replace("        run: |", "        if: env.SIGNED == '1'\n        run: |"))).toEqual([]);
    expect(
      ungatedSigningSteps(
        [
          "      - name: Notarize",
          "        run: |",
          '          if [ "${SIGNED:-0}" = "1" ]; then',
          "            xcrun notarytool submit build/ohmail.dmg --wait",
          "          fi",
        ].join("\n"),
      ),
    ).toEqual([]);

    // A THIRD ADMITTED STATE in the assertion — the exact shape that would let a
    // half-signed build through: Developer ID or ad-hoc, either will do.
    const third = [
      '          case "$SIG_INFO" in',
      '            *"Authority=Developer ID Application"*) echo ok ;;',
      '            *"Signature=adhoc"*) echo also ok ;;',
      '            *) echo no >&2; exit 1 ;;',
      "          esac",
    ].join("\n");
    expect(signatureCases(third)[0].admits).toHaveLength(2);
    // And a fallback that only warns.
    const soft = third.replace('*) echo no >&2; exit 1 ;;', '*) echo no >&2 ;;');
    expect(signatureCases(soft)[0].refusesWithExit).toBe(false);

    // An unconditional release-notes sentence.
    const flat = [
      "      - name: Run summary",
      "        run: |",
      "          echo 'Ad-hoc signed, **not** notarized. … \"Open Anyway\".'",
    ].join("\n");
    expect(summaryIsConditional(flat)).toBe(false);

    // THE BRANCH STANDS AND NOTHING READS IT — the mutation that was green before.
    const orphaned = [
      "      - name: Run summary",
      "        run: |",
      '          if [ "${SIGNED:-0}" = "1" ]; then',
      "            HEADING='### macOS — signed and notarized'",
      "            CLOSING='Signed with a Developer ID and notarized by Apple: double-click to open it.'",
      "          else",
      "            HEADING='### macOS — unsigned build'",
      "            CLOSING='Ad-hoc signed, **not** notarized. … \"Open Anyway\".'",
      "          fi",
      "          {",
      "            echo 'Ad-hoc signed, **not** notarized.'",
      '          } >> "$GITHUB_STEP_SUMMARY"',
    ].join("\n");
    expect(summaryIsConditional(orphaned), "the branch alone still reads conditional").toBe(true);
    expect(summaryClaimsOutsideTheBranch(orphaned)).toHaveLength(1);
    // …and the shipped shape, where the block echoes only what the branch decided.
    const threaded = orphaned.replace("            echo 'Ad-hoc signed, **not** notarized.'", '            echo "$CLOSING"');
    expect(summaryClaimsOutsideTheBranch(threaded)).toEqual([]);

    // A secret read but never documented.
    expect(secretsRead("        FOO: ${{ secrets.APPLE_NEW_THING }}")).toEqual(["APPLE_NEW_THING"]);
    expect(secretsRead("      # ${{ secrets.NOT_READ }} is named in a comment")).toEqual([]);

    // `set -x` beside the secrets.
    expect(tracedSteps(["      - name: Import", "        run: |", "          set -x"].join("\n"))).toEqual(["Import"]);

    // A NEEDLE A COMMENT CANNOT SATISFY. The workflow's own prose names notarytool,
    // `set -x` and every admitted state; read as text it would answer every question
    // above with the file's intentions instead of its steps.
    const prose = [
      "      - name: Prose only",
      "        run: |",
      "          # xcrun notarytool submit build/ohmail.dmg --wait",
      "          # set -x",
      '          # case "$SIG_INFO" in',
    ].join("\n");
    expect(executedCommands(prose).filter((l) => SIGNING_CALLS.test(l))).toEqual([]);
    expect(ungatedSigningSteps(prose)).toEqual([]);
    expect(tracedSteps(prose)).toEqual([]);
    expect(signatureCases(prose)).toEqual([]);
  });
});
