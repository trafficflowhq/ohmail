#!/usr/bin/env node
/**
 * fetch-pinned-signers.mjs — materialise the two update signers, each pinned to bytes.
 *
 * The release-feeds workflow holds two long-lived private keys, and whatever it runs while it
 * holds them runs with them. It used to fetch both signers in the same step: `npx --yes
 * @tauri-apps/cli@2` resolved a FLOATING major range from the registry at signing time, and the
 * Sparkle distribution was curled and unpacked beside it. Either publisher can change what that
 * step executes without anything here changing, and the blast radius is remote code execution on
 * every install — the update channel is the one place where that is the whole product.
 *
 * So the fetching happens here, in a step that holds no key, and every byte is checked against a
 * pin before the signing step is allowed to run it:
 *
 *   · The Tauri signer is pinned by the `integrity` this repository's own committed
 *     `pnpm-lock.yaml` already records — the same sha512 `pnpm install --frozen-lockfile`
 *     enforces everywhere else. No second constant to keep in step with the dependency.
 *   · Sparkle is pinned twice: the sha256 of the distribution archive, and the sha256 of the
 *     `sign_update` binary taken out of it. The second is not redundant. The archive carries
 *     THREE files named `sign_update` — `bin/sign_update`, the retired `bin/old_dsa_scripts/
 *     sign_update`, and a debug-symbol copy — and the workflow used to select one with `find …
 *     | head -1`, which is directory order. The retired one is an executable shell script that
 *     signs with DSA.
 *
 * A pin that does not match is a refusal, never a warning: the point is that the signing step
 * cannot start.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/* Sparkle ships no lockfile here, so both pins are written down. They move together with the
 * version, and a bump that forgets them is a refusal rather than a silent new signer. */
const SPARKLE = {
  version: "2.9.4",
  archiveSha256: "ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9",
  signUpdateSha256: "bfb52400c3da18bb4c251ac4818c2c2e1e31c2e649a45b31c11109b6e57b34ad",
};

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requirePin(what, path, expected, kind) {
  const actual = kind === "sha512" ? integrityOf(path) : sha256(path);
  if (actual !== expected) {
    throw new Error(
      `${what} does not match its pin.\n` +
      `  expected  ${expected}\n` +
      `  got       ${actual}\n` +
      `  at        ${path}\n` +
      `The signing step runs this file while it holds the update keys, so a byte that is not the\n` +
      `pinned one stops the release here.`);
  }
  process.stdout.write(`pinned  ${what}  ${kind === "sha512" ? "sha512" : "sha256"} ok\n`);
}

function integrityOf(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

/* The lockfile is read as TEXT rather than parsed as YAML: this script runs on a release runner
 * with no install, so it has no yaml parser, and the two lines it needs are unambiguous. A
 * package with no entry, or more than one version of it, is a refusal — picking one would be the
 * arbitrary choice this whole file exists to remove. */
function lockedPackage(name) {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  const found = [];
  for (let i = 0; i < lock.length; i++) {
    const m = /^ {2}'?(@?[^'@\s]+(?:\/[^'@\s]+)?)@([^'@\s]+)'?:$/.exec(lock[i]);
    if (!m || m[1] !== name) continue;
    const res = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lock[i + 1] ?? "");
    if (res) found.push({ version: m[2], integrity: res[1] });
  }
  if (found.length !== 1) {
    throw new Error(
      `pnpm-lock.yaml records ${found.length} versions of ${name} ` +
      `(${found.map((f) => f.version).join(", ") || "none"}), and this needs exactly one.`);
  }
  return found[0];
}

function fetchTo(url, dest) {
  execFileSync("curl", ["-fsSL", "--retry", "3", url, "-o", dest], { stdio: ["ignore", "inherit", "inherit"] });
}

const outDir = resolve(process.argv[2] ?? join(ROOT, "signers"));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/* ── 1 · THE TAURI SIGNER, laid out as node_modules so the wrapper finds its own binary ────────
 * `@tauri-apps/cli` is a JS shim that requires the platform package for the machine it is on, so
 * the two tarballs have to sit as siblings under one `node_modules/@tauri-apps/` for the shim to
 * resolve at all. The platform half is chosen from this process's own arch and platform — the job
 * runs on macOS, and naming one would break the moment the runner image changed. */
const PLATFORM_PKG = {
  "darwin-arm64": "@tauri-apps/cli-darwin-arm64",
  "darwin-x64": "@tauri-apps/cli-darwin-x64",
  "linux-x64": "@tauri-apps/cli-linux-x64-gnu",
  "linux-arm64": "@tauri-apps/cli-linux-arm64-gnu",
};
const hostKey = `${process.platform}-${process.arch}`;
const platformName = PLATFORM_PKG[hostKey];
if (!platformName) {
  throw new Error(
    `no @tauri-apps/cli platform package is named here for ${hostKey}. ` +
    `Add it to PLATFORM_PKG once its integrity is in pnpm-lock.yaml.`);
}

const nm = join(outDir, "node_modules", "@tauri-apps");
mkdirSync(nm, { recursive: true });
for (const name of ["@tauri-apps/cli", platformName]) {
  const { version, integrity } = lockedPackage(name);
  const bare = name.split("/")[1];
  const tgz = join(outDir, `${bare}-${version}.tgz`);
  fetchTo(`https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`, tgz);
  requirePin(`${name}@${version}`, tgz, integrity, "sha512");
  const into = join(nm, bare);
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", into, "--strip-components", "1"]);
}
const tauriSigner = join(nm, "cli", "tauri.js");
if (!existsSync(tauriSigner)) throw new Error(`the Tauri cli tarball carries no tauri.js at ${tauriSigner}`);

/* ── 2 · SPARKLE'S sign_update, BY PATH AND BY BYTES ──────────────────────────────────────────── */
const sparkleTar = join(outDir, `Sparkle-${SPARKLE.version}.tar.xz`);
fetchTo(
  `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE.version}/Sparkle-${SPARKLE.version}.tar.xz`,
  sparkleTar);
requirePin(`Sparkle-${SPARKLE.version}.tar.xz`, sparkleTar, SPARKLE.archiveSha256, "sha256");
const sparkleDir = join(outDir, "sparkle");
mkdirSync(sparkleDir, { recursive: true });
execFileSync("tar", ["-xJf", sparkleTar, "-C", sparkleDir]);
/* NAMED, not searched. `find … -name sign_update | head -1` reads directory order over three
 * candidates, one of which is the retired DSA signer. */
const signUpdate = join(sparkleDir, "bin", "sign_update");
if (!existsSync(signUpdate)) throw new Error(`Sparkle ${SPARKLE.version} carries no bin/sign_update`);
requirePin("Sparkle bin/sign_update", signUpdate, SPARKLE.signUpdateSha256, "sha256");

/* The signing step reads these two paths out of a file rather than re-deriving them, so it can
 * run with no network and nothing to resolve. */
const manifest = { tauriSigner, signUpdate };
writeFileSync(join(outDir, "signers.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`tauri signer  ${tauriSigner}\nsparkle signer ${signUpdate}\n`);
