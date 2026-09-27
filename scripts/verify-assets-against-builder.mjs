#!/usr/bin/env node
/**
 * WHAT IS SIGNED IS WHAT WAS BUILT.
 *
 * The feeds workflow takes a release's installers off the release page, hashes them into
 * SHA256SUMS, signs them and points both update feeds at them. Every one of those checks reads
 * the same download, so they agree with each other whatever is attached: an installer replaced
 * between the build and the feeds run is hashed, signed under this release's version, and
 * installed by clients that verify it correctly against a signature we made.
 *
 * This is the reading from outside that release page. For each attached installer it asks the
 * Actions API for the build's own artifact, and admits the asset only when four readings agree:
 *
 *   1. the builder's `digest` for the artifact, recorded at upload time  (not this runner's)
 *   2. the sha256 of the archive downloaded here                        (equals 1, or refuse)
 *   3. the installer taken out of THAT archive
 *   4. the asset attached to the release                                (equals 3, or refuse)
 *
 * A SHA256SUMS made from the artifact it names is the artifact vouching for itself; link 1 is
 * what makes the rest of the chain say anything. Every refusal names its subject — the asset,
 * what the build produced, what is attached — and nothing here signs, attaches or publishes.
 *
 * Usage:  node scripts/verify-assets-against-builder.mjs <assets dir> --commit <40-hex> [--repo owner/name]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Each installer a desktop release attaches, and the build artifact it comes out of. The lookup is
 * `<prefix>-<the build run's own number>` and EXACT: a prefix match reads `ohmail-appimage-aarch64-7`
 * as `ohmail-appimage-`'s and would check an arm64 build against an x86_64 asset. The table is
 * derived from build.yml's own upload steps by test/release-feeds-builder-provenance.test.ts, which
 * refuses a drift in either direction — a platform added there and not here would publish unchecked.
 */
export const INSTALLERS = {
  "ohmail.dmg": "ohmail-dmg",
  "ohmail.app.tar.gz": "ohmail-app-tgz",
  "ohmail-windows-setup.exe": "ohmail-windows",
  "ohmail-linux-x86_64.AppImage": "ohmail-appimage",
  "ohmail-linux-amd64.deb": "ohmail-deb",
  "ohmail-linux-x86_64.rpm": "ohmail-rpm",
  "ohmail-linux-aarch64.AppImage": "ohmail-appimage-aarch64",
  "ohmail-linux-arm64.deb": "ohmail-deb-arm64",
  "ohmail-linux-aarch64.rpm": "ohmail-rpm-aarch64",
};

/** The three feeds this workflow writes. They are not installers and no build produces them. */
export const FEED_FILES = ["latest.json", "appcast-macos.xml", "SHA256SUMS"];

/**
 * The Android files a desktop release page can carry (v0.19.0 to v0.21.0 did), and the artifact of
 * the `android` workflow's tag run each is read against. That run is resolved by name at the same
 * commit and its artifacts are read by its id. The mapping is the uploaded file, byte for byte. The
 * APK is re-signed after the build, so it is never the artifact's bytes: every entry outside the
 * signature must be the built one, and every signer must be the release key android.yml asserts.
 * The table is derived from android.yml's upload steps by test/release-feeds-builder-provenance.test.ts.
 */
export const ANDROID_ASSETS = {
  "ohmail-android.apk": { artifact: "ohmail-android-unsigned", inner: "app-release.apk", resigned: true },
  "ohmail-android-mapping.txt.gz": { artifact: "ohmail-android-mapping", inner: "ohmail-android-mapping.txt.gz", resigned: false },
};

/** The workflow whose runs build the installers, named rather than pinned to a run id. */
const BUILD_WORKFLOW = "build.yml";
const BUILD_WORKFLOW_NAME = "build";
const ANDROID_WORKFLOW = "android.yml";
const ANDROID_WORKFLOW_NAME = "android";

/** Where android.yml sits beside this script: the published repository's layout, then this one's. */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ANDROID_WORKFLOW_PATHS = [join(HERE, "../.github/workflows/android.yml"), join(HERE, "../public/ohmail/github/workflows/android.yml")];

/** How many runs at one commit are considered. A re-dispatched build makes a second legitimate one. */
const MAX_RUNS = 5;

class Refusal extends Error {}

/** Every refusal reads the same way: a name, then what was expected and what is there. */
function refuse(...lines) {
  throw new Refusal(lines.join("\n"));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * A gate asserts every tool it spawns before the subject starts, by name. The launch check once
 * installed x11-utils and not x11-apps, so `xwininfo` passed, `xwd` died ENOENT, and the app was
 * reported as not rendering.
 */
function assertTools(tools) {
  for (const tool of tools) {
    const p = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    if (p.status !== 0) refuse(`BUILDER-TOOL-MISSING ${tool}`, `  this check spawns ${tool} and it is not on PATH.`);
  }
}

/** `gh api`, answered as parsed JSON. An answer that cannot be read is a refusal, never an empty set. */
function ghJson(path, what) {
  const p = spawnSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (p.status !== 0 || !p.stdout.trim()) {
    refuse(
      `BUILDER-UNREADABLE ${what}`,
      `  GET ${path} answered rc ${p.status === null ? "null" : p.status}.`,
      `  ${(p.stderr || "").trim().split("\n").slice(0, 3).join(" ") || "no output"}`,
      "  Nothing can be checked against a build this run cannot read, so nothing is signed.",
    );
  }
  try {
    return JSON.parse(p.stdout);
  } catch {
    refuse(`BUILDER-UNREADABLE ${what}`, `  GET ${path} answered something that is not JSON.`);
  }
}

/** The artifact's archive, streamed to a file — these are installers, not strings. */
function downloadArtifact(repo, artifact, zipPath) {
  const fd = openSync(zipPath, "w");
  try {
    const p = spawnSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], {
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (p.status !== 0) {
      refuse(
        `BUILDER-UNREADABLE artifact ${artifact.name}`,
        `  the archive would not download (rc ${p.status === null ? "null" : p.status}).`,
        `  ${(p.stderr || "").trim().split("\n").slice(0, 3).join(" ") || "no output"}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** The runs of the build workflow at one commit, newest first. Resolved by NAME, never by a run id. */
function buildRunsAt(repo, commit) {
  const answer = ghJson(
    `repos/${repo}/actions/workflows/${BUILD_WORKFLOW}/runs?head_sha=${commit}&per_page=50`,
    `the ${BUILD_WORKFLOW_NAME} workflow's runs at ${commit}`,
  );
  const runs = answer?.workflow_runs;
  if (!Array.isArray(runs)) {
    refuse(
      `BUILDER-UNREADABLE the ${BUILD_WORKFLOW_NAME} workflow's runs at ${commit}`,
      "  the answer carried no workflow_runs array.",
    );
  }
  /* The run's CONCLUSION is printed and not required. A build whose Flatpak or install-drill job
   * went red still produced these installers from this commit, and refusing on it would redden
   * every release behind an unrelated job. What the chain asserts is the bytes, not the run's mood. */
  const mine = runs
    .filter((r) => r.head_sha === commit && r.name === BUILD_WORKFLOW_NAME)
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  if (mine.length === 0) {
    refuse(
      `BUILDER-NO-RUN ${commit}`,
      `  no run of the ${BUILD_WORKFLOW_NAME} workflow has this commit as its head.`,
      "  The assets on the release cannot be traced to a build of this source, so none is signed.",
    );
  }
  return mine.slice(0, MAX_RUNS);
}

/**
 * One run, one verdict: every asset matches an artifact of THIS run, or the run does not account
 * for the release. Two legitimate runs of one commit produce different bytes, so a run is
 * accepted whole — a per-asset "any run will do" would let a replacement borrow another run's
 * innocence.
 */
function checkAgainstRun(repo, run, assets, work) {
  const answer = ghJson(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, `the artifacts of run ${run.id}`);
  const artifacts = answer?.artifacts;
  if (!Array.isArray(artifacts)) {
    refuse(`BUILDER-UNREADABLE the artifacts of run ${run.id}`, "  the answer carried no artifacts array.");
  }
  const lines = [];
  for (const asset of assets) {
    const wanted = `${INSTALLERS[asset.name]}-${run.run_number}`;
    const artifact = artifacts.find((a) => a.name === wanted);
    if (!artifact) {
      return { ok: false, reason: `BUILDER-ARTIFACT-MISSING ${wanted} (run ${run.id}) — nothing in that run carries ${asset.name}` };
    }
    if (artifact.expired === true) {
      return {
        ok: false,
        reason: `BUILDER-ARTIFACT-EXPIRED ${wanted} (run ${run.id}) — past its retention, so what ${asset.name} was built from can no longer be read`,
      };
    }
    const digest = typeof artifact.digest === "string" && artifact.digest.startsWith("sha256:") ? artifact.digest.slice(7) : "";
    if (!digest) {
      return {
        ok: false,
        reason: `BUILDER-NO-DIGEST ${wanted} (run ${run.id}) — the API recorded no sha256 for it, and without the builder's own reading this chain is the release vouching for itself`,
      };
    }

    const zip = join(work, `${wanted}.zip`);
    const out = join(work, wanted);
    downloadArtifact(repo, artifact, zip);
    const archive = sha256(zip);
    if (archive !== digest) {
      refuse(
        `BUILDER-DIGEST-MISMATCH ${wanted}`,
        `  the builder published  sha256:${digest}`,
        `  this run downloaded    sha256:${archive}`,
        "  The archive this run holds is not the one the builder published; nothing is signed.",
      );
    }
    mkdirSync(out, { recursive: true });
    const unzip = spawnSync("unzip", ["-o", "-q", zip, "-d", out], { encoding: "utf8" });
    if (unzip.status !== 0) {
      refuse(`BUILDER-UNREADABLE artifact ${wanted}`, `  the archive did not extract: ${(unzip.stderr || "").trim()}`);
    }
    const inner = join(out, asset.name);
    let built;
    try {
      built = sha256(inner);
    } catch {
      const held = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.trim().split("\n").join(", ");
      rmSync(zip, { force: true });
      rmSync(out, { recursive: true, force: true });
      return { ok: false, reason: `BUILDER-ARCHIVE-MISSING-FILE ${asset.name} is not in ${wanted} (run ${run.id}); it holds: ${held}` };
    }
    rmSync(zip, { force: true });
    rmSync(out, { recursive: true, force: true });
    if (built !== asset.sha256) {
      return {
        ok: false,
        reason: [
          `BUILDER-ASSET-MISMATCH ${asset.name}`,
          `  the build produced  sha256:${built}   (artifact ${wanted} of run ${run.id})`,
          `  the release carries sha256:${asset.sha256}`,
          "  The bytes attached to this release are not the bytes this build made.",
        ].join("\n"),
      };
    }
    lines.push(`  ${asset.name} · ${wanted} · sha256:${built}`);
  }
  return { ok: true, lines };
}

/** The release key's certificate digest, read from android.yml, which asserts it on every tag build. */
export function androidReleaseKey(workflowPath) {
  const path = workflowPath || ANDROID_WORKFLOW_PATHS.find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    refuse("BUILDER-NO-ANDROID-KEY", `  android.yml is not beside this script (${ANDROID_WORKFLOW_PATHS.join(" or ")}).`);
  }
  const keys = [...readFileSync(path, "utf8").matchAll(/^\s+EXPECTED_CERT_SHA256:\s*"([0-9a-f]{64})"\s*$/gm)].map((m) => m[1]);
  if (keys.length === 0 || new Set(keys).size !== 1) {
    refuse("BUILDER-NO-ANDROID-KEY", `  ${path} names ${new Set(keys).size} release key(s); exactly one is the reading.`);
  }
  return keys[0];
}

/** A zip's central directory: each entry's name, crc32 and sizes. Zip64 and damage refuse. */
function zipEntries(buf, what) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) refuse(`BUILDER-APK-UNREADABLE ${what}`, "  no end-of-central-directory record: this is not a zip.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) refuse(`BUILDER-APK-UNREADABLE ${what}`, "  a zip64 archive, which is not a shape this reads.");
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      refuse(`BUILDER-APK-UNREADABLE ${what}`, `  central directory entry ${n} of ${count} is not one.`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, `${buf.readUInt32LE(p + 16)}:${buf.readUInt32LE(p + 24)}`);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { entries, cdOffset };
}

/** The certificate digests of every signer in each APK signature scheme block (v2, v3, v3.1). */
function apkSigners(buf, cdOffset, what) {
  if (cdOffset < 32 || buf.toString("latin1", cdOffset - 16, cdOffset) !== "APK Sig Block 42") {
    refuse(`BUILDER-APK-UNREADABLE ${what}`, "  it carries no APK signing block, so no key can be read off it.");
  }
  const size = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - size - 8;
  if (start < 0 || Number(buf.readBigUInt64LE(start)) !== size) refuse(`BUILDER-APK-UNREADABLE ${what}`, "  the signing block's two sizes disagree.");
  const lp = (b, at) => {
    const n = b.readUInt32LE(at);
    if (at + 4 + n > b.length) refuse(`BUILDER-APK-UNREADABLE ${what}`, "  a length inside the signing block runs past its end.");
    return { body: b.subarray(at + 4, at + 4 + n), next: at + 4 + n };
  };
  const seq = (b) => {
    const out = [];
    for (let at = 0; at < b.length; ) {
      const x = lp(b, at);
      out.push(x.body);
      at = x.next;
    }
    return out;
  };
  const schemes = { 0x7109871a: "v2", 0xf05368c0: "v3", 0x1b93ad61: "v3.1" };
  const found = [];
  for (let p = start + 8; p < cdOffset - 24; ) {
    const len = Number(buf.readBigUInt64LE(p));
    const id = buf.readUInt32LE(p + 8);
    if (schemes[id]) {
      // signers → signed data → [digests, certificates, …]; the first certificate is the signer's.
      const signers = seq(lp(buf.subarray(p + 12, p + 8 + len), 0).body).map((signer) => {
        const signedData = lp(signer, 0).body;
        const certs = seq(lp(signedData, lp(signedData, 0).next).body);
        return certs.length ? sha256Of(certs[0]) : "";
      });
      found.push({ scheme: schemes[id], signers });
    }
    p += 8 + len;
  }
  if (found.length === 0) refuse(`BUILDER-APK-UNREADABLE ${what}`, "  its signing block holds no v2 or v3 signature.");
  return found;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The v1 signature files apksigner writes and rewrites. Every other entry is the build's. */
const APK_SIGNATURE_ENTRY = /^META-INF\/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF)$/;

/** A re-signed APK against the one its build produced: same entries, and the release key only. */
function apkAgainstBuild(builtPath, attachedPath, releaseKey, where) {
  const name = "ohmail-android.apk";
  const built = zipEntries(readFileSync(builtPath), `${name} (as built, ${where})`).entries;
  const attachedBuf = readFileSync(attachedPath);
  const attached = zipEntries(attachedBuf, name);
  const differ = [];
  for (const [entry, sig] of built) if (!APK_SIGNATURE_ENTRY.test(entry) && attached.entries.get(entry) !== sig) differ.push(entry);
  for (const entry of attached.entries.keys()) if (!APK_SIGNATURE_ENTRY.test(entry) && !built.has(entry)) differ.push(entry);
  if (differ.length > 0) {
    return {
      ok: false,
      reason: `BUILDER-APK-CONTENT-MISMATCH ${name}: ${differ.length} entr${differ.length === 1 ? "y differs" : "ies differ"} from the build (${where}), first ${differ.sort()[0]}`,
    };
  }
  // The key is not a property of a run, so a wrong one refuses outright rather than trying the next.
  for (const { scheme, signers } of apkSigners(attachedBuf, attached.cdOffset, name)) {
    if (signers.length !== 1 || signers[0] !== releaseKey) {
      refuse(
        `BUILDER-APK-NOT-THE-RELEASE-KEY ${name}`,
        `  its ${scheme} signature carries ${signers.length} signer(s): ${signers.map((s) => `sha256:${s}`).join(" ") || "none"}`,
        `  the release key is sha256:${releaseKey}. An install checks an update against that key.`,
      );
    }
  }
  const counted = [...built.keys()].filter((e) => !APK_SIGNATURE_ENTRY.test(e)).length;
  return { ok: true, line: `  ${name} · ${counted} entries as built (${where}) · signed by the release key sha256:${releaseKey}` };
}

/** The android workflow's tag runs at one commit, newest first. Resolved by NAME, read by id. */
function androidRunsAt(repo, commit) {
  const answer = ghJson(
    `repos/${repo}/actions/workflows/${ANDROID_WORKFLOW}/runs?head_sha=${commit}&per_page=50`,
    `the ${ANDROID_WORKFLOW_NAME} workflow's runs at ${commit}`,
  );
  if (!Array.isArray(answer?.workflow_runs)) {
    refuse(`BUILDER-UNREADABLE the ${ANDROID_WORKFLOW_NAME} workflow's runs at ${commit}`, "  the answer carried no workflow_runs array.");
  }
  /* A push to main runs the same workflow at the same commit and uploads a debug-signed APK; only a
   * run of an `android-v` tag builds what a release page carries. */
  const mine = answer.workflow_runs
    .filter((r) => r.head_sha === commit && r.name === ANDROID_WORKFLOW_NAME && String(r.head_branch ?? "").startsWith("android-v"))
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  if (mine.length === 0) {
    refuse(
      `BUILDER-NO-ANDROID-RUN ${commit}`,
      `  no run of the ${ANDROID_WORKFLOW_NAME} workflow for an android-v tag has this commit as its head.`,
      "  The Android files on this page cannot be traced to a build of this source, so nothing is signed.",
    );
  }
  return mine.slice(0, MAX_RUNS);
}

/** One android run, one verdict, the desktop rule: the run accounts for every Android file or none. */
function checkAndroidAgainstRun(repo, run, assets, work, releaseKey) {
  const answer = ghJson(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, `the artifacts of run ${run.id}`);
  if (!Array.isArray(answer?.artifacts)) refuse(`BUILDER-UNREADABLE the artifacts of run ${run.id}`, "  the answer carried no artifacts array.");
  const lines = [];
  for (const asset of assets) {
    const want = ANDROID_ASSETS[asset.name];
    const artifact = answer.artifacts.find((a) => a.name === want.artifact);
    const at = `artifact ${want.artifact} of run ${run.id}`;
    if (!artifact) return { ok: false, reason: `BUILDER-ARTIFACT-MISSING ${want.artifact} (run ${run.id}) — nothing in that run carries ${asset.name}` };
    if (artifact.expired === true) {
      return { ok: false, reason: `BUILDER-ARTIFACT-EXPIRED ${want.artifact} (run ${run.id}) — past its retention, so what ${asset.name} was built from can no longer be read` };
    }
    const digest = typeof artifact.digest === "string" && artifact.digest.startsWith("sha256:") ? artifact.digest.slice(7) : "";
    if (!digest) return { ok: false, reason: `BUILDER-NO-DIGEST ${want.artifact} (run ${run.id}) — the API recorded no sha256 for it` };
    const zip = join(work, `${want.artifact}-${run.id}.zip`);
    const out = join(work, `${want.artifact}-${run.id}`);
    downloadArtifact(repo, artifact, zip);
    const archive = sha256(zip);
    if (archive !== digest) {
      refuse(
        `BUILDER-DIGEST-MISMATCH ${want.artifact}`,
        `  the builder published  sha256:${digest}`,
        `  this run downloaded    sha256:${archive}`,
        "  The archive this run holds is not the one the builder published; nothing is signed.",
      );
    }
    mkdirSync(out, { recursive: true });
    const unzip = spawnSync("unzip", ["-o", "-q", zip, "-d", out], { encoding: "utf8" });
    if (unzip.status !== 0) refuse(`BUILDER-UNREADABLE artifact ${want.artifact}`, `  the archive did not extract: ${(unzip.stderr || "").trim()}`);
    const inner = join(out, want.inner);
    if (!existsSync(inner)) {
      rmSync(out, { recursive: true, force: true });
      return { ok: false, reason: `BUILDER-ARCHIVE-MISSING-FILE ${want.inner} is not in ${want.artifact} (run ${run.id})` };
    }
    let verdict;
    if (want.resigned) {
      verdict = apkAgainstBuild(inner, asset.path, releaseKey, at);
    } else {
      const made = sha256(inner);
      verdict = made === asset.sha256
        ? { ok: true, line: `  ${asset.name} · ${want.artifact} · sha256:${made}` }
        : {
            ok: false,
            reason: [
              `BUILDER-ASSET-MISMATCH ${asset.name}`,
              `  the build produced  sha256:${made}   (${at})`,
              `  the release carries sha256:${asset.sha256}`,
            ].join("\n"),
          };
    }
    rmSync(zip, { force: true });
    rmSync(out, { recursive: true, force: true });
    if (!verdict.ok) return verdict;
    lines.push(verdict.line);
  }
  return { ok: true, lines };
}

/** The Android files on a desktop page, read against the android workflow's own tag run. */
export function verifyAndroidAssets({ repo, commit, assets, work, releaseKey }) {
  const runs = androidRunsAt(repo, commit);
  console.log(`${runs.length} run(s) of ${ANDROID_WORKFLOW_NAME} for an android-v tag at ${commit}:`);
  for (const r of runs) console.log(`  run ${r.id} #${r.run_number} ${r.head_branch} ${r.conclusion ?? r.status} ${r.html_url ?? ""}`);
  mkdirSync(work, { recursive: true });
  const reasons = [];
  for (const run of runs) {
    const verdict = checkAndroidAgainstRun(repo, run, assets, work, releaseKey);
    if (verdict.ok) {
      for (const l of verdict.lines) console.log(l);
      console.log(`BUILDER-VERIFIED-ANDROID ${assets.length} asset(s) of ${commit} against ${ANDROID_WORKFLOW_NAME} run ${run.id} (${run.head_branch})`);
      return;
    }
    reasons.push(verdict.reason);
  }
  refuse(...reasons, "", "No android build of this commit accounts for the Android files on this release, so nothing is signed.");
}

export function verifyAssetsAgainstBuilder({ assetsDir, repo, commit, work, androidWorkflow }) {
  assertTools(["gh", "unzip"]);
  if (!/^[0-9a-f]{40}$/.test(commit || "")) {
    refuse("BUILDER-NO-COMMIT", `  --commit must be the tag's 40-hex commit; got ${commit ? `"${commit}"` : "nothing"}.`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || "")) {
    refuse("BUILDER-NO-REPO", `  --repo must be owner/name; got ${repo ? `"${repo}"` : "nothing"}.`);
  }

  const present = readdirSync(assetsDir).filter((n) => statSync(join(assetsDir, n)).isFile()).sort();
  const skipped = present.filter((n) => FEED_FILES.includes(n));
  for (const n of skipped) console.log(`skipped ${n} — a feed this run writes`);
  const android = present.filter((n) => ANDROID_ASSETS[n]);
  const names = present.filter((n) => !skipped.includes(n) && !android.includes(n));
  if (names.length === 0) refuse("BUILDER-NO-ASSETS", `  ${assetsDir} holds no installer to check.`);
  /* An asset this table has never heard of is a platform whose provenance nobody can state, and it
   * would ride onto the download page inside a SHA256SUMS that vouches for it. */
  const strangers = names.filter((n) => !INSTALLERS[n]);
  if (strangers.length > 0) {
    refuse(
      `BUILDER-NO-ARTIFACT-FOR-ASSET ${strangers.join(" ")}`,
      "  no build artifact is recorded for these, so what they were built from cannot be read.",
    );
  }
  const assets = names.map((name) => ({ name, sha256: sha256(join(assetsDir, name)) }));
  // The key is read before the API is asked anything: a check with no key to hold the APK to has no answer.
  const releaseKey = android.length > 0 ? androidReleaseKey(androidWorkflow) : null;

  const runs = buildRunsAt(repo, commit);
  console.log(`${runs.length} run(s) of ${BUILD_WORKFLOW_NAME} at ${commit}:`);
  for (const r of runs) console.log(`  run ${r.id} #${r.run_number} ${r.conclusion ?? r.status} ${r.html_url ?? ""}`);

  mkdirSync(work, { recursive: true });
  const reasons = [];
  for (const run of runs) {
    const verdict = checkAgainstRun(repo, run, assets, work);
    if (verdict.ok) {
      console.log(`${assets.length} asset(s) checked against run ${run.id} (#${run.run_number}):`);
      for (const l of verdict.lines) console.log(l);
      console.log(`BUILDER-VERIFIED ${assets.length} asset(s) of ${commit} against ${BUILD_WORKFLOW_NAME} run ${run.id}`);
      if (android.length > 0) {
        const androidAssets = android.map((name) => ({ name, path: join(assetsDir, name), sha256: sha256(join(assetsDir, name)) }));
        verifyAndroidAssets({ repo, commit, assets: androidAssets, work, releaseKey });
      }
      return;
    }
    reasons.push(verdict.reason);
  }
  refuse(...reasons, "", "No build of this commit accounts for what is attached to this release, so nothing is signed.");
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

/* `--android-workflow <android.yml>` names the file the Android release key is read from; without
 * it, the android.yml beside this script, in the published layout or this repository's. */
function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const assetsDir = positional[0];
  if (!assetsDir) {
    console.error("usage: node scripts/verify-assets-against-builder.mjs <assets dir> --commit <40-hex> [--repo owner/name]");
    process.exit(2);
  }
  try {
    verifyAssetsAgainstBuilder({
      assetsDir,
      repo: flags.repo || process.env.GITHUB_REPOSITORY || "",
      commit: flags.commit || "",
      work: flags.work || join(assetsDir, "..", "builder-check"),
      androidWorkflow: flags["android-workflow"] || "",
    });
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/* Entry-point only. A module that spawns is measured by running it, never by importing it — an
 * import of publish-desktop.mjs once replayed 111 commits into the mirror. */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
