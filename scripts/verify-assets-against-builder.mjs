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
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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

/** The workflow whose runs build the installers, named rather than pinned to a run id. */
const BUILD_WORKFLOW = "build.yml";
const BUILD_WORKFLOW_NAME = "build";

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

export function verifyAssetsAgainstBuilder({ assetsDir, repo, commit, work }) {
  assertTools(["gh", "unzip"]);
  if (!/^[0-9a-f]{40}$/.test(commit || "")) {
    refuse("BUILDER-NO-COMMIT", `  --commit must be the tag's 40-hex commit; got ${commit ? `"${commit}"` : "nothing"}.`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || "")) {
    refuse("BUILDER-NO-REPO", `  --repo must be owner/name; got ${repo ? `"${repo}"` : "nothing"}.`);
  }

  const names = readdirSync(assetsDir)
    .filter((n) => !FEED_FILES.includes(n))
    .filter((n) => statSync(join(assetsDir, n)).isFile())
    .sort();
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
