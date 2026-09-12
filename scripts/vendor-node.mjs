#!/usr/bin/env node
/**
 * vendor-node.mjs — fetch the official Node build for one platform, verify it, and put the runtime in
 * `build/vendor/` where the packager copies it in. (`node scripts/vendor-node.mjs [--platform darwin|linux|
 * linux-arm64|windows]`, or `OHMAIL_NODE_ARCHIVES=<dir> node …` to work offline.) A script not a paragraph:
 * the packager used to refuse with a block of shell for a person to paste, and CI cannot follow prose — an
 * artifact assembled by hand is not the one the tag describes. The app carries a runtime because the mail
 * engine is a Node program and a shipped app's `PATH` (a Finder/launchd launch gets no Homebrew or nvm) is
 * not a developer's, so "install Node first" was a build that failed to find its own engine
 * (`engine.rs::resolve_node` resolves this vendored one first). THE CHECKSUM IS THE POINT: bytes are
 * verified against the release's own `SHASUMS256.txt` before unpacking, a mismatch a hard refusal. ONE platform per run, on that platform's runner, because the one cheap thing this can prove is that the binary RUNS (`--version`), only available on the target (macOS `lipo`s both slices and asserts both present; Linux ships x86_64 and arm64 separately, no `lipo` for ELF). Offline mode uses PINS in this file (digests of the pinned release, the online arm asserting the pin agrees with the fetched manifest). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Pinned, and read from one place. A runtime bump is a deliberate edit here, not whatever the
 * `latest` redirect happened to serve on the day a release was cut. */
export const VERSION = process.env.OHMAIL_NODE_VERSION ?? "v22.23.2";
const DIST = `https://nodejs.org/dist/${VERSION}`;

/**
 * THE PINNED RELEASE'S OWN DIGESTS, keyed by version so a bump cannot inherit the old ones.
 *
 * Copied from `https://nodejs.org/dist/<version>/SHASUMS256.txt` — every archive `PLATFORMS` below
 * can ask for. The offline arm has nothing else to verify against; the online arm checks these
 * against the manifest it fetches, so a wrong pin is a refusal at the next ordinary build rather
 * than a surprise the first time somebody builds without a network.
 */
const PINS = {
  "v22.23.2": {
    "node-v22.23.2-darwin-arm64.tar.gz": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
    "node-v22.23.2-darwin-x64.tar.gz": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
    "node-v22.23.2-linux-x64.tar.xz": "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
    "node-v22.23.2-linux-arm64.tar.xz": "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8",
    "node-v22.23.2-win-x64.zip": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  },
};

/* Set = offline. Unset = the ordinary download. A directory rather than a file because macOS needs
 * two archives and a caller should not have to know that. */
const ARCHIVE_DIR = process.env.OHMAIL_NODE_ARCHIVES ?? null;

const OUT_DIR = path.join(ROOT, "build", "vendor");

const say = (m) => process.stdout.write(`${m}\n`);
function die(m) {
  process.stderr.write(`\nvendor-node: ${m}\n`);
  process.exit(1);
}

/**
 * What each platform downloads, and what comes out.
 *
 * `archives` are nodejs.org's own names — the ONLY strings that address a release — and `binary` is
 * the path to the runtime inside the unpacked archive. Note `x64` in the download names and
 * `x86_64` in `slices`: those are the same architecture under two spellings, and the second is the
 * one `lipo -archs` prints. Checking for the literal `x64` there fails on a bundle that is in fact
 * correct, which is the kind of guard that gets deleted for being wrong rather than fixed.
 */
const PLATFORMS = {
  darwin: {
    archives: [`node-${VERSION}-darwin-arm64.tar.gz`, `node-${VERSION}-darwin-x64.tar.gz`],
    unpack: ["-xzf"],
    binary: (name) => path.join(name.replace(/\.tar\.gz$/, ""), "bin", "node"),
    licence: (name) => path.join(name.replace(/\.tar\.gz$/, ""), "LICENSE"),
    out: "node",
    /* Universal, because the shell is. An app that ships two slices and a one-slice runtime is
     * standalone on one architecture and broken on the other. */
    slices: ["arm64", "x86_64"],
  },
  /* `linux` MEANS x86_64, and the name is kept rather than corrected to `linux-x64`.
   *
   * It is the spelling the published README's build instructions and the build workflow have both
   * used since this script existed, and those are in a repository other people have checked out.
   * Renaming the key would make every copy of those instructions wrong for the sake of symmetry
   * with a key added later. The arm64 entry below is explicit about its architecture instead, and
   * `hostPlatform()` is what keeps a bare run on an arm64 machine from silently taking this one. */
  linux: {
    archives: [`node-${VERSION}-linux-x64.tar.xz`],
    unpack: ["-xJf"],
    binary: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "bin", "node"),
    licence: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "LICENSE"),
    out: "node",
  },
  /* arm64 Linux — a Raspberry Pi desktop, Asahi on Apple silicon, an arm64 workstation or server.
   * Same archive shape as x86_64 Linux and a different download, which is the whole difference:
   * nodejs.org publishes `linux-arm64` beside `linux-x64` in the same release, listed in the same
   * SHASUMS256.txt, so the checksum path above needs nothing added for it.
   *
   * No `slices`: unlike macOS there is no Linux `lipo` and no multi-architecture ELF, so an arm64
   * app carries an arm64-only runtime and the x86_64 app carries an x86_64-only one. The check that
   * each is the RIGHT one is the `--version` execution at the end of this file, which only runs on
   * the matching machine — see the header, and `build.yml`'s two separate cache keys, which is the
   * one place this could go wrong without anything downloading. */
  "linux-arm64": {
    archives: [`node-${VERSION}-linux-arm64.tar.xz`],
    unpack: ["-xJf"],
    binary: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "bin", "node"),
    licence: (name) => path.join(name.replace(/\.tar\.xz$/, ""), "LICENSE"),
    out: "node",
  },
  windows: {
    archives: [`node-${VERSION}-win-x64.zip`],
    /* `tar -xf` and not `unzip`: Windows ships bsdtar as `tar.exe`, which reads zip archives, and
     * `unzip` is not on a Git-Bash PATH. One tool, three platforms, nothing to install — but see
     * TAR below, because "the tar on Windows" is two different programs and only one of them can
     * do this. */
    unpack: ["-xf"],
    binary: (name) => path.join(name.replace(/\.zip$/, ""), "node.exe"),
    licence: (name) => path.join(name.replace(/\.zip$/, ""), "LICENSE"),
    out: "node.exe",
  },
};

/* THE TAR THAT ACTUALLY RUNS, NAMED RATHER THAN LOOKED UP. There are two `tar`s on a Windows runner:
 * `%SystemRoot%\System32\tar.exe` (bsdtar — reads zip, understands `C:\…`) and Git Bash's `/usr/bin/tar`
 * (GNU tar — reads neither). The workflow step runs under `shell: bash`, so node inherits a PATH with Git
 * Bash's bin FIRST and a bare "tar" resolves to GNU tar, which reads the leading `C:` of the temp directory
 * as a REMOTE HOST (`host:path` is its tape-drive syntax) and fails `tar: Cannot connect to C: resolve
 * failed`, naming neither the archive nor the problem — and would then fail again on the zip it cannot read.
 * The spec always meant bsdtar; naming it makes that true rather than a hope about PATH order (macOS and
 * Linux tar is already right). Extraction also runs with `cwd` set and a RELATIVE archive name, so no drive letter reaches any tar. */
const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe")
  : "tar";

/**
 * `process.platform` (and, on Linux, `process.arch`) → the key above. ARCHITECTURE IS PART OF THE ANSWER ON
 * LINUX, and it has to be because of what this value is used for: the vendored binary is EXECUTED only when
 * the target matches the host. A bare `"linux"` on an arm64 machine would make a `--platform linux` run
 * (which fetches the x86_64 archive) look native, and the `--version` check would be attempted on a binary
 * this machine cannot run — reporting "the vendored runtime would not run on this machine" for a request
 * answered exactly as asked. Distinguishing them turns that into the honest line the else-branch prints
 * (vendored for one architecture, on another). macOS is deliberately NOT split: its app is universal and its
 * runtime is `lipo`d from both slices, so one key is the whole truth and an arch-dependent answer would be wrong.
 */
function hostPlatform() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux";
  return null;
}

/* `curl` rather than `fetch`: this runs in sandboxes where node's DNS is unavailable but curl works.
 * `--fail` so a 404 from a mistyped version is an error instead of an HTML page written to the
 * archive and a checksum mismatch three steps later. */
function curl(url, dest) {
  try {
    execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", dest, url], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    die(`could not download ${url}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const args = process.argv.slice(2);
const flag = args.indexOf("--platform");
const target = flag >= 0 ? args[flag + 1] : hostPlatform();
const spec = PLATFORMS[target];
if (!spec) {
  die(`unknown platform ${JSON.stringify(target)} — one of ${Object.keys(PLATFORMS).join(", ")}`);
}

const OUT = path.join(OUT_DIR, spec.out);
const OUT_LICENSE = path.join(OUT_DIR, "node.LICENSE");

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ohmail-node-"));

say(`vendor-node: ${VERSION} for ${target}${ARCHIVE_DIR ? " (offline)" : ""}`);

const pinned = PINS[VERSION] ?? null;

/* The release manifest, ONLINE ONLY, and still first: a bad download is caught before it is
 * unpacked rather than after it has been turned into a binary inside an app. Offline there is no
 * manifest to read, which is why PINS exists. */
let expected = new Map();
if (!ARCHIVE_DIR) {
  const shasums = path.join(work, "SHASUMS256.txt");
  curl(`${DIST}/SHASUMS256.txt`, shasums);
  expected = new Map(
    fs.readFileSync(shasums, "utf8").split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([hash, name]) => [name, hash]),
  );
  if (expected.size === 0) die(`${DIST}/SHASUMS256.txt listed no files — refusing to guess`);
} else if (!pinned) {
  die(`no pinned sha256 digests for ${VERSION}, so it cannot be built offline: OHMAIL_NODE_ARCHIVES\n` +
      `  is set and the release manifest is exactly what that mode cannot fetch. Add ${VERSION}'s\n` +
      `  digests to PINS in this file (${DIST}/SHASUMS256.txt), or unset OHMAIL_NODE_ARCHIVES.`);
}

const binaries = [];
let licenceFrom = null;
for (const name of spec.archives) {
  const pin = pinned?.[name];
  const archive = path.join(work, name);
  let want;

  if (ARCHIVE_DIR) {
    /* The file is named, not searched for: a directory holding the wrong release's archive would
     * otherwise report "missing" for a file that is sitting right there under another version. */
    const supplied = path.join(ARCHIVE_DIR, name);
    if (!pin) die(`${name} has no pinned sha256 for ${VERSION} — refusing to accept it unverified`);
    if (!fs.existsSync(supplied)) {
      die(`offline (OHMAIL_NODE_ARCHIVES=${ARCHIVE_DIR}): expected ${name} in that directory.\n` +
          `  Nothing is downloaded in this mode — put the file there, or unset the variable.`);
    }
    /* Copied in rather than read in place: extraction runs with a RELATIVE name in `work` (see TAR
     * above), and the supplied directory stays untouched. */
    fs.copyFileSync(supplied, archive);
    want = pin;
  } else {
    want = expected.get(name);
    if (!want) die(`${name} is not listed in the release's SHASUMS256.txt`);
    /* The pin is checked against the manifest, not instead of it. This is the only thing that keeps
     * PINS from drifting: without it a wrong pin stays invisible until an offline build refuses a
     * correct archive, with the manifest nowhere in reach to explain it. */
    if (pin && pin !== want) {
      die(`the pinned sha256 for ${name} is not the one the release publishes.\n` +
          `  PINS says   ${pin}\n  release says ${want}\n` +
          `  Fix PINS in this file from ${DIST}/SHASUMS256.txt; an offline build verifies against PINS alone.`);
    }
    curl(`${DIST}/${name}`, archive);
  }

  const got = sha256(archive);
  if (got !== want) {
    die(`${name} does not match the ${ARCHIVE_DIR ? "pinned" : "release"} checksum.\n` +
        `  expected ${want}\n  got      ${got}\n` +
        `  Refusing to build an app around a runtime whose bytes are not the published ones.`);
  }
  say(`  ${name}  sha256 ok${ARCHIVE_DIR ? " (pinned)" : ""}`);

  execFileSync(TAR, [...spec.unpack, name], { cwd: work });
  const binary = path.join(work, spec.binary(name));
  if (!fs.existsSync(binary)) die(`${name} did not contain ${spec.binary(name)}`);
  binaries.push(binary);
  licenceFrom ??= path.join(work, spec.licence(name));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(OUT, { force: true });
if (binaries.length > 1) {
  execFileSync("lipo", ["-create", ...binaries, "-output", OUT]);
} else {
  fs.copyFileSync(binaries[0], OUT);
}
/* Explicitly, and not left to whatever the archive or `lipo` produced. The shell holds the runtime
 * to "runnable, not merely present" — a copy that lost its mode is reported as a build with no Node
 * in it, which reads as a broken install rather than as a broken package. */
fs.chmodSync(OUT, 0o755);

/* The runtime's own licence travels with it. An app that bundles someone else's binary and drops
 * their licence text is not a licensing subtlety, it is a missing file. */
if (!fs.existsSync(licenceFrom)) die("the archive did not contain a LICENSE — refusing to vendor it unlicensed");
fs.copyFileSync(licenceFrom, OUT_LICENSE);

/* Every slice the app has. See `slices` above for why the spelling differs from the download name. */
if (spec.slices) {
  const archs = execFileSync("lipo", ["-archs", OUT], { encoding: "utf8" }).trim().split(/\s+/);
  for (const want of spec.slices) {
    if (!archs.includes(want)) {
      die(`the vendored binary is missing the ${want} slice (has: ${archs.join(" ") || "none"})`);
    }
  }
  say(`  slices: ${archs.join(" ")}`);
}

/* IT RUNS, and this is the only check here that is about the binary rather than about its bytes.
 * A checksum proves the download matched a manifest; it says nothing about whether this machine can
 * execute the result — a wrong architecture, a stripped slice, a missing loader all pass the hash
 * and fail here. Only possible because each platform vendors on its own runner; see the header. */
if (target === hostPlatform()) {
  let reported;
  try {
    reported = execFileSync(OUT, ["--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    die(`the vendored runtime would not run on this machine: ${err.message}`);
  }
  if (reported !== VERSION) die(`the vendored runtime reports ${reported}, not ${VERSION}`);
  say(`  runs: ${reported}`);
} else {
  say(`  (not run: vendored for ${target} on ${hostPlatform() ?? "an unknown platform"})`);
}

fs.rmSync(work, { recursive: true, force: true });

say(`\nvendor-node: ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MiB`);
say(`vendor-node: ${path.relative(ROOT, OUT_LICENSE)}`);
