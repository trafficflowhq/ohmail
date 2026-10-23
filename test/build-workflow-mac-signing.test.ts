import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobText, secretsRead } from "./support/workflow-jobs.js";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE macOS BUILD HOLDS NO APPLE SECRET; macos-sign SIGNS AND NOTARIZES WHEN THE SECRETS EXIST,
 * AND SAYS SO BY NAME WHEN THEY DO NOT.
 *
 * The build job (`macos`) runs the whole dependency tree and ships ad-hoc bytes. The signing job
 * (`macos-sign`) downloads them, by the ID the build's upload returned and never by a name any job of
 * the run can write, and, on one decision — `SIGNED`, written once by "Import the
 * Developer ID certificate, if there is one" — either signs inside out, notarizes and staples, or
 * forwards them untouched. That decision drives the identity handed to codesign, the signature
 * assertions, the notarization calls and the sentence the run summary prints; any of them
 * disagreeing with the others is a build presented as signed that nobody signed, or a red that means
 * "not configured" and trains everyone to ignore the red that means "broken". On a release tag
 * `macos-signed-check` opens what was shipped, on a runner that never held a key.
 *
 * So this census reads each job's EXECUTED lines — comments stripped, because the file's prose
 * names every tool and every state it refuses, and a needle a comment can satisfy measures the
 * prose. Each reader is exported and driven over a fixture carrying the defect it exists to catch,
 * then over the real workflow as the positive control.
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

export type Step = { name: string; id: string | null; if: string | null; body: string };

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
    id: (x.match(/^ {6}- id: (.+)$/m) ?? x.match(/^ {8}id: (.+)$/m))?.[1]?.trim() ?? null,
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

/** The opening of the one branch every signing command of the signing step sits in. */
const SIGNED_IF = 'if [ "${SIGNED:-0}" = "1" ]; then';

/**
 * A step's executed commands (whitespace folded) split around the SIGNED branch: `signed` between
 * it and its own `else`, `forward` between that and its `fi`, `rest` everything outside it.
 * Only `if … then` / `fi` lines nest; a one-line `if …; fi` opens nothing.
 */
export function signedBranch(body: string): { signed: string[]; forward: string[]; rest: string[] } | null {
  const cmds = executedCommands(body).map((c) => c.replace(/\s+/g, " ").trim());
  const start = cmds.indexOf(SIGNED_IF);
  if (start < 0) return null;
  let depth = 0;
  let split = -1;
  let end = -1;
  for (let j = start + 1; j < cmds.length && end < 0; j++) {
    const t = cmds[j]!;
    if (/^if\b.*;\s*then$/.test(t)) depth++;
    else if (t === "fi") { if (depth === 0) end = j; else depth--; }
    else if (t === "else" && depth === 0 && split < 0) split = j;
  }
  if (end < 0 || split < 0) return null;
  return {
    signed: cmds.slice(start + 1, split),
    forward: cmds.slice(split + 1, end),
    rest: [...cmds.slice(0, start), ...cmds.slice(end + 1)],
  };
}

/** Folded commands split into the shell functions they define, by name, and what runs outside them. */
export function functionsOf(cmds: string[]): { bodies: Map<string, string[]>; outside: string[] } {
  const bodies = new Map<string, string[]>();
  const outside: string[] = [];
  let name: string | null = null;
  let depth = 0;
  for (const c of cmds) {
    if (name === null) {
      const m = /^([A-Za-z_]\w*)\(\) \{$/.exec(c);
      if (m) { name = m[1]!; depth = 1; bodies.set(name, []); } else outside.push(c);
      continue;
    }
    if (c === "}" && --depth === 0) { name = null; continue; }
    if (c !== "}" && /\{$/.test(c)) depth++;
    bodies.get(name)!.push(c);
  }
  return { bodies, outside };
}

/** Signing calls a step can reach without SIGNED: outside the branch, or in a function called from outside it. */
export function signingOutsideTheBranch(body: string): string[] {
  const b = signedBranch(body);
  if (!b) return ["<no SIGNED branch>"];
  const { bodies, outside } = functionsOf(b.rest);
  const reach = [...b.forward, ...outside];
  const out = reach.filter((c) => SIGNING_CALLS.test(c));
  for (const [name, cmds] of bodies) {
    if (!cmds.some((c) => SIGNING_CALLS.test(c))) continue;
    for (const c of reach) if (new RegExp(`(?:^|[\\s;&|(])${name}(?:\\s|$)`).test(c) && !c.startsWith("trap ")) out.push(`${c} (calls ${name}, which signs)`);
  }
  return out;
}

/** The signing order, inside out, each a pattern exactly one command of the signed branch matches. */
export const SIGNING_ORDER: Array<[string, RegExp]> = [
  ["the extended attributes cleared", /^xattr -crs "\$APP"$/],
  ["the vendored node signed", /^codesign --force .*--sign "\$APPLE_SIGNING_IDENTITY" "\$APP\/Contents\/Resources\/runtime\/node"$/],
  ["the app's own binary signed", /^codesign --force .*--sign "\$APPLE_SIGNING_IDENTITY" "\$APP\/Contents\/MacOS\/ohmail"$/],
  ["the app signed", /^codesign --force .*--sign "\$APPLE_SIGNING_IDENTITY" "\$APP"$/],
  ["the app notarized and stapled", /^staple_or_submit "\$APP" /],
  ["the disk image cut from the stapled app", /^make_dmg "\$APP" build\/ohmail\.dmg$/],
  ["the disk image signed", /^codesign --force .*--sign "\$APPLE_SIGNING_IDENTITY" build\/ohmail\.dmg$/],
  ["the disk image notarized and stapled", /^staple_or_submit build\/ohmail\.dmg /],
  ["the updater payload cut", /^tar -czf build\/ohmail\.app\.tar\.gz /],
];

/** Every way a signed branch departs from that order: a step missing or doubled, or out of place. */
export function orderProblems(signed: string[]): string[] {
  const out: string[] = [];
  let last = -1;
  for (const [what, re] of SIGNING_ORDER) {
    const at = signed.map((c, i) => (re.test(c) ? i : -1)).filter((i) => i >= 0);
    if (at.length !== 1) { out.push(`${what}: ${at.length} commands, not 1`); continue; }
    if (at[0]! <= last) out.push(`${what}: before the step it must follow`);
    last = at[0]!;
  }
  return out;
}

/** `--deep` on any executed line: codesign then signs nested code it never inspected, outside in. */
export const deepCalls = (job: string): string[] => executedLines(job).filter((l) => /--deep\b/.test(l)).map((l) => l.trim());

export type Transfer = { job: string; kind: "upload" | "download"; name: string; byId: boolean; body: string };

/**
 * The artifact a download by ID fetches: `${{ needs.J.outputs.O || '0' }}`, J's output O the artifact-id of
 * J's upload step it names. Null when a link is missing: that download fetches nothing anybody uploads.
 */
export function uploadById(text: string, ref: string): string | null {
  const m = /^\$\{\{ needs\.([\w-]+)\.outputs\.([\w-]+) \|\| '0' \}\}$/.exec(ref);
  if (!m) return null;
  const job = jobText(text, m[1]!);
  const out = new RegExp(`^ {4}outputs:\\n(?: {6}.+\\n)*? {6}${m[2]}: \\$\\{\\{ steps\\.([\\w-]+)\\.outputs\\.artifact-id \\}\\}$`, "m").exec(job);
  const up = out ? steps(job).find((s) => s.id === out[1] && /uses: actions\/upload-artifact@/.test(s.body)) : undefined;
  return up?.body.match(/^ {10}name: (.+)$/m)?.[1]?.trim() ?? null;
}

/** Every artifact the workflow's jobs upload or download, by the job that does it; a download by ID by what it resolves to. */
export function transfers(text: string): Transfer[] {
  const ids = [...text.matchAll(/^ {2}([A-Za-z][\w-]*):$/gm)].map((m) => m[1]!).filter((id) => text.indexOf(`\njobs:\n`) < text.indexOf(`\n  ${id}:\n`));
  return ids.flatMap((job) => steps(jobText(text, job)).flatMap((s) => {
    const kind = /uses: actions\/upload-artifact@/.test(s.body) ? "upload" : /uses: actions\/download-artifact@/.test(s.body) ? "download" : null;
    const ref = kind === "download" ? s.body.match(/^ {10}artifact-ids: (.+)$/m)?.[1]?.trim() : undefined;
    const name = s.body.match(/^ {10}name: (.+)$/m)?.[1]?.trim() ?? (ref ? uploadById(text, ref) ?? `<nothing uploaded: ${ref}>` : undefined);
    return kind && name ? [{ job, kind, name, byId: ref !== undefined, body: s.body } as Transfer] : [];
  }));
}

const by = (ts: Transfer[], kind: Transfer["kind"], name: string) => ts.filter((t) => t.kind === kind && t.name === name).map((t) => t.job);
const UNSIGNED = "ohmail-macos-unsigned-${{ github.run_number }}";
const SHIPPED = ["ohmail-dmg-${{ github.run_number }}", "ohmail-app-tgz-${{ github.run_number }}"];
const SIX = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_P8_B64", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "KEYCHAIN_PASSWORD"];
const SIGN_STEP = "Sign and notarize the app and its disk image, or forward the unsigned build";

describe("the published build workflow's macOS signing half", () => {
  const text = readFileSync(resolve(ROOT, WORKFLOW), "utf8");
  const build = jobText(text, "macos");
  const sign = jobText(text, "macos-sign");
  const check = jobText(text, "macos-signed-check");
  const step = steps(sign).find((s) => s.name === SIGN_STEP);
  const branch = step ? signedBranch(step.body) : null;

  it("reads the three macOS jobs, and nothing else (a zero census is not a pass)", () => {
    expect(build.length, `no macos job found in ${WORKFLOW}`).toBeGreaterThan(1000);
    expect(sign.length, "no macos-sign job").toBeGreaterThan(1000);
    expect(check.length, "no macos-signed-check job").toBeGreaterThan(500);
    expect(sign).toContain("Import the Developer ID certificate, if there is one");
    // The reader stops at the next job: the Windows job's steps are not in scope.
    expect(check).not.toContain("ohmail-windows-setup.exe");
    expect(steps(build).length, "no steps parsed out of the macOS job").toBeGreaterThan(10);
    expect(step, `macos-sign has no "${SIGN_STEP}" step`).toBeDefined();
    expect(branch, "the signing step has no SIGNED branch with an else and a fi").not.toBeNull();
  });

  it("the build job holds no signing material: no secret, no environment, no signing call, no signing variable", () => {
    expect(secretsRead(build)).toEqual([]);
    expect(environmentOf(build)).toBeNull();
    expect(executedCommands(build).filter((l) => SIGNING_CALLS.test(l))).toEqual([]);
    expect(executedLines(build).filter((l) => /\bSIGNED\b|OHMAIL_KEYCHAIN|APPLE_|KEYCHAIN_PASSWORD/.test(l)).map((l) => l.trim())).toEqual([]);
  });

  it("the build job asserts the ad-hoc seal it ships, and refuses anything else by name", () => {
    const cases = signatureCases(build);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.admits).toEqual(['*"Signature=adhoc"*)']);
    expect(cases[0]!.refusesWithExit).toBe(true);
  });

  it("every signing and notarization command in macos-sign is gated on the named secrets", () => {
    const gated = steps(sign).filter((s) => executedCommands(s.body).some((l) => SIGNING_CALLS.test(l)));
    expect(gated.length, "no signing command found — the census read nothing").toBeGreaterThanOrEqual(2);
    expect(ungatedSigningSteps(sign), "steps that sign or notarize on a run given no certificate").toEqual([]);
    /* And inside the signing step, every one of them sits in the SIGNED branch or in a function only it calls. */
    expect(functionsOf(branch!.rest).bodies.get("staple_or_submit")?.some((c) => SIGNING_CALLS.test(c)), "the census read no function").toBe(true);
    expect(signingOutsideTheBranch(step!.body)).toEqual([]);
  });

  it("each signature assertion in macos-sign has exactly one answer, and refuses any other by name", () => {
    const cases = signatureCases(sign);
    expect(cases.length, "no $SIG_INFO assertion found").toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      expect(c.admits, `an assertion admitting ${c.admits.length} states: ${c.admits.join(" ")}`).toHaveLength(1);
      expect(c.refusesWithExit, "an assertion whose fallback does not exit 1").toBe(true);
    }
    // What arrived is the bundler's ad-hoc seal; what leaves a signed run is a Developer ID with the hardened runtime.
    const admitted = cases.flatMap((c) => c.admits).join(" ");
    expect(admitted).toContain("Signature=adhoc");
    expect(admitted).toContain("Authority=Developer ID Application");
    expect(admitted).toContain("(runtime)");
  });

  it("the run summary's sentence follows the same decision as the signature", () => {
    expect(summaryIsConditional(sign), "the summary prints one sentence whatever the build was").toBe(true);
    expect(
      summaryClaimsOutsideTheBranch(sign),
      "signature claims written into the summary block instead of through the SIGNED branch",
    ).toEqual([]);
  });

  /* The Apple secrets live in the `release` environment, which admits a run on a release tag and
   * nothing else. The signing job takes that environment on a `v*` tag only, and every read of a
   * secret is gated on the same ref, so a branch, a pull request or a dispatch from one reads none of
   * them even while a copy still sits at repository level. */
  it("macos-sign reads exactly the six signing secrets, on a release tag only, under the release environment", () => {
    expect(secretsRead(sign), "the census read nothing").toEqual(SIX);
    expect(environmentOf(sign)).toBe("${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}");
    expect(ungatedSecretReads(sign), "secrets macos-sign reads off a release tag").toEqual([]);
  });

  it("no step of macos-sign traces its shell while the certificate and the key are in its environment", () => {
    expect(tracedSteps(sign)).toEqual([]);
  });

  it("hands the build to the signing job by one internal artifact, and ships what only the signing job uploads", () => {
    const ts = transfers(text);
    expect(by(ts, "upload", UNSIGNED), "the internal artifact is uploaded by the build job once").toEqual(["macos"]);
    expect(by(ts, "download", UNSIGNED), "and read by the signing job alone").toEqual(["macos-sign"]);
    expect(ts.filter((t) => t.kind === "download" && t.name === UNSIGNED).map((t) => t.byId), "by its ID, never by name").toEqual([true]);
    for (const name of SHIPPED) {
      expect(by(ts, "upload", name), `${name} has one producer, the signing job`).toEqual(["macos-sign"]);
      expect(by(ts, "download", name), `${name} is read back by the check job alone`).toEqual(["macos-signed-check"]);
    }
    const internal = ts.find((t) => t.kind === "upload" && t.name === UNSIGNED)!;
    expect(internal.body).toMatch(/\n {10}path: \|\n {12}build\/ohmail\.dmg\n {12}build\/ohmail\.app\.tar\.gz\n {10}retention-days: 7\n/);
  });

  /* Every job of a tag run can write an artifact of any name, and one written again gets a new ID: fetched by
   * the ID the build's upload returned, a build another job replaced fails the download, before any key. */
  it("macos-sign fetches the build by the ID the build job's upload returned, before it imports a key", () => {
    const [fetch, ...rest] = steps(sign);
    expect(fetch?.name).toBe("Fetch the unsigned build");
    expect(fetch!.body).toMatch(/^ {10}artifact-ids: \$\{\{ needs\.macos\.outputs\.unsigned-id \|\| '0' \}\}$/m);
    expect(fetch!.body).toMatch(/^ {10}path: unsigned$/m);
    expect(fetch!.body, "a name beside the ID").not.toMatch(/^ {10}name: /m);
    expect(rest.findIndex((s) => s.name === "Import the Developer ID certificate, if there is one")).toBeGreaterThanOrEqual(0);
    expect(build).toMatch(/^ {4}outputs:\n {6}unsigned-id: \$\{\{ steps\.unsigned\.outputs\.artifact-id \}\}$/m);
    expect(steps(build).filter((s) => s.id === "unsigned").map((s) => s.body.match(/^ {10}name: (.+)$/m)?.[1]?.trim())).toEqual([UNSIGNED]);
    expect(uploadById(text, "${{ needs.macos.outputs.unsigned-id || '0' }}")).toBe(UNSIGNED);
  });

  it("signs inside out: the node, the binary, the app, its ticket, the image, its ticket, then the payload", () => {
    expect(orderProblems(branch!.signed)).toEqual([]);
    const tar = branch!.signed.findIndex((c) => SIGNING_ORDER.at(-1)![1].test(c));
    expect(branch!.signed.slice(tar + 1).filter((c) => /stapler staple|staple_or_submit|codesign /.test(c)), "something is stapled or signed after the payload is cut").toEqual([]);
    expect(deepCalls(sign), "a deep signature seals what it never inspected").toEqual([]);
  });

  it("signs the node for the JavaScript engine's JIT, the app for the hardened runtime, the image without it", () => {
    const sig = (re: RegExp) => branch!.signed.find((c) => re.test(c)) ?? "";
    const [node, binary, app, , , dmg] = [1, 2, 3, 4, 5, 6].map((i) => sig(SIGNING_ORDER[i]![1]));
    for (const c of [node, binary, app]) {
      expect(c).toContain("--options runtime");
      expect(c).toContain("--timestamp");
      expect(c).toContain('--keychain "$OHMAIL_KEYCHAIN"');
    }
    expect(node).toContain('--entitlements "$ENT"');
    expect(dmg).toContain("--timestamp");
    expect(dmg).not.toContain("--options runtime");
    const lines = step!.body.split("\n").map((l) => l.trim());
    const from = lines.indexOf(`cat > "$ENT" <<'PLIST'`);
    const to = lines.indexOf("PLIST", from + 1);
    expect(from, "no entitlements heredoc").toBeGreaterThan(-1);
    const plist = lines.slice(from + 1, to).join("\n");
    expect(plist).toContain("<key>com.apple.security.cs.allow-jit</key><true/>");
    expect(plist).toContain("<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>");
  });

  it("forwards the build's own bytes otherwise, and rehearses the disk image with the same make_dmg", () => {
    const fwd = branch!.forward;
    for (const f of ["ohmail.dmg", "ohmail.app.tar.gz"]) {
      const cp = fwd.indexOf(`cp unsigned/${f} build/${f}`);
      expect(cp, `${f} is not forwarded`).toBeGreaterThan(-1);
      expect(fwd.indexOf(`cmp unsigned/${f} build/${f}`), `${f} is not compared with what the build made`).toBeGreaterThan(cp);
    }
    expect(fwd.filter((c) => /^make_dmg "\$APP" /.test(c)), "the rehearsal does not cut the image").toHaveLength(1);
    expect(executedLines(step!.body).filter((l) => /^\s*make_dmg\(\) \{$/.test(l)), "make_dmg is not one function both branches call").toHaveLength(1);
    expect(fwd.filter((l) => SIGNING_CALLS.test(l)), "the forward branch signs").toEqual([]);
    /* The build's own image is mounted only where no key can be: the forward branch. */
    expect([...branch!.signed, ...branch!.rest].filter((c) => c.includes("unsigned/ohmail.dmg"))).toEqual([]);
  });

  /* Each `if:` names `!cancelled()`: one naming no status function is `success()` over the whole needs chain, and
   * `changes`, above the build, is skipped on every run that is not a pull request (build-workflow-tag-trigger and
   * pr-build-scope read the chain). */
  it("macos-sign starts when the build succeeded, whatever ran above it", () => {
    expect(sign).toMatch(/^ {4}needs: macos$/m);
    expect(sign.match(/^ {4}if: (.+)$/gm), "one job-level if").toHaveLength(1);
    expect(sign.match(/^ {4}if: (.+)$/m)?.[1]).toBe("${{ !cancelled() && needs.macos.result == 'success' }}");
  });

  it("the check job reads no secret, takes no environment, and runs on a release tag only, after the signing job succeeded", () => {
    expect(secretsRead(check)).toEqual([]);
    expect(environmentOf(check)).toBeNull();
    expect(check).toMatch(/^ {4}needs: macos-sign$/m);
    expect(check.match(/^ {4}if: (.+)$/m)?.[1]).toBe("${{ !cancelled() && needs.macos-sign.result == 'success' && startsWith(github.ref, 'refs/tags/v') }}");
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

  it("the order and branch readers refuse a step moved, doubled or dropped, and an else that is not the branch's", () => {
    const good = branch!.signed;
    expect(orderProblems(good), "the positive control").toEqual([]);
    const tar = good.findIndex((c) => c.startsWith("tar -czf build/ohmail.app.tar.gz "));
    const appStaple = good.findIndex((c) => c.startsWith('staple_or_submit "$APP" '));
    const early = [...good.slice(0, appStaple), good[tar]!, ...good.slice(appStaple).filter((_, i) => i !== tar - appStaple)];
    expect(orderProblems(early)).toEqual(["the updater payload cut: before the step it must follow"]);
    expect(orderProblems(good.filter((c) => !c.startsWith("xattr ")))).toEqual(["the extended attributes cleared: 0 commands, not 1"]);
    expect(orderProblems([...good, good[tar]!])).toEqual(["the updater payload cut: 2 commands, not 1"]);
    expect(deepCalls('          codesign --force --deep --sign "$ID" "$APP"\n          # --deep in a comment')).toHaveLength(1);
    /* An else inside a nested if is that if's own. */
    const nested = [
      "      - name: S", "        run: |", `          ${SIGNED_IF}`, "            if [ -x a ]; then", "              echo a", "            else", "              echo b",
      "            fi", "            echo signed", "          else", "            echo forward", "          fi", "          echo after",
    ].join("\n");
    expect(signedBranch(nested)).toEqual({
      signed: ["if [ -x a ]; then", "echo a", "else", "echo b", "fi", "echo signed"], forward: ["echo forward"], rest: ["- name: S", "run: |", "echo after"],
    });
    expect(signedBranch(nested.replace(`${SIGNED_IF}`, "if true; then"))).toBeNull();
    /* A signing function called outside the branch signs on every run; the trap that names a cleanup does not. */
    const fn = (call: string) => [
      "      - name: S", "        run: |", "          notarize() {", "            xcrun notarytool submit x.zip --wait", "          }", "          trap cleanup EXIT",
      `          ${SIGNED_IF}`, "            notarize", "          else", `            ${call}`, "          fi",
    ].join("\n");
    expect(signingOutsideTheBranch(fn("echo forward"))).toEqual([]);
    expect(signingOutsideTheBranch(fn("notarize"))).toEqual(["notarize (calls notarize, which signs)"]);
    expect(signingOutsideTheBranch(fn("xcrun stapler staple x.dmg"))).toEqual(["xcrun stapler staple x.dmg"]);
    /* The pairing reader: a typo anywhere between the download and the upload resolves to nothing uploaded. */
    const ref = "artifact-ids: ${{ needs.macos.outputs.unsigned-id || '0' }}";
    for (const typo of [
      text.replace(ref, "artifact-ids: ${{ needs.macos.outputs.unsigned-ld || '0' }}"),
      text.replace("unsigned-id: ${{ steps.unsigned.outputs.artifact-id }}", "unsigned-id: ${{ steps.unsinged.outputs.artifact-id }}"),
      text.replace(/^( {6}- name: Upload the unsigned build for the signing job\n) {8}id: unsigned\n/m, "$1"),
    ]) {
      expect(typo).not.toBe(text);
      expect(by(transfers(typo), "download", UNSIGNED)).toEqual([]);
    }
    /* …and a download by name is read as one, which the fetch test refuses. */
    const byName = text.replace(ref, `name: ${UNSIGNED}`);
    expect(byName).not.toBe(text);
    expect(transfers(byName).filter((t) => t.kind === "download" && t.name === UNSIGNED).map((t) => t.byId)).toEqual([false]);
  });
});
