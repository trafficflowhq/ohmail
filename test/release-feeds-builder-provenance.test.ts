import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { ANDROID_ASSETS, INSTALLERS, androidReleaseKey } from "../scripts/verify-assets-against-builder.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * WHAT IS SIGNED IS WHAT WAS BUILT.
 *
 * The feeds job used to take its payloads off the release page and sign them. Every check it then
 * ran read those same bytes — the checksums, the signatures and the publish job's verification all
 * agree with whatever was attached, so a canonical installer swapped for another build is hashed,
 * signed and fed to installed clients with every gate green. The block below measures that
 * self-consistency directly; the rest of this file measures the link that breaks it, the builder's
 * own artifact digest read from the Actions API.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF = publicPath("github/workflows/release-feeds.yml");
const wfText = readFileSync(WF, "utf8");

/**
 * The workflow's own lines, as the shell the runner would execute. The COUNT is asserted rather
 * than a first match taken: the checksum check appears twice on purpose — once where the file is
 * made and once in the publish job over an independent download — and a test that silently read
 * one of them would stop measuring the moment the other moved.
 */
function wfLines(needle: string, expected: number): string[] {
  const hit = wfText.split("\n").filter((l) => l.includes(needle));
  expect(hit, `release-feeds.yml no longer carries ${expected} line(s) containing ${needle}`).toHaveLength(expected);
  return hit.map((l) => `${l.trim()}\n`);
}

describe("the chain that proves nothing: every check reads the bytes that were attached", () => {
  it("hashes, checks and re-checks a replaced installer without a complaint", () => {
    // The fixture: the build produced BUILT; the release page carries TAMPERED under the same
    // canonical name. Nothing below can tell them apart, because nothing below has ever seen BUILT.
    const dir = mkdtempSync(join(tmpdir(), "ohmail-builder-red-"));
    writeFileSync(join(dir, "built.AppImage"), "BUILT — the bytes the build job produced\n");
    const assets = join(dir, "assets");
    spawnSync("mkdir", ["-p", assets]);
    writeFileSync(join(assets, "ohmail-linux-x86_64.AppImage"), "TAMPERED — another build entirely\n");

    // The prepare job's checksum line and the publish job's check of it, taken from the workflow.
    const make = wfLines("shasum -a 256 -- * > ../SHA256SUMS", 1)[0];
    // The publish job's check — the second of the two, run over assets downloaded a second time.
    const check = wfLines("shasum -a 256 --check ../SHA256SUMS", 2)[1];
    const p = spawnSync("bash", ["-c", `set -euo pipefail\n${make}${check}`], { cwd: dir, encoding: "utf8" });
    expect(p.status, "the release's own checks refused the replacement").toBe(0);
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toContain("ohmail-linux-x86_64.AppImage");
    // …and it is the TAMPERED bytes it attests to, which is the whole defect: the file that the
    // download page offers as the way to check the installer was made from the installer.
    const sum = spawnSync("shasum", ["-a", "256", join(assets, "ohmail-linux-x86_64.AppImage")], { encoding: "utf8" });
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toContain(sum.stdout.split(" ")[0]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE LINK THAT BREAKS IT: the builder's own digest, read from the Actions API.
 *
 * Nothing below runs GitHub Actions. The script is executed as the workflow executes it, against
 * a `gh` stub that answers the three endpoints the real one answers — the build workflow's runs
 * at a commit, a run's artifacts with their recorded digests, and an artifact's archive — so the
 * refusals are measured on the script rather than asserted about it.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
const SCRIPT = `${HERE}../scripts/verify-assets-against-builder.mjs`;
const REPO = "trafficflowhq/ohmail";
const COMMIT = "0".repeat(39) + "1";
const RUN = { id: 4001, run_number: 77 };

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$2" >> "$STUB/gh.log"
case "$2" in
  *"/actions/workflows/android.yml/runs?"*)
    cat "$STUB/android-runs.json" ;;
  *"/actions/workflows/"*"/runs?"*)
    if [ -n "\${GH_STUB_RUNS_FAIL:-}" ]; then echo "gh: HTTP 403 Resource not accessible by integration" >&2; exit 1; fi
    cat "$STUB/runs.json" ;;
  *"/actions/runs/"*"/artifacts?"*)
    if [ -n "\${GH_STUB_ARTIFACTS_FAIL:-}" ]; then echo "gh: HTTP 403 Resource not accessible by integration" >&2; exit 1; fi
    rest=\${2#*/actions/runs/}; cat "$STUB/artifacts-\${rest%%/*}.json" ;;
  *"/actions/artifacts/"*"/zip")
    rest=\${2#*/actions/artifacts/}; cat "$STUB/zip-\${rest%%/*}.zip" ;;
  *) echo "gh stub: no arm for $2" >&2; exit 1 ;;
esac
exit 0
`;

type Built = { asset: string; artifact: string; id: number; built: string; attached?: string; expired?: boolean; digest?: string | null };

type BuilderWorld = {
  /** One entry per installer on the release page. `attached` defaults to `built`. */
  files: Built[];
  /** Runs the build workflow reports at this commit. Absent = the one run above. */
  runs?: Record<string, unknown>[];
  /** Assets on the page that no run built — a stranger. */
  extraAssets?: Record<string, string>;
  env?: Record<string, string>;
  /** Run a copy of the script with one line removed — the mutation that makes a control a control. */
  without?: RegExp;
  /** The Android files on the page, the android workflow's runs, and the android.yml the key is read from. */
  android?: { files: AndroidFile[]; runs?: Record<string, unknown>[]; workflow?: string };
  /** The release tag handed to `--tag`; absent, the flag is not passed. */
  tag?: string;
};

type AndroidFile = { asset: string; artifact: string; id: number; inner: string; built: Buffer; attached?: Buffer; expired?: boolean };

function builderRun(world: BuilderWorld): { code: number; out: string; err: string; ghLog: string; zipSha: Record<number, string> } {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-builder-"));
  const bin = join(dir, "bin");
  const assets = join(dir, "assets");
  for (const d of [bin, assets]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(dir, "gh.log"), "");

  // The archive the builder uploaded: the installer, at the archive root under its own name. Its
  // digest is the sha256 of THE ARCHIVE, which is what the Actions API records — the file's own
  // hash would have made the fixture disagree with the thing under test for the wrong reason.
  const zipSha: Record<number, string> = {};
  for (const f of world.files) {
    const stage = join(dir, `stage-${f.id}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, f.asset), f.built);
    const zipPath = join(dir, `zip-${f.id}.zip`);
    const z = spawnSync("zip", ["-j", "-q", zipPath, join(stage, f.asset)]);
    expect(z.status, "the fixture archive did not build").toBe(0);
    zipSha[f.id] = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    writeFileSync(join(assets, f.asset), f.attached ?? f.built);
  }
  const artifacts = world.files.map((f) => ({
    id: f.id,
    name: f.artifact,
    expired: f.expired ?? false,
    size_in_bytes: f.built.length,
    ...(f.digest === null ? {} : { digest: f.digest ?? `sha256:${zipSha[f.id]}` }),
  }));
  for (const [name, body] of Object.entries(world.extraAssets ?? {})) writeFileSync(join(assets, name), body);
  writeFileSync(join(dir, `artifacts-${RUN.id}.json`), JSON.stringify({ artifacts }));
  // Every other run named gets the same archives under ITS run number, so only the filter can refuse it.
  for (const run of (world.runs ?? []) as { id: number; run_number: number }[]) {
    if (run.id === RUN.id) continue;
    const renamed = artifacts.map((a) => ({ ...a, name: a.name.replace(/-\d+$/, `-${run.run_number}`) }));
    writeFileSync(join(dir, `artifacts-${run.id}.json`), JSON.stringify({ artifacts: renamed }));
  }
  writeFileSync(
    join(dir, "runs.json"),
    JSON.stringify({
      workflow_runs: world.runs ?? [{ id: RUN.id, run_number: RUN.run_number, name: "build", head_sha: COMMIT, event: "push", head_repository: { full_name: REPO }, conclusion: "success" }],
    }),
  );

  // The android run's artifacts: each holds its inner file at the archive root, as upload-artifact
  // writes a single path. The runs list carries a main-branch run of the same commit, which builds a
  // debug APK and must never be read.
  const androidArtifacts = (world.android?.files ?? []).map((f) => {
    const stage = join(dir, `stage-${f.id}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, f.inner), f.built);
    const zipPath = join(dir, `zip-${f.id}.zip`);
    expect(spawnSync("zip", ["-j", "-q", zipPath, join(stage, f.inner)]).status, "the fixture archive did not build").toBe(0);
    writeFileSync(join(assets, f.asset), f.attached ?? f.built);
    return { id: f.id, name: f.artifact, expired: f.expired ?? false, digest: `sha256:${createHash("sha256").update(readFileSync(zipPath)).digest("hex")}` };
  });
  writeFileSync(join(dir, `artifacts-${ANDROID_RUN.id}.json`), JSON.stringify({ artifacts: androidArtifacts }));
  writeFileSync(join(dir, "android-runs.json"), JSON.stringify({ workflow_runs: world.android?.runs ?? [ANDROID_RUN, ANDROID_MAIN_RUN] }));
  const androidWorkflow = join(dir, "android.yml");
  writeFileSync(androidWorkflow, world.android?.workflow ?? ANDROID_WORKFLOW_FIXTURE);

  let script = SCRIPT;
  if (world.without) {
    const text = readFileSync(SCRIPT, "utf8");
    const cut = text.replace(world.without, "");
    expect(cut, `the mutation ${world.without} matched nothing — the control measures the wrong line`).not.toBe(text);
    script = join(dir, "mutated.mjs");
    writeFileSync(script, cut);
  }

  // node by its own path, so PATH can be emptied to measure the tool assertions without also
  // taking away the interpreter — an arm that cannot start the subject measures nothing.
  const tagArgs = world.tag === undefined ? [] : ["--tag", world.tag];
  const p = spawnSync(process.execPath, [script, assets, "--repo", REPO, "--commit", COMMIT, ...tagArgs, "--work", join(dir, "work"), "--android-workflow", androidWorkflow], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB: dir, ...(world.env ?? {}) },
  });
  return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "", ghLog: readFileSync(join(dir, "gh.log"), "utf8"), zipSha };
}

function sha256Of(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const APPIMAGE: Built = {
  asset: "ohmail-linux-x86_64.AppImage",
  artifact: `ohmail-appimage-${RUN.run_number}`,
  id: 9001,
  built: "BUILT — the AppImage the Linux job produced\n",
};
const WINDOWS: Built = {
  asset: "ohmail-windows-setup.exe",
  artifact: `ohmail-windows-${RUN.run_number}`,
  id: 9002,
  built: "BUILT — the setup.exe the Windows job produced\n",
};

/* ── THE ANDROID HALF ─────────────────────────────────────────────────────────────────────────
 * The APK a page carries is RE-SIGNED after its build, so it is never the artifact's bytes. The
 * fixtures below have the structure measured on the v0.25.2 release: the built APK carries a v2
 * block with a debug key and no v1 files, and the released one the same entries plus three v1
 * signature files and a v2 and a v3 block, each with one signer, the release key. */
const ANDROID_RUN = { id: 5001, run_number: 192, name: "android", head_sha: COMMIT, head_branch: "android-v9.9.9", event: "push", head_repository: { full_name: REPO }, conclusion: "success" };
const ANDROID_MAIN_RUN = { id: 5002, run_number: 191, name: "android", head_sha: COMMIT, head_branch: "main", event: "push", head_repository: { full_name: REPO }, conclusion: "success" };
/* The desktop pair: the build run at the release tag, and a push to main of the same commit — the NEWER
 * of the two here, so the order alone would pick it and only the tag filter can refuse it. */
const BUILD_TAG_RUN = { id: RUN.id, run_number: RUN.run_number, name: "build", head_sha: COMMIT, head_branch: "v9.9.9", event: "push", head_repository: { full_name: REPO }, conclusion: "success" };
const BUILD_MAIN_RUN = { id: 4002, run_number: 78, name: "build", head_sha: COMMIT, head_branch: "main", event: "push", head_repository: { full_name: REPO }, conclusion: "success" };
/* A pull request from a fork, on a branch the fork named like the tag, at the tagged commit: the run
 * the review drove past the gate. Its id is the tag run's, so its artifacts are there to be signed. */
const BUILD_FORK_PR_RUN = { ...BUILD_TAG_RUN, event: "pull_request", head_repository: { full_name: "attacker/ohmail" } };
const RELEASE_CERT = Buffer.from("fixture release certificate, DER in the real one\n");
const DEBUG_CERT = Buffer.from("fixture debug certificate\n");
const RELEASE_KEY = createHash("sha256").update(RELEASE_CERT).digest("hex");
const ANDROID_WORKFLOW_FIXTURE =
  `jobs:\n  sign:\n    steps:\n      - name: a\n        env:\n          EXPECTED_CERT_SHA256: "${RELEASE_KEY}"\n` +
  `      - name: b\n        env:\n          EXPECTED_CERT_SHA256: "${RELEASE_KEY}"\n`;

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const lp = (b: Buffer) => Buffer.concat([u32(b.length), b]);
const seqOf = (items: Buffer[]) => lp(Buffer.concat(items.map(lp)));
/** One scheme block's value: signers, each signing data carrying its certificate first. */
function schemeValue(certs: Buffer[], v3 = false): Buffer {
  const signers = certs.map((cert) => {
    const signedData = Buffer.concat([seqOf([]), seqOf([cert]), ...(v3 ? [u32(24), u32(0x7fffffff)] : []), seqOf([])]);
    return Buffer.concat([lp(signedData), seqOf([]), lp(Buffer.from("public key"))]);
  });
  return seqOf(signers);
}
/** A zip with an APK signing block spliced in front of its central directory, as apksigner writes it. */
function withSigningBlock(zip: Buffer, pairs: [number, Buffer][]): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const cd = zip.readUInt32LE(eocd + 16);
  const body = Buffer.concat(pairs.map(([id, v]) => Buffer.concat([u64(4 + v.length), u32(id), v])));
  const size = body.length + 8 + 16;
  const block = Buffer.concat([u64(size), body, u64(size), Buffer.from("APK Sig Block 42", "latin1")]);
  const out = Buffer.concat([zip.subarray(0, cd), block, zip.subarray(cd)]);
  out.writeUInt32LE(cd + block.length, eocd + block.length + 16);
  return out;
}
const SCHEME_V2_ID = 0x7109871a;
const SCHEME_V3_ID = 0xf05368c0;
/** The zip of a tree of entries, built by the zip tool so its central directory is a real one. */
function zipOf(entries: Record<string, string>): Buffer {
  const d = mkdtempSync(join(tmpdir(), "ohmail-apk-"));
  for (const [n, b] of Object.entries(entries)) {
    mkdirSync(join(d, n, ".."), { recursive: true });
    writeFileSync(join(d, n), b);
  }
  const out = join(d, "out.zip");
  expect(spawnSync("zip", ["-q", "-X", "-r", out, ...Object.keys(entries)], { cwd: d }).status, "the fixture APK did not zip").toBe(0);
  return readFileSync(out);
}
const APP_ENTRIES = { "AndroidManifest.xml": "<manifest/>\n", "classes.dex": "dex bytes\n", "res/drawable/icon.png": "png\n" };
const V1_FILES = { "META-INF/OHMAIL-R.SF": "sf\n", "META-INF/OHMAIL-R.RSA": "rsa\n", "META-INF/MANIFEST.MF": "mf\n" };
const BUILT_APK = withSigningBlock(zipOf(APP_ENTRIES), [[SCHEME_V2_ID, schemeValue([DEBUG_CERT])]]);
const released = (entries: Record<string, string> = APP_ENTRIES, pairs: [number, Buffer][] = [[SCHEME_V2_ID, schemeValue([RELEASE_CERT])], [SCHEME_V3_ID, schemeValue([RELEASE_CERT], true)]]) =>
  withSigningBlock(zipOf({ ...entries, ...V1_FILES }), pairs);
const MAPPING = Buffer.from("gzip bytes of the shrinker mapping\n");
const APK_FILE: AndroidFile = { asset: "ohmail-android.apk", artifact: "ohmail-android-unsigned", id: 9101, inner: "app-release.apk", built: BUILT_APK, attached: released() };
const MAPPING_FILE: AndroidFile = { asset: "ohmail-android-mapping.txt.gz", artifact: "ohmail-android-mapping", id: 9102, inner: "ohmail-android-mapping.txt.gz", built: MAPPING };
const ANDROID_OK = { files: [APK_FILE, MAPPING_FILE] };

describe("the builder check", () => {
  it("CONTROL 2 · admits assets that are byte for byte what the build produced", () => {
    const r = builderRun({ files: [APPIMAGE, WINDOWS] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`BUILDER-VERIFIED 2 asset(s) of ${COMMIT} against build run ${RUN.id}`);
    expect(r.out).toContain(APPIMAGE.asset);
    expect(r.out).toContain(WINDOWS.asset);
    // The builder's digest was asked for, and the archive was taken from the API, not the page.
    expect(r.ghLog).toContain(`/actions/workflows/build.yml/runs?head_sha=${COMMIT}`);
    expect(r.ghLog).toContain(`/actions/runs/${RUN.id}/artifacts`);
    expect(r.ghLog).toContain(`/actions/artifacts/${APPIMAGE.id}/zip`);
  });

  it("CONTROL 1 · refuses an attached installer that is not the one the build produced, by name", () => {
    const tampered = "TAMPERED — another build entirely\n";
    const r = builderRun({ files: [{ ...APPIMAGE, attached: tampered }, WINDOWS] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-ASSET-MISMATCH ${APPIMAGE.asset}`);
    expect(r.err).toContain(`the build produced  sha256:${sha256Of(APPIMAGE.built)}`);
    expect(r.err).toContain(`the release carries sha256:${sha256Of(tampered)}`);
    expect(r.err).toContain(APPIMAGE.artifact);
    expect(r.out).not.toContain("BUILDER-VERIFIED");
  });

  it("CONTROL 1 · mutation: take the comparison away and the replacement is signed — today's behaviour", () => {
    // The line that DECIDES, removed from a copy. Without it the same fixture is admitted, which
    // is precisely what the workflow did before this script existed.
    const r = builderRun({
      files: [{ ...APPIMAGE, attached: "TAMPERED — another build entirely\n" }, WINDOWS],
      without: /\n {4}if \(built !== asset\.sha256\) \{[\s\S]*?\n {4}\}/,
    });
    expect(r.code, "the comparison was not what admitted it").toBe(0);
    expect(r.out).toContain("BUILDER-VERIFIED");
  });

  it("CONTROL 3 · refuses an archive whose bytes are not the digest the builder recorded", () => {
    const r = builderRun({ files: [{ ...APPIMAGE, digest: `sha256:${"0".repeat(64)}` }, WINDOWS] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-DIGEST-MISMATCH ${APPIMAGE.artifact}`);
    expect(r.err).toContain(`the builder published  sha256:${"0".repeat(64)}`);
    expect(r.err).toContain(`this run downloaded    sha256:${r.zipSha[APPIMAGE.id]}`);
  });

  it("CONTROL 4 · refuses an API answer it cannot read, rather than finding nothing to check", () => {
    for (const [why, env] of [
      ["the runs list", { GH_STUB_RUNS_FAIL: "1" }],
      ["the artifacts list", { GH_STUB_ARTIFACTS_FAIL: "1" }],
    ] as const) {
      const r = builderRun({ files: [APPIMAGE], env });
      expect(r.code, `${why} failed and the check passed`).not.toBe(0);
      expect(r.err).toContain("BUILDER-UNREADABLE");
      expect(r.err).toContain("403");
      expect(r.out).not.toContain("BUILDER-VERIFIED");
    }
  });

  it("refuses an artifact past its retention, naming it", () => {
    const r = builderRun({ files: [{ ...APPIMAGE, expired: true }, WINDOWS] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-ARTIFACT-EXPIRED ${APPIMAGE.artifact}`);
    expect(r.err).toContain("past its retention");
  });

  it("refuses an artifact the API recorded no digest for — the release would be vouching for itself", () => {
    const r = builderRun({ files: [{ ...APPIMAGE, digest: null }, WINDOWS] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-NO-DIGEST ${APPIMAGE.artifact}`);
  });

  it("refuses a commit no build run has as its head", () => {
    const r = builderRun({ files: [APPIMAGE], runs: [] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-NO-RUN ${COMMIT}`);
  });

  it("reads the installers against the build workflow's TAG run of the same commit, never the main push run", () => {
    // Both runs built this commit and both could account for the bytes; only the run at the tag is the release's.
    const r = builderRun({ files: [APPIMAGE, WINDOWS], runs: [BUILD_MAIN_RUN, BUILD_TAG_RUN], tag: "v9.9.9" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`BUILDER-VERIFIED 2 asset(s) of ${COMMIT} against build run ${BUILD_TAG_RUN.id} at v9.9.9`);
    expect(r.ghLog, "the main push run was asked for its artifacts").not.toContain(`/actions/runs/${BUILD_MAIN_RUN.id}/`);
  });

  it("refuses a commit whose only build run is a push to main, naming that run", () => {
    const r = builderRun({ files: [APPIMAGE], runs: [BUILD_MAIN_RUN], tag: "v9.9.9" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-NO-TAG-RUN ${COMMIT} v9.9.9`);
    expect(r.err).toContain(`run ${BUILD_MAIN_RUN.id} #${BUILD_MAIN_RUN.run_number} push main success`);
    expect(r.out).not.toContain("BUILDER-VERIFIED");
  });

  it("mutation: take the tag filter away and the main push run is admitted — today's behaviour", () => {
    const r = builderRun({
      files: [APPIMAGE],
      runs: [BUILD_MAIN_RUN, BUILD_TAG_RUN],
      tag: "v9.9.9",
      without: /\n {2}if \(tag\) mine = mine\.filter\(\(r\) => String\(r\.head_branch \?\? ""\) === tag\);/,
    });
    expect(r.code, "the tag filter was not what kept the main push run out").toBe(0);
    expect(r.out).toContain(`against build run ${BUILD_MAIN_RUN.id}`);
  });

  it("refuses a --tag given with no value rather than reading every run", () => {
    const r = builderRun({ files: [APPIMAGE], runs: [BUILD_TAG_RUN], tag: "" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-NO-TAG");
    expect(r.ghLog.trim(), "it asked the API with no tag to hold the runs to").toBe("");
  });

  it("refuses a fork's pull request run on a branch named like the tag, at the tagged commit, with or without --tag", () => {
    for (const tag of ["v9.9.9", undefined]) {
      const r = builderRun({ files: [APPIMAGE, WINDOWS], runs: [BUILD_FORK_PR_RUN], tag });
      expect(r.code, `tag ${tag}`).not.toBe(0);
      expect(r.err).toContain(`BUILDER-NO-RUN ${COMMIT}`);
      expect(r.err).toContain(`run ${RUN.id} #${RUN.run_number} pull_request v9.9.9 success from attacker/ohmail`);
      expect(r.out).not.toContain("BUILDER-VERIFIED");
      expect(r.ghLog, "the fork's run was asked for its artifacts").not.toContain(`/actions/runs/${RUN.id}/`);
    }
  });

  it("holds the event and the repository each on its own: a same-repository pull request, and a push from elsewhere, are refused", () => {
    for (const run of [
      { ...BUILD_TAG_RUN, event: "pull_request" },
      { ...BUILD_TAG_RUN, head_repository: { full_name: "attacker/ohmail" } },
      { ...BUILD_TAG_RUN, head_repository: undefined },
    ]) {
      const r = builderRun({ files: [APPIMAGE], runs: [run], tag: "v9.9.9" });
      expect(r.code, JSON.stringify(run)).not.toBe(0);
      expect(r.err).toContain(`BUILDER-NO-RUN ${COMMIT}`);
    }
  });

  it("admits a dispatch on the tag, the repository compared without regard to case", () => {
    const r = builderRun({ files: [APPIMAGE], runs: [{ ...BUILD_TAG_RUN, event: "workflow_dispatch", head_repository: { full_name: "TrafficFlowHQ/ohmail" } }], tag: "v9.9.9" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`BUILDER-VERIFIED 1 asset(s) of ${COMMIT} against build run ${RUN.id} at v9.9.9`);
  });

  it("mutation: take the started-here filter away and the fork's run is signed — what the review measured", () => {
    const r = builderRun({
      files: [APPIMAGE, WINDOWS],
      runs: [BUILD_FORK_PR_RUN],
      tag: "v9.9.9",
      without: /(?<=const own = atCommit)\.filter\(\(r\) => startedHere\(r, repo\)\)/,
    });
    expect(r.code, "the started-here filter was not what kept the fork's run out").toBe(0);
    expect(r.out).toContain(`BUILDER-VERIFIED 2 asset(s) of ${COMMIT} against build run ${RUN.id} at v9.9.9`);
  });

  it("refuses an asset no build artifact accounts for", () => {
    const r = builderRun({ files: [APPIMAGE], extraAssets: { "ohmail-linux-riscv64.AppImage": "from nowhere\n" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-NO-ARTIFACT-FOR-ASSET ohmail-linux-riscv64.AppImage");
    // It refuses before it asks the API anything: a stranger is not a question for the builder.
    expect(r.ghLog.trim()).toBe("");
  });

  it("reads the Android files against the android tag run of the same commit, by that run's id", () => {
    // v0.19.0 to v0.21.0 carry the APK and its mapping beside the desktop installers. They used to
    // be skipped by name; each is now the android run's own, or the page is refused.
    const r = builderRun({ files: [APPIMAGE], android: ANDROID_OK });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("BUILDER-VERIFIED 1 asset(s)");
    expect(r.out).toContain(`BUILDER-VERIFIED-ANDROID 2 asset(s) of ${COMMIT} against android run ${ANDROID_RUN.id} (android-v9.9.9)`);
    expect(r.out).toContain(`ohmail-android.apk · 3 entries as built (artifact ohmail-android-unsigned of run ${ANDROID_RUN.id}) · signed by the release key sha256:${RELEASE_KEY}`);
    expect(r.out).not.toContain("skipped ohmail-android");
    expect(r.ghLog).toContain(`/actions/workflows/android.yml/runs?head_sha=${COMMIT}`);
    expect(r.ghLog).toContain(`/actions/runs/${ANDROID_RUN.id}/artifacts`);
    // The main-branch run of the same commit builds a debug APK and is never asked.
    expect(r.ghLog).not.toContain(`/actions/runs/${ANDROID_MAIN_RUN.id}/`);
  });

  it("refuses an APK signed by any key but the release key, naming both", () => {
    const r = builderRun({ files: [APPIMAGE], android: { files: [{ ...APK_FILE, attached: released(APP_ENTRIES, [[SCHEME_V2_ID, schemeValue([DEBUG_CERT])]]) }, MAPPING_FILE] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-APK-NOT-THE-RELEASE-KEY ohmail-android.apk");
    expect(r.err).toContain(`sha256:${createHash("sha256").update(DEBUG_CERT).digest("hex")}`);
    expect(r.err).toContain(`the release key is sha256:${RELEASE_KEY}`);
    expect(r.out).not.toContain("BUILDER-VERIFIED-ANDROID");
  });

  it("refuses an APK whose v3 signature adds a second signer beside the release key", () => {
    const two = released(APP_ENTRIES, [[SCHEME_V2_ID, schemeValue([RELEASE_CERT])], [SCHEME_V3_ID, schemeValue([RELEASE_CERT, DEBUG_CERT], true)]]);
    const r = builderRun({ files: [APPIMAGE], android: { files: [{ ...APK_FILE, attached: two }, MAPPING_FILE] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("its v3 signature carries 2 signer(s)");
  });

  it("refuses an APK with an entry the build did not make, and one whose entry changed", () => {
    for (const [what, entries, first] of [
      ["an added entry", { ...APP_ENTRIES, "lib/arm64-v8a/libextra.so": "extra\n" }, "lib/arm64-v8a/libextra.so"],
      ["a changed entry", { ...APP_ENTRIES, "classes.dex": "other dex\n" }, "classes.dex"],
    ] as const) {
      const r = builderRun({ files: [APPIMAGE], android: { files: [{ ...APK_FILE, attached: released(entries) }, MAPPING_FILE] } });
      expect(r.code, what).not.toBe(0);
      expect(r.err).toContain(`BUILDER-APK-CONTENT-MISMATCH ohmail-android.apk: 1 entry differs from the build (artifact ohmail-android-unsigned of run ${ANDROID_RUN.id}), first ${first}`);
    }
  });

  it("refuses an APK that carries no signing block to read a key from", () => {
    const r = builderRun({ files: [APPIMAGE], android: { files: [{ ...APK_FILE, attached: zipOf({ ...APP_ENTRIES, ...V1_FILES }) }, MAPPING_FILE] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-APK-UNREADABLE ohmail-android.apk");
    expect(r.err).toContain("no APK signing block");
  });

  it("refuses a mapping that is not the one the android build uploaded", () => {
    const r = builderRun({ files: [APPIMAGE], android: { files: [APK_FILE, { ...MAPPING_FILE, attached: Buffer.from("another build's mapping\n") }] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-ASSET-MISMATCH ohmail-android-mapping.txt.gz");
    expect(r.err).toContain(`the build produced  sha256:${createHash("sha256").update(MAPPING).digest("hex")}`);
  });

  it("refuses a page whose commit has no android tag run, even with a main-branch run beside it", () => {
    const r = builderRun({ files: [APPIMAGE], android: { ...ANDROID_OK, runs: [ANDROID_MAIN_RUN] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-NO-ANDROID-RUN ${COMMIT}`);
  });

  it("refuses an android run from a fork's pull request on a branch named like an android tag, and admits it once the filter is cut", () => {
    const fork = { ...ANDROID_RUN, event: "pull_request", head_repository: { full_name: "attacker/ohmail" } };
    const r = builderRun({ files: [APPIMAGE], android: { ...ANDROID_OK, runs: [fork, ANDROID_MAIN_RUN] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-NO-ANDROID-RUN ${COMMIT}`);
    expect(r.ghLog).not.toContain(`/actions/runs/${ANDROID_RUN.id}/`);
    const cut = builderRun({ files: [APPIMAGE], android: { ...ANDROID_OK, runs: [fork, ANDROID_MAIN_RUN] }, without: /\n {4}\.filter\(\(r\) => startedHere\(r, repo\)\)/ });
    expect(cut.code, "the android started-here filter was not what kept the fork's run out").toBe(0);
    expect(cut.out).toContain(`BUILDER-VERIFIED-ANDROID 2 asset(s) of ${COMMIT} against android run ${ANDROID_RUN.id} (android-v9.9.9)`);
  });

  it("refuses an android artifact past its retention, naming it", () => {
    const r = builderRun({ files: [APPIMAGE], android: { files: [{ ...APK_FILE, expired: true }, MAPPING_FILE] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-ARTIFACT-EXPIRED ohmail-android-unsigned");
  });

  it("refuses before it asks the API anything when the release key cannot be read", () => {
    for (const workflow of ["jobs: {}\n", `${ANDROID_WORKFLOW_FIXTURE}          EXPECTED_CERT_SHA256: "${"0".repeat(64)}"\n`]) {
      const r = builderRun({ files: [APPIMAGE], android: { ...ANDROID_OK, workflow } });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("BUILDER-NO-ANDROID-KEY");
      expect(r.ghLog.trim(), "it asked the API with no key to hold the APK to").toBe("");
    }
  });

  it("CONTROL 5 · mutation: take the key comparison away and a debug-signed APK is admitted", () => {
    const r = builderRun({
      files: [APPIMAGE],
      android: { files: [{ ...APK_FILE, attached: released(APP_ENTRIES, [[SCHEME_V2_ID, schemeValue([DEBUG_CERT])]]) }, MAPPING_FILE] },
      without: /\n {4}if \(signers\.length !== 1 \|\| signers\[0\] !== releaseKey\) \{[\s\S]*?\n {4}\}/,
    });
    expect(r.code, "the key comparison was not what refused it").toBe(0);
    expect(r.out).toContain("BUILDER-VERIFIED-ANDROID");
  });

  it("looks up the artifact by its exact name, so an arm64 build cannot answer for an x86_64 asset", () => {
    // `ohmail-appimage-aarch64-77` starts with `ohmail-appimage-`. A prefix match would take it.
    const arm = { ...APPIMAGE, artifact: `ohmail-appimage-aarch64-${RUN.run_number}`, id: 9003 };
    const r = builderRun({ files: [arm] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`BUILDER-ARTIFACT-MISSING ohmail-appimage-${RUN.run_number}`);
  });

  it("names the tools it spawns before it starts", () => {
    const r = builderRun({ files: [APPIMAGE], env: { PATH: "" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BUILDER-TOOL-MISSING gh");
    expect(r.ghLog.trim(), "it went to the API before it knew it had a client").toBe("");
  });
});

describe("the table of installers is derived from the build workflow, not kept beside it", () => {
  const buildText = readFileSync(publicPath("github/workflows/build.yml"), "utf8").split("\n");

  /** Every upload step whose path is a file at the root of `build/` — one installer, one artifact. */
  function uploadedInstallers(): Record<string, string> {
    const found: Record<string, string> = {};
    for (let i = 0; i < buildText.length; i++) {
      if (!/uses: actions\/upload-artifact/.test(buildText[i])) continue;
      const window = buildText.slice(i, i + 6);
      const name = window.find((l) => /^\s+name:\s/.test(l))?.replace(/^\s+name:\s*/, "").trim();
      const path = window.find((l) => /^\s+path:\s/.test(l))?.replace(/^\s+path:\s*/, "").trim();
      const installer = path?.match(/^build\/([^/]+)$/)?.[1];
      if (!name || !installer) continue;
      const prefix = name.replace(/-\$\{\{\s*github\.run_number\s*\}\}$/, "");
      expect(prefix, `${name} does not end in the run number the lookup is built from`).not.toBe(name);
      found[installer] = prefix;
    }
    return found;
  }

  it("covers every installer build.yml uploads, and invents none", () => {
    const uploaded = uploadedInstallers();
    expect(Object.keys(uploaded).length, "build.yml stopped uploading installers where this test reads them").toBe(9);
    expect(INSTALLERS).toEqual(uploaded);
  });
});

describe("the Android table and the release key are read from android.yml, not kept beside it", () => {
  const ANDROID_YML = publicPath("github/workflows/android.yml");
  const androidText = readFileSync(ANDROID_YML, "utf8");

  /** The tag build's uploads: artifact name → the basename of the file it carries. */
  function tagBuildUploads(): Record<string, string> {
    const lines = androidText.split("\n");
    const from = lines.indexOf("  build:");
    const to = lines.findIndex((l, i) => i > from && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
    expect(from, "android.yml has no tag build job").toBeGreaterThan(-1);
    const found: Record<string, string> = {};
    for (let i = from; i < to; i++) {
      if (!/uses: actions\/upload-artifact/.test(lines[i])) continue;
      const window = lines.slice(i, i + 6);
      const name = window.find((l) => /^\s+name:\s/.test(l))?.replace(/^\s+name:\s*/, "").trim();
      const path = window.find((l) => /^\s+path:\s/.test(l))?.replace(/^\s+path:\s*/, "").trim();
      if (name && path) found[name] = path.split("/").pop()!;
    }
    return found;
  }

  it("names artifacts the tag build uploads, each with the file inside it", () => {
    const uploads = tagBuildUploads();
    expect(Object.keys(uploads).length, "the census read no upload in the tag build").toBeGreaterThanOrEqual(3);
    for (const [asset, want] of Object.entries(ANDROID_ASSETS)) {
      expect(uploads[want.artifact], `${asset}: the tag build uploads no ${want.artifact}`).toBe(want.inner);
    }
    // And the page's two file names are the ones the sign job attaches.
    expect(androidText).toContain("ohmail-android.apk");
    expect(androidText).toContain("mapping/ohmail-android-mapping.txt.gz");
  });

  /* The feeds read the APK and the mapping on a desktop page against these artifacts before they
   * sign anything, so an artifact that expires first refuses a feeds re-run for the whole page.
   * build.yml's installers carry the repository default, 90 days. */
  it("keeps every artifact the feeds read for 90 days, as long as the desktop installers", () => {
    const lines = androidText.split("\n");
    const from = lines.indexOf("  build:");
    const kept: Record<string, number> = {};
    for (let i = from; i < lines.length; i++) {
      if (!/uses: actions\/upload-artifact/.test(lines[i])) continue;
      const window = lines.slice(i, i + 6);
      const name = window.find((l) => /^\s+name:\s/.test(l))?.replace(/^\s+name:\s*/, "").trim();
      const days = window.find((l) => /^\s+retention-days:\s/.test(l))?.replace(/^\s+retention-days:\s*/, "").trim();
      if (name) kept[name] = days === undefined ? 90 : Number(days);
    }
    for (const want of Object.values(ANDROID_ASSETS)) {
      expect(kept[want.artifact], `${want.artifact} retention in android.yml's tag build`).toBeGreaterThanOrEqual(90);
    }
  });

  it("reads the one release key both signing checks assert", () => {
    const constants = [...androidText.matchAll(/EXPECTED_CERT_SHA256: "([0-9a-f]{64})"/g)].map((m) => m[1]);
    expect(constants, "android.yml asserts the release key in two steps").toHaveLength(2);
    expect(androidReleaseKey(ANDROID_YML)).toBe(constants[0]);
    // With no path, from this repository's layout — the monorepo's template beside the script.
    expect(androidReleaseKey()).toBe(constants[0]);
  });

  it("finds android.yml beside itself in the published repository's layout", () => {
    // The feeds job runs the script from a checkout of the PUBLISHED tree, where the workflow sits
    // at .github/workflows/. A path that exists only here dies ENOENT there, on a release.
    const t = mkdtempSync(join(tmpdir(), "ohmail-mirror-shape-"));
    mkdirSync(join(t, "scripts"), { recursive: true });
    mkdirSync(join(t, ".github", "workflows"), { recursive: true });
    cpSync(SCRIPT, join(t, "scripts", "verify-assets-against-builder.mjs"));
    writeFileSync(join(t, ".github", "workflows", "android.yml"), ANDROID_WORKFLOW_FIXTURE);
    const p = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(join(t, "scripts", "verify-assets-against-builder.mjs"))}); process.stdout.write(m.androidReleaseKey());`], { encoding: "utf8" });
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toBe(RELEASE_KEY);
  });
});

describe("the workflow asks the builder before it stages anything to be signed", () => {
  it("calls the script from the tools checkout, before the checksums and before the signing input", () => {
    const at = (needle: string) => {
      const i = wfText.indexOf(needle);
      expect(i, `release-feeds.yml no longer contains ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const call = at("node .tools/scripts/verify-assets-against-builder.mjs");
    expect(call).toBeLessThan(at("shasum -a 256 -- * > ../SHA256SUMS"));
    expect(call).toBeLessThan(at("cp \"$WIN_EXE\" \"$MAC_TGZ\""));
    // It runs in the job that holds no key and no write scope, and that job may read the Actions API.
    const prepareAt = wfText.indexOf("\n  prepare:\n");
    const signAt = wfText.indexOf("\n  sign:\n");
    expect(call).toBeGreaterThan(prepareAt);
    expect(call).toBeLessThan(signAt);
    expect(wfText.slice(prepareAt, signAt)).toContain("actions: read");
  });

  it("has a mode that checks a real release and writes nothing to it", () => {
    /* The first reading of this check against a published release cannot be a release. So there is
     * a dispatch input that runs the fence and the resolution, calls the script, and stops: the
     * fence returns before it can edit, the prepare step exits after the check and before the
     * checksums, its two artifact uploads are skipped, and the two jobs that hold a key or a write
     * scope do not run at all. `inputs` is null on a release event, so every one of those
     * conditions reads `null != true` there and the ordinary path is untouched. */
    expect(wfText).toContain("      verify_only:");
    expect(wfText).toContain('VERIFY_ONLY: ${{ inputs.verify_only }}');
    const verifyExit = wfText.indexOf("VERIFY-ONLY $RELEASE_TAG");
    expect(verifyExit).toBeGreaterThan(wfText.indexOf("node .tools/scripts/verify-assets-against-builder.mjs"));
    expect(verifyExit).toBeLessThan(wfText.indexOf("shasum -a 256 -- * > ../SHA256SUMS"));

    /* …and the guard is RUN, not read. A position assertion passes for a condition that can never
     * be true, which is what a mutated `if` looks like: the line is still where it belongs and
     * the run walks straight past it into the half that signs. */
    const wfLinesAll = wfText.split("\n");
    const from = wfLinesAll.findIndex(
      (l, i) => l.includes('if [ "${VERIFY_ONLY:-false}" = true ]') && (wfLinesAll[i + 1] ?? "").includes("VERIFY-ONLY $RELEASE_TAG"),
    );
    expect(from, "the prepare job's verify-only guard is gone").toBeGreaterThan(-1);
    const to = wfLinesAll.findIndex((l, i) => i > from && l.trim() === "fi");
    const guard = `${wfLinesAll.slice(from, to + 1).map((l) => l.slice(10)).join("\n")}\necho REACHED-THE-HALF-THAT-SIGNS\n`;
    for (const [mode, env] of [["a verify-only run", { VERIFY_ONLY: "true" }], ["an ordinary run", {}]] as const) {
      const p = spawnSync("bash", ["-c", `set -euo pipefail\n${guard}`], {
        encoding: "utf8",
        env: { ...process.env, RELEASE_TAG: "v9.9.9", VERIFY_ONLY: "", ...env },
      });
      expect(p.status, mode).toBe(0);
      if (env.VERIFY_ONLY) {
        expect(p.stdout).toContain("VERIFY-ONLY v9.9.9");
        expect(p.stdout, "a verify-only run walked into the half that signs").not.toContain("REACHED-THE-HALF-THAT-SIGNS");
      } else {
        expect(p.stdout, "an ordinary release stopped at the verify-only guard").toContain("REACHED-THE-HALF-THAT-SIGNS");
        expect(p.stdout).not.toContain("VERIFY-ONLY");
      }
    }
    // Four places and only four: the two uploads that would have nothing to carry, and the two
    // jobs that hold a key or a write scope. The indentation tells a step's from a job's.
    const lines = wfText.split("\n").filter((l) => l.trim() === "if: inputs.verify_only != true");
    expect(lines, "the verify-only condition is not on exactly the four things it belongs on").toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("    if:")), "two of them are the jobs").toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("        if:")), "two of them are the uploads").toHaveLength(2);
    for (const job of ["  sign:", "  publish:"]) {
      const at = wfText.indexOf(`\n${job}\n`);
      expect(at, `${job} is gone`).toBeGreaterThan(-1);
      expect(wfText.slice(at, at + 600)).toContain("if: inputs.verify_only != true");
    }
  });
});
