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
 *   · The Tauri signer is pinned HERE, in `TAURI` below: a version and the sha512 `integrity`
 *     npm serves for that exact tarball, one row per package. It used to be read out of this
 *     repository's committed `pnpm-lock.yaml` — one constant instead of two — but the workflow
 *     that runs this file runs in the PUBLISHED repository, which ships no lockfile, so the read
 *     failed there with `ENOENT … pnpm-lock.yaml` and the signing step could not start at all.
 *     The rows are the same bytes `pnpm install --frozen-lockfile` enforces; `--selftest` checks
 *     their shape and watches a wrong pin refuse.
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
import { tmpdir } from "node:os";
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

function fetchTo(url, dest) {
  execFileSync("curl", ["-fsSL", "--retry", "3", url, "-o", dest], { stdio: ["ignore", "inherit", "inherit"] });
}

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
/* THE TAURI SIGNER'S PINS — version + the sha512 npm serves for that tarball, one row per
 * package, for every platform `PLATFORM_PKG` names. A package this script is asked for and does
 * not find here is a refusal by name: fetching an unpinned tarball while the keys are in the
 * environment is the thing this file exists to prevent. */
const TAURI = {
  "@tauri-apps/cli": { version: "2.9.2", integrity: "sha512-aGzdVgxQW6WQ7e5nydPZ/30u8HvltHjO3Ytzf1wOxX1N5Yj2TsjKWRb/AWJlB95Huml3k3c/b6s0ijAvlSo9xw==" },
  "@tauri-apps/cli-darwin-arm64": { version: "2.9.2", integrity: "sha512-g1OtCXydOZFYRUEAyGYdJ2lLaE3l5jk8o+Bro8y2WOLwBLtbWjBoJIVobOKFanfjG/Xr8H/UA+umEVILPhMc2A==" },
  "@tauri-apps/cli-darwin-x64": { version: "2.9.2", integrity: "sha512-nHHIY33noUmMOyFwAJz0xQyrYIXU+bae8MNos4TGsTo491YWAF2uzr6iW+Bq0N530xDcbe7EyRvDHgK43RmmVw==" },
  "@tauri-apps/cli-linux-x64-gnu": { version: "2.9.2", integrity: "sha512-tg85cGIM9PWwsbQg8m3uah3SfoNapgUr4vhWtkqgeTDZOjQuQ2duTwCH4UiM7acBpbZHNzvRrxSFpv0U53TqQQ==" },
  "@tauri-apps/cli-linux-arm64-gnu": { version: "2.9.2", integrity: "sha512-Pxj5k29Rxj9xEht4gdE744t5HLXTwBojkjYDXXyJ3mE+BEg9hFX5WkStg7OkyZwH60u8NSkDSMpo7MJTH9srmA==" },
};

function pinnedPackage(name) {
  const row = TAURI[name];
  if (!row) throw new Error(`${name} has no row in TAURI — add its version and sha512 integrity before the signing step can fetch it.`);
  if (!/^\d+\.\d+\.\d+/.test(row.version ?? "")) throw new Error(`TAURI["${name}"] has no version.`);
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(row.integrity ?? "")) throw new Error(`TAURI["${name}"] has no sha512 integrity.`);
  return row;
}

/* ── --selftest: the pins are checked before anything is fetched ───────────────────────────────
 * Offline, no key, no network. Three arms, and the middle one is the point: a pin that does not
 * match must REFUSE and must name what it was checking, because the whole file exists to stop the
 * signing step from starting. Every platform `PLATFORM_PKG` names must have a row — a platform
 * added without its pin would otherwise fetch an unpinned tarball on that runner only. */
if (process.argv[2] === "--selftest") {
  let pass = 0, n = 0, bad = 0;
  const ok = (m) => { pass++; process.stdout.write(`  ok   ${m}\n`); };
  const no = (m) => { bad = 1; process.stdout.write(`  BAD  ${m}\n`); };
  n++;
  try {
    for (const name of Object.keys(TAURI)) pinnedPackage(name);
    ok(`${Object.keys(TAURI).length} TAURI row(s), every one a version and a sha512`);
  } catch (e) { no(`a TAURI row is malformed: ${e.message}`); }
  n++;
  const missing = Object.values(PLATFORM_PKG).filter((x) => !TAURI[x]);
  if (missing.length === 0) ok(`every PLATFORM_PKG target has a pin (${Object.values(PLATFORM_PKG).length})`);
  else no(`no pin for: ${missing.join(", ")}`);
  n++;
  try { pinnedPackage("@tauri-apps/cli-nosuch-arch"); no("an unpinned package was admitted"); }
  catch (e) { e.message.includes("@tauri-apps/cli-nosuch-arch") ? ok("an unpinned package refuses BY NAME") : no(`refused without naming it: ${e.message}`); }
  n++;
  const tmp = join(tmpdir(), `pinned-signers-selftest-${process.pid}`);
  writeFileSync(tmp, "not the pinned bytes");
  try {
    requirePin("the selftest's own file", tmp, "sha512-AAAA", "sha512");
    no("a wrong pin was admitted");
  } catch (e) {
    e.message.includes("the selftest's own file") ? ok("a wrong pin refuses, naming the subject") : no(`refused without naming the subject: ${e.message}`);
  } finally { rmSync(tmp, { force: true }); }
  process.stdout.write(bad ? `SELFTEST_FAIL fetch-pinned-signers ${pass}/${n}\n` : `SELFTEST_OK fetch-pinned-signers ${pass}/${n}\n`);
  process.exit(bad ? 1 : 0);
}

const outDir = resolve(process.argv[2] ?? join(ROOT, "signers"));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const hostKey = `${process.platform}-${process.arch}`;
const platformName = PLATFORM_PKG[hostKey];
if (!platformName) {
  throw new Error(
    `no @tauri-apps/cli platform package is named here for ${hostKey}. ` +
    `Add it to PLATFORM_PKG and TAURI, with its version and sha512 integrity.`);
}

const nm = join(outDir, "node_modules", "@tauri-apps");
mkdirSync(nm, { recursive: true });
for (const name of ["@tauri-apps/cli", platformName]) {
  const { version, integrity } = pinnedPackage(name);
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
