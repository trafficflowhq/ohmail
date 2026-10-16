import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE UPDATE KEYS TOUCH ONE STEP OF ONE JOB, AND THAT JOB RUNS NOTHING ELSE.
 *
 * `release-feeds.yml` holds the two private keys that sign every desktop update, and this is the
 * one job whose compromise is remote code execution on every install. It used to hold them across
 * one long step that also fetched the release assets, resolved a floating `@tauri-apps/cli@2` from
 * the registry and unpacked a curled Sparkle archive.
 *
 * The shape is now four JOBS: fence (marks the release a prerelease before anything can fail — a
 * write token, no key, no checkout), prepare (fetches, pins, stages — no secret), sign (the keys,
 * no checkout, no network, a read-only token), publish (writes and attaches — no key), and
 * refence (a hand promotion's read, which can only put the flag back — no key, no checkout). The
 * three that can rewrite a release hold no key, and the one that holds the keys can rewrite nothing.
 * None of that is visible to any other gate — nothing here runs GitHub Actions — so it is
 * asserted over the file.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PATH = publicRel("github/workflows/release-feeds.yml");
const wf = readFileSync(`${HERE}../${PATH}`, "utf8");
const signers = readFileSync(`${HERE}../scripts/fetch-pinned-signers.mjs`, "utf8");

/* Split on the job keys and the step bullets at their own indentation. A parser that silently
 * found fewer than the file has would make every assertion below vacuous, so both counts are
 * asserted first. */
type Step = { head: string; body: string };
type Job = { name: string; body: string; steps: Step[] };

function steps(jobBody: string): Step[] {
  const out: Step[] = [];
  let cur: string[] | null = null;
  for (const line of jobBody.split("\n")) {
    if (/^ {6}- (name|uses):/.test(line)) {
      if (cur) out.push({ head: cur[0], body: cur.join("\n") });
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push({ head: cur[0], body: cur.join("\n") });
  return out;
}

function jobs(text: string): Job[] {
  const from = text.indexOf("\njobs:");
  const lines = text.slice(from).split("\n");
  const out: Job[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const key = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (key) {
      if (cur) out.push({ name: cur.name, body: cur.lines.join("\n"), steps: steps(cur.lines.join("\n")) });
      cur = { name: key[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ name: cur.name, body: cur.lines.join("\n"), steps: steps(cur.lines.join("\n")) });
  return out;
}

// Fetching, in any spelling this file has ever used.
const NETWORK = [/\bcurl\b/, /\bwget\b/, /\bnpx\b/, /\bnpm \b/, /\bpnpm \b/, /\bgh release\b/, /\bgh api\b/];
const KEY_ENV = /^\s+([A-Z0-9_]*(?:PRIVATE_KEY|SIGNING_KEY)[A-Z0-9_]*):/gm;

const all = jobs(wf);
const byName = (n: string) => all.find((j) => j.name === n)!;

describe("the release signing job is isolated", () => {
  it("reads all five jobs and every step in them", () => {
    expect(all.map((j) => j.name)).toEqual(["fence", "prepare", "sign", "publish", "refence"]);
    // refence: one step, run only on a hand promotion. It reads the feeds and may put the flag back.
    expect(byName("refence").steps.length).toBe(1);
    expect(byName("refence").body).toMatch(/^ {4}needs: fence$/m);
    // fence: one step, and it is the whole job. It holds the write scope, so anything else
    // running beside it runs beside a token that can rewrite a release.
    expect(byName("fence").steps.length).toBe(1);
    // prepare: two checkouts, setup-node, the one long step, two uploads.
    expect(byName("prepare").steps.length).toBe(6);
    // sign: setup-node, download, check, sign, upload. No checkout — asserted below.
    expect(byName("sign").steps.length).toBe(5);
    // publish: checkout, setup-node, two downloads, the feeds step, the read-back, the
    // promotion, the summary.
    expect(byName("publish").steps.length).toBe(8);
    expect(byName("prepare").body).toMatch(/^ {4}needs: fence$/m);
    expect(byName("sign").body).toMatch(/^ {4}needs: prepare$/m);
    expect(byName("publish").body).toMatch(/^ {4}needs: \[fence, prepare, sign\]$/m);
  });

  it("lets no job hold both a key and a token that can rewrite the release", () => {
    /* A token that can rewrite a release, sitting on the runner that holds the signing keys, is
     * the second credential this split exists to separate from the first. That is the invariant,
     * and it is asserted as one rather than as a list of job names: two jobs carry
     * `contents: write` — the fence, which must mark the release a prerelease before anything
     * that can fail, and publish, which attaches the feeds — and NEITHER may ever hold a key. */
    const write = all.filter((j) => /^ {6}contents: write$/m.test(j.body));
    const keyed = all.filter((j) => [...j.body.matchAll(KEY_ENV)].length > 0);
    expect(write.map((j) => j.name)).toEqual(["fence", "publish", "refence"]);
    expect(keyed.map((j) => j.name)).toEqual(["sign"]);
    expect(write.filter((j) => keyed.includes(j)).map((j) => j.name)).toEqual([]);
    expect(byName("sign").body, "the signing job's token is not read-only").toMatch(/^ {6}contents: read$/m);
    expect(wf, "the workflow-level default is not read-only").toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("runs nothing of this repository beside the write scope before the feeds exist", () => {
    /* The fence holds the write token before anything else starts, so it is held to the rule the
     * signing job is held to: no checkout, and nothing fetched or resolved. Its whole job is two
     * `gh` calls against the release page. */
    const fence = byName("fence");
    expect(fence.steps.filter((s) => s.head.includes("actions/checkout"))).toEqual([]);
    expect([...fence.body.matchAll(KEY_ENV)]).toEqual([]);
    for (const re of NETWORK) {
      if (re.source === "\\bgh release\\b") continue; // its two calls ARE gh release
      expect(re.test(fence.body), `the fence job runs ${re.source}`).toBe(false);
    }
    expect(fence.body, "the fence's verdict does not reach the job that promotes")
      .toMatch(/^ {4}outputs:\n {6}fence: \$\{\{ steps\.fence\.outputs\.fence \}\}$/m);
    expect(byName("publish").body, "the promotion reads a step output across a job boundary, which is empty")
      .toMatch(/FENCE: \$\{\{ needs\.fence\.outputs\.fence \}\}/);
  });

  it("holds the hand-promotion job to the fence's rule: no checkout, no key, no install", () => {
    /* It carries the write scope to put the prerelease flag back, so nothing of this repository
     * runs beside it. Its network is the release's own public addresses, read with curl, and two
     * `gh release` calls against the page; nothing is installed or resolved. */
    const refence = byName("refence");
    expect(refence.steps.filter((s) => s.head.includes("actions/checkout"))).toEqual([]);
    expect([...refence.body.matchAll(KEY_ENV)]).toEqual([]);
    for (const re of NETWORK) {
      if (re.source === "\\bgh release\\b" || re.source === "\\bcurl\\b") continue;
      expect(re.test(refence.body), `the refence job runs ${re.source}`).toBe(false);
    }
    expect(refence.body).toMatch(/^ {4}if: github\.event_name == 'release' && github\.event\.action == 'released'$/m);
  });

  it("puts the private keys in exactly one step of exactly one job", () => {
    const holders = all.flatMap((j) => j.steps.filter((s) => [...s.body.matchAll(KEY_ENV)].length > 0)
      .map((s) => `${j.name}: ${s.head.trim()}`));
    expect(holders).toEqual(["sign: - name: Sign the artifacts"]);
    // All three of them, so a key quietly moving to another step is a failure here.
    const step = byName("sign").steps.find((s) => s.head.includes("Sign the artifacts"))!;
    const named = [...step.body.matchAll(KEY_ENV)].map((m) => m[1]).sort();
    expect(named).toEqual([
      "OHMAIL_SPARKLE_ED_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]);
  });

  it("…and that job checks out nothing and fetches nothing", () => {
    /* No checkout: no source of this repository — and none of its dependencies — executes on the
     * runner that holds the keys. The two signers are the only code that runs there, and they
     * arrive as bytes the prepare job pinned. */
    const sign = byName("sign");
    expect(sign.steps.filter((s) => s.head.includes("actions/checkout"))).toEqual([]);
    for (const st of sign.steps) {
      for (const re of NETWORK) {
        expect(re.test(st.body), `the signing job runs ${re.source} in ${st.head.trim()}`).toBe(false);
      }
    }
    // It runs the binaries the prepare job pinned, read from that job's own manifest.
    expect(sign.body).toContain("signers/signers.json");
  });

  it("checks every byte it was handed before a key is in any environment", () => {
    /* The keys arrive on a runner that received an artifact, so the artifact is the new door: a
     * signer whose bytes changed between the two jobs would run with the keys. The step before
     * the key step hashes every file against the list the prepare job wrote, and asserts the
     * COUNT in both directions — `--check` reads the list, so it cannot see a file that was
     * ADDED. Both were watched refuse against a mutated artifact. */
    const sign = byName("sign");
    const at = (needle: string) => sign.steps.findIndex((s) => s.body.includes(needle));
    const check = at("inputs.sha256");
    const signing = at("TAURI_SIGNING_PRIVATE_KEY:");
    expect(check, "nothing checks the artifact's bytes").toBeGreaterThanOrEqual(0);
    expect(check, "the check runs after the keys are on the runner").toBeLessThan(signing);
    const body = sign.steps[check].body;
    /* `--quiet` and not `> /dev/null`: a refusal has to name the file that failed, and the first
       version of this line threw that away. Read off the COMMAND — a needle that would also match
       the comment explaining it measures the comment. */
    expect(body, "the check discards the line naming what failed")
      .toMatch(/shasum -a 256 --check --quiet inputs\.sha256/);
    expect(body, "the check's own output goes to /dev/null").not.toMatch(/--check[^\n]*\/dev\/null/);
    /* THE GATE PINS CONTENT, NOT A COUNT, since "the signing gate pins what the inputs contain,
       not how many there are" (2026-09-13). `WANT` and `GOT` still appear in the step, but only to
       PRINT how many paths carry pinned bytes: `upload-artifact` resolves a macOS framework's
       symlinks, so the tree arriving carries the same bytes at more paths than the list has lines,
       and the count form refused a shape every byte of was already pinned. What must hold is that
       a file whose CONTENT nothing pinned refuses the job. */
    expect(body, "nothing computes the inputs whose content no pinned hash covers")
      .toMatch(/comm -23 - pinned\.hashes/);
    expect(body, "an input carrying unpinned content does not refuse the job")
      .toMatch(/carry content no pinned hash accounts for/);
    /* The negative control, and the distinction is the whole fix: a count used as a GATE is what
       was removed; a count used as a MESSAGE (`if [ "$GOT" != "$WANT" ]` … echo) is what stands. */
    expect(body, "the count is a gate again — a resolved symlink would refuse a correct artifact")
      .not.toMatch(/test "\$WANT" = "\$GOT"/);
    expect(sign.steps[check].body).not.toMatch(KEY_ENV);
  });

  it("pins both signers in a job that holds no key", () => {
    const prepare = byName("prepare");
    const fetching = prepare.steps.find((s) => s.body.includes("fetch-pinned-signers.mjs"))!;
    expect(fetching.head).toContain("Resolve the assets, pin the signers");
    expect([...prepare.body.matchAll(KEY_ENV)]).toEqual([]);
    expect(fetching.body).toContain("node .tools/scripts/fetch-pinned-signers.mjs");
  });

  it("hands the payloads over as named artifacts, and only those", () => {
    /* Three runners, so every value and every byte crosses on something named. An upload without
     * its download is a job reading a file that is not there — and it fails at the one moment
     * that matters, on a tag. */
    const uploads = [...wf.matchAll(/upload-artifact@[0-9a-f]+ # v4\n\s+with:\n\s+name: (\S+)/g)].map((m) => m[1]);
    const downloads = [...wf.matchAll(/download-artifact@[0-9a-f]+ # v4\n\s+with:\n\s+name: (\S+)/g)].map((m) => m[1]);
    expect(uploads.sort()).toEqual([
      "ohmail-desktop-release-metadata", "ohmail-desktop-signatures", "ohmail-desktop-signing-input",
    ]);
    for (const name of uploads) expect(downloads, `${name} is uploaded and never fetched`).toContain(name);
    for (const name of downloads) expect(uploads, `${name} is fetched and never uploaded`).toContain(name);
  });

  it("keeps every key value off the argument list", () => {
    /* An argument list is readable out of `ps` by any other process on the runner, so a key or a
     * password passed as a VALUE there is disclosed however carefully it was stored. Both signers
     * take a path; the password goes through the environment. Checked as a rule over the whole
     * file rather than as three string matches, because the first version of this step passed the
     * password as `--password "$…PASSWORD"` and read as correct beside two other flags that were. */
    expect(wf).toContain('--private-key-path "$TAURI_KEY_FILE"');
    expect(wf).toContain('--ed-key-file "$EDKEY_FILE"');
    expect(wf).toContain('TAURI_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"');

    const SECRETS = /\$\{?(TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD|OHMAIL_SPARKLE_ED_PRIVATE_KEY)\b/;
    const onArgv: string[] = [];
    for (const line of wf.split("\n")) {
      // A shell VARIABLE ASSIGNMENT or a redirect into a file is how a secret is allowed to move;
      // anything else that expands one on a command line hands it to a process as an argument.
      const expands = SECRETS.test(line);
      if (!expands) continue;
      const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line.trimStart());
      const intoFile = /printf\s+%s\s+"\$[A-Za-z_]+"\s*>/.test(line);
      const presence = /test -n "\$\{[A-Z_]+:-\}"/.test(line);
      const yamlEnv = /^\s{2,}[A-Z_]+:\s*\$\{\{\s*secrets\./.test(line);
      const comment = /^\s*#/.test(line);
      if (assignment || intoFile || presence || yamlEnv || comment) continue;
      onArgv.push(line.trim());
    }
    expect(onArgv, `these lines expand a secret onto a command line: ${onArgv.join(" | ")}`)
      .toEqual([]);
  });

  it("hands every value the later steps read across the step and job boundaries", () => {
    /* Splitting one step into three jobs turned every shared value into something that has to be
     * EXPORTED, and a miss is invisible until the one moment it matters: under `set -u` an unbound
     * variable inside a refusal path kills the step with "unbound variable" instead of printing
     * what was wrong. Two were found this way when the steps split — `ARM_FROM`, read by the step
     * that refuses an arm64 artifact on an old release, and a renamed `MAC_ZIP` still sitting in
     * an error message.
     *
     * The exported set is per JOB, because a runner is: a value another job put in `$GITHUB_ENV`
     * is not there, and the only channel between jobs is an artifact.
     *
     * Scoped to SHELL-STYLE UPPERCASE names on purpose: jq's `--arg` values are referenced as
     * `$lower_case` inside the jq program and are not shell variables at all. */
    /* `RANDOM` is bash's own, not a value any step could hand over: the feed read-back builds a
     * cache-buster from it. The rest are the runner's. */
    const SHELL_GIVENS = new Set([
      "GITHUB_ENV", "GITHUB_REPOSITORY", "GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "HOME", "PATH",
      "RANDOM",
    ]);
    const missing: string[] = [];
    let runSteps = 0;

    for (const job of all) {
      const exported = new Set<string>();
      for (const st of job.steps.filter((s) => /^\s+run: \|/m.test(s.body))) {
        runSteps++;
        const body = st.body;
        const env = new Set([...body.matchAll(/^\s{8,}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]));
        // Assigned here: at the start of a line, after `then`/`else`/`;`, or as a command prefix.
        const assigned = new Set([
          ...[...body.matchAll(/(?:^|then|else|;|&&|\|\|)\s*(?:local\s+)?([A-Z][A-Z0-9_]*)=/gm)]
            .map((m) => m[1]),
          ...[...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)=\S*\s*\\\s*$/gm)].map((m) => m[1]),
          ...[...body.matchAll(/\bfor\s+([A-Z][A-Z0-9_]*)\s+in\b/g)].map((m) => m[1]),
          ...[...body.matchAll(/^\s*local ([A-Z][A-Z0-9_]*)$/gm)].map((m) => m[1]),
        ]);
        const used = new Set([...body.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
        for (const u of used) {
          if (assigned.has(u) || env.has(u) || exported.has(u) || SHELL_GIVENS.has(u)) continue;
          missing.push(`${job.name}/${st.head.trim().replace("- name: ", "")}: $${u}`);
        }
        for (const m of body.matchAll(/echo\s+"([A-Z][A-Z0-9_]*)=/g)) exported.add(m[1]);
      }
    }

    expect(runSteps, "the file has no run: steps to check").toBeGreaterThanOrEqual(5);
    expect(missing, `read but never handed over: ${missing.join(", ")}`).toEqual([]);
  });

  it("names Sparkle's signer by path, because three files carry that name", () => {
    // `bin/sign_update`, the retired `bin/old_dsa_scripts/sign_update` (an executable shell
    // script that signs with DSA) and a debug-symbol copy. `find … | head -1` is directory order.
    expect(wf).not.toMatch(/find\s+sparkle[^\n]*-name\s+sign_update/);
    expect(signers).toContain('join(sparkleDir, "bin", "sign_update")');
    /* RELATIVE paths, because the job that signs is not the job that fetched: it unpacks the
     * artifact where it likes, and an absolute path from another runner names nothing. */
    expect(signers).toContain("tauriSignerRel: relative(outDir, tauriSigner)");
    expect(signers).toContain("signUpdateRel: relative(outDir, signUpdate)");
  });

  it("pins by bytes, not by version alone, and reads no file the mirror lacks", () => {
    // The Tauri half against the sha512 npm publishes for that exact tarball, Sparkle twice: the
    // archive, and the binary taken out of it.
    expect(signers).toMatch(/archiveSha256: "[0-9a-f]{64}"/);
    expect(signers).toMatch(/signUpdateSha256: "[0-9a-f]{64}"/);
    expect(signers).toMatch(/integrity: "sha512-[A-Za-z0-9+/=]+"/);
    // A mismatching pin refuses; it never warns and carries on.
    expect(signers).toContain("does not match its pin");
    /* THE 0.16.2 INCIDENT, as a rule rather than a memory: this step read the monorepo's
     * `pnpm-lock.yaml` for the Tauri integrity, the published repository carries no lockfile, and
     * the release died with ENOENT on a tag that could not be moved. Every pin is now written in
     * this file, so the step reads nothing but itself. A needle on the comment that says so would
     * measure the comment; this reads the code. */
    const code = signers.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code, "the signer pinning reads a lockfile again").not.toMatch(/pnpm-lock\.yaml/);
  });
});
