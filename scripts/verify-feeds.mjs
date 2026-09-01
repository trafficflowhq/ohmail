#!/usr/bin/env node
/**
 * verify-feeds.mjs — check both update feeds against the public keys committed in this tree.
 *
 *     node scripts/verify-feeds.mjs <repo-root> <assets-dir> <latest.json> <appcast-macos.xml>
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *
 * The apps are unsigned by any operating system's code-signing scheme, so the ONLY thing
 * standing between an updater and running whatever it was handed is the detached signature on
 * the payload. Two independent keypairs do that job — minisign for the clients that read
 * `latest.json`, Ed25519 for the ones that read the Sparkle appcast — and the matching PUBLIC
 * halves are committed here, in `apps/desktop/src-tauri/tauri.conf.json` and in
 * `Resources/Info.plist`.
 *
 * Nothing had ever checked that the two halves still agree. If a private signing key is rotated
 * without its committed public half, every installed client rejects the update — silently, and
 * for ever, because "signature did not verify" is not a thing a user is shown. This is that
 * check, and it deliberately trusts nothing the feed says about itself: the keys come out of the
 * tree, the payloads are the files on disk, and the signatures are the ones the feed carries.
 *
 * It is entirely offline and needs nothing installed. Both schemes are Ed25519 underneath, so
 * `node:crypto` is the whole dependency list — the point of a verifier is that a stranger can
 * run it against a download, and one that first wants a package tree is one nobody runs.
 *
 * ── EXIT ──────────────────────────────────────────────────────────────────────────────────
 *
 * Non-zero on any failure, and also on a feed that gives it nothing to check: a run that
 * verified no signatures at all must never be reported as a run that found nothing wrong.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [root, assetsDir, latestPath, appcastPath] = process.argv.slice(2);
if (!root || !assetsDir || !latestPath || !appcastPath) {
  console.error("usage: node scripts/verify-feeds.mjs <repo-root> <assets-dir> <latest.json> <appcast-macos.xml>");
  process.exit(2);
}

let failures = 0;
let verified = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failures++; };

/** A raw 32-byte Ed25519 public key, wrapped in the SPKI envelope `crypto` wants. */
function ed25519Key(raw) {
  if (raw.length !== 32) throw new Error(`an Ed25519 public key is 32 bytes, got ${raw.length}`);
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), // SPKI prefix for Ed25519
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * minisign, as the updater's own verifier implements it.
 *
 * A minisign public key is base64 of: 2-byte algorithm, 8-byte key id, 32-byte key. A signature
 * is base64 of a small TEXT DOCUMENT whose second line is base64 of: 2-byte algorithm, 8-byte
 * key id, 64-byte signature. Algorithm `ED` means the signed message is BLAKE2b-512 of the file;
 * `Ed` means the file itself. The signer used here writes `ED`.
 *
 * ── THE DECODE ORDER, WHICH IS THE ONE THING TO GET RIGHT ─────────────────────────────────
 *
 * The config stores the public key as base64 of the WHOLE minisign key FILE — comment line and
 * all. So it must be decoded to TEXT FIRST and only then split into comment line plus key line.
 * Filtering comment lines off the base64 STRING instead is a silent no-op, because that string
 * has no newlines in it; decoding the lot then reads the file's own text as if it were key
 * bytes, so the first two characters become the "algorithm" and the next eight, `trusted `,
 * become the "key id" — 7472757374656420 — and every signature fails with a key-id mismatch
 * that looks exactly like a key rotation. The signature path below is the same two steps in the
 * same order, which is what makes the shape easy to get right once it is written down.
 */
function minisignVerify(pubB64, sigB64, payload) {
  const comment = (l) => l.startsWith("untrusted comment:") || l.startsWith("trusted comment:");
  const firstKeyLine = (text) => text.split("\n").filter((l) => l && !comment(l))[0];

  const pkLine = firstKeyLine(Buffer.from(pubB64.trim(), "base64").toString("utf8"));
  if (!pkLine) return { ok: false, why: "the committed public key has no key line" };
  const pk = Buffer.from(pkLine.trim(), "base64");
  const pkAlg = pk.subarray(0, 2).toString("utf8");
  const pkId = pk.subarray(2, 10);
  const pkRaw = pk.subarray(10, 42);

  const sigLine = firstKeyLine(Buffer.from(sigB64.trim(), "base64").toString("utf8"));
  if (!sigLine) return { ok: false, why: "the signature has no signature line" };
  const sig = Buffer.from(sigLine.trim(), "base64");
  const sigAlg = sig.subarray(0, 2).toString("utf8");
  const sigId = sig.subarray(2, 10);
  const raw = sig.subarray(10, 74);

  if (!pkId.equals(sigId)) {
    return {
      ok: false,
      why: `key id mismatch (committed ${pkId.toString("hex")}, signature ${sigId.toString("hex")}) `
        + "— the signing key and the committed public key are not a pair",
    };
  }
  const message = sigAlg === "ED"
    ? crypto.createHash("blake2b512").update(payload).digest()
    : payload;
  const good = crypto.verify(null, message, ed25519Key(pkRaw), raw);
  return {
    ok: good,
    why: good
      ? `${sigAlg} over ${payload.length} bytes, key id ${pkId.toString("hex")}`
      : `signature does not verify (alg ${sigAlg}, public key alg ${pkAlg})`,
  };
}

/* ── WHAT THE SIGNATURE SAYS THE PAYLOAD IS ───────────────────────────────────────────────────
 *
 * `minisignVerify` proves a signature over some bytes. It says nothing about WHICH RELEASE those
 * bytes are, and the manifest's own `version` field cannot answer that either, because the
 * manifest is not signed. That gap is a downgrade of every install available to anyone who can
 * write `latest.json` without holding the key: advertise a high version over an old release's
 * genuine artifact and every signature here still verifies.
 *
 * The release closes it by signing each artifact under the name `<version>@<asset>`, which puts
 * the version in the minisign TRUSTED COMMENT — covered by the global signature, so it is signed
 * metadata. `updater.rs::signed_release` reads it and refuses any payload it cannot read a
 * version out of.
 *
 * This is the check that keeps that arrangement honest, and it exists because the failure is
 * SILENT IN THE WRONG DIRECTION: if the signing step ever stops naming the version, clients do
 * not error, they refuse every update for ever and report "up to date". Nobody files that. So the
 * publish fails here instead.
 *
 * The name is compared as a whole string, restated rather than derived from the same expression
 * the workflow uses — a check that rebuilds the value the same way the producer did agrees with
 * the producer by construction. */
function signedName(sigB64) {
  const text = Buffer.from(sigB64, "base64").toString("utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("trusted comment: "));
  if (!line) return null;
  const field = line.slice("trusted comment: ".length).split("\t").find((f) => f.startsWith("file:"));
  return field ? field.slice("file:".length) : null;
}

/* The plist sits at the repository root in the published tree and under the templates directory
 * in the workspace it is published FROM. Both are tried so one script serves both trees — a
 * verifier that runs in only one of them is one that gets skipped in the other. */
function readFirst(...candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return { path: c, text: fs.readFileSync(c, "utf8") };
  return null;
}

// ── the Tauri feed: minisign over each platform's artifact ───────────────────────────────────
const confPath = path.join(root, "apps/desktop/src-tauri/tauri.conf.json");
const tauriPub = JSON.parse(fs.readFileSync(confPath, "utf8")).plugins?.updater?.pubkey;
if (!tauriPub) { console.error(`no plugins.updater.pubkey in ${confPath}`); process.exit(1); }
const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));

console.log(`\nlatest.json — version ${latest.version}`);
/* EVERY PLATFORM, INDIVIDUALLY. The two darwin entries point at ONE archive and carry ONE
 * signature, so a loop that deduplicated by (url, signature) would verify four files, report
 * everything verified, and say nothing at all about a manifest that had lost a platform key. A
 * client whose key is missing does not error — it stops updating.
 *
 * ── THE LIST IS EXHAUSTIVE IN BOTH DIRECTIONS, AND THAT IS THE POINT ─────────────────────────
 *
 * A key missing from the manifest is a failure (the loop below), and a key in the manifest that is
 * not on this list is ALSO a failure (the loop after it). The second half is the unusual one and it
 * is deliberate: `latest.json` is remote code delivery, so every entry in it has to be an entry
 * somebody decided to publish. Extending this list is how that decision is recorded; loosening the
 * refusal would delete the record.
 *
 * ── WHY `linux-aarch64` IS HERE ──────────────────────────────────────────────────────────────
 *
 * Linux ships two artifacts, one per architecture, and unlike macOS neither runs on the other's
 * machine. `tauri-plugin-updater` composes its key as `{os}-{arch}` from the RUNNING binary —
 * `updater.rs::updater_arch` in 2.10.1 maps `cfg!(target_arch = "aarch64")` to the string
 * "aarch64" — and looks it up exactly, with no fallback to another architecture. So an arm64
 * install asks for this key and only this key; without it, every arm64 install would check for
 * updates, find nothing addressed to it, and stay where it is for ever.
 *
 * ── AND WHY THERE IS NO `-deb` KEY FOR EITHER ARCHITECTURE ──────────────────────────────────
 *
 * The same updater asks for `{os}-{arch}-{installer}` FIRST when the binary carries a bundle-type
 * marker, so a deb-installed build looks for `linux-x86_64-deb` / `linux-aarch64-deb` before the
 * plain key. Those are not published, on purpose: the fallback hands such a build an AppImage it
 * refuses to install (watched, at 0.12.1, on an Arch install), and the alternative — publishing a
 * `-deb` key so the updater shells out to dpkg — is an install path this project has no way to
 * exercise on any machine it builds from. A `.deb` install updates through the package manager it
 * came from, which is what the README, the CHANGELOG and the AUR package all say. Adding a key
 * here to make a red go green would publish an untested install path; the refusal below is the
 * thing that stops that happening quietly.
 *
 * ── AND WHY THE LIST DEPENDS ON THE VERSION ──────────────────────────────────────────────────
 *
 * This verifier is meant to be run by anyone against any download, including an OLD one, and the
 * release workflow can be dispatched by hand against an old tag to rebuild a feed that went
 * missing — the recovery path that exists so a stranded client is not stranded for ever. Releases
 * before 0.13.3 published no arm64 artifact at all, so demanding `linux-aarch64` of them would
 * report every one of those feeds as broken and refuse to regenerate any of them.
 *
 * The floor is therefore a version comparison rather than a fixed list, and it is asserted in BOTH
 * directions: at or above the floor the key is required, below it the key must be ABSENT. A
 * one-directional rule would let an old release quietly carry a key nothing built for it. */
const ARM_LINUX_FROM = [0, 13, 3];

/** `1.2.3` → `[1, 2, 3]`, and anything that is not three numbers is not a version. */
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function atLeast(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

const feedVersion = semver(latest.version);
if (!feedVersion) { console.error(`latest.json version ${JSON.stringify(latest.version)} is not a semver`); process.exit(1); }
const armLinux = atLeast(feedVersion, ARM_LINUX_FROM);
console.log(`  (arm64 Linux ${armLinux ? "expected" : "not expected"} at ${latest.version} — the floor is ${ARM_LINUX_FROM.join(".")})`);

const WANT = armLinux
  ? ["windows-x86_64", "linux-x86_64", "linux-aarch64", "darwin-aarch64", "darwin-x86_64"]
  : ["windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64"];
for (const k of WANT) {
  const entry = latest.platforms?.[k];
  if (!entry) { bad(`platforms.${k} is missing — those clients would never update again`); continue; }
  if (!entry.url || !entry.signature) { bad(`platforms.${k} has no ${entry.url ? "signature" : "url"}`); continue; }
  /* AND THEY ARE STRINGS. `latest.json` is parsed, not validated, so a `signature` that is a
   * number or an object is truthy and reaches `Buffer.from(value, "base64")`, which throws a
   * TypeError rather than returning anything. An uncaught throw here exits non-zero — it does
   * not pass — but it aborts the loop, so the remaining platforms go unchecked, the
   * architecture and checksum sections never run, and no summary line is printed. This file's
   * own header says a run that verified no signatures must never look like a run that found
   * nothing wrong; dying halfway is that failure with a stack trace on top. Reported as one
   * ordinary FAIL instead, so everything after it is still measured. */
  if (typeof entry.url !== "string" || typeof entry.signature !== "string") {
    bad(`platforms.${k}: url and signature must be strings (got ${typeof entry.url} and ${typeof entry.signature})`);
    continue;
  }
  const file = path.join(assetsDir, path.basename(new URL(entry.url).pathname));
  if (!fs.existsSync(file)) { bad(`${k}: ${path.basename(file)} is not in the asset set`); continue; }
  const r = minisignVerify(tauriPub, entry.signature, fs.readFileSync(file));
  if (r.ok) { ok(`${k}: ${path.basename(file)} — ${r.why}`); verified++; } else bad(`${k}: ${path.basename(file)} — ${r.why}`);
  /* And the signed name, which is the only place the version is not a bare assertion by
   * whoever wrote the feed. Both halves are checked: the version, so a client's downgrade
   * guard has something to compare against, and the asset, so a signature made over one
   * platform's payload cannot be presented under another platform's key. */
  const want = `${latest.version}@${path.basename(file)}`;
  const got = signedName(entry.signature);
  if (got === want) ok(`${k}: signed as ${got} — the version is inside the signature`);
  else if (got === null) bad(`${k}: the signature carries no file name in its trusted comment`);
  else bad(`${k}: signed as ${JSON.stringify(got)}, expected ${JSON.stringify(want)} — `
    + `a client reading the version out of the signature would refuse this payload`);
}
/* The count is asserted rather than inferred from "no failures": a manifest carrying extra keys
 * and none of the four would produce no failures above and nothing verified. */
if (verified !== WANT.length) bad(`${verified} of ${WANT.length} platform signatures verified`);
for (const k of Object.keys(latest.platforms ?? {})) {
  if (!WANT.includes(k)) bad(`platforms.${k} is a key no shipped client asks for`);
}

/* ── THE ARCHITECTURE IN THE KEY AND THE ARCHITECTURE IN THE PAYLOAD ARE THE SAME ONE ────────
 *
 * Everything above proves a signature over some bytes. Nothing above proves those bytes RUN on the
 * machine that asked for them — a signature says who produced a file, never what it is for. The two
 * Linux entries name two different artifacts, and if they were swapped, or if both named one file,
 * every signature here would verify and every arm64 install would be handed an x86_64 binary. That
 * is not a hypothetical shape: the release workflow selected its Linux payload with a
 * `*.AppImage` glob ending in `head -1` for as long as there was only one, and a second AppImage
 * turns that into an arbitrary pick between the two.
 *
 * TWO CHECKS, BECAUSE THE FILENAME IS NOT EVIDENCE OF WHAT IS INSIDE IT.
 *
 *   1. The URL names the artifact this key's architecture is built as, by exact name. Restated
 *      here rather than derived from the manifest on purpose — a check that reads the value it is
 *      checking proves the value equals itself. These are the names `build.yml`'s header calls a
 *      contract, and this is the other party to it. It catches a manifest pointed at the wrong
 *      file, which is the mistake a glob makes.
 *
 *   2. The BYTES say the same thing. An AppImage is an ELF executable with a filesystem appended,
 *      and that outer ELF is the AppImage runtime — compiled for the architecture the payload is
 *      for. So the file itself carries the answer, in `e_machine` at offset 0x12 of its header,
 *      and it can be read with no tools at all. This catches what (1) cannot: two correctly-named
 *      files whose CONTENTS were swapped during a hand-assembled release, where every signature
 *      still verifies because the signatures are made after the swap.
 *
 * (1) alone was what this check did when it was first written, and the comment claimed it
 * established that an arm64 install gets bytes that run. It established that a NAME was right.
 * Nothing here may claim more than the thing it reads. */
const LINUX_PAYLOAD = {
  "linux-x86_64": { asset: "ohmail-linux-x86_64.AppImage", machine: 0x3e, arch: "x86-64" },
  "linux-aarch64": { asset: "ohmail-linux-aarch64.AppImage", machine: 0xb7, arch: "AArch64" },
};
/** `e_machine` out of an ELF header, or null if this is not a little-endian ELF at all. */
function elfMachine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) < 20) return null;
    if (head.subarray(0, 4).toString("latin1") !== "\x7fELF") return null;
    if (head[5] !== 1) return null; // EI_DATA: both architectures here are little-endian
    return head.readUInt16LE(18);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const seen = new Map();
for (const [k, want] of Object.entries(LINUX_PAYLOAD)) {
  const url = latest.platforms?.[k]?.url;
  if (!url) continue; // already reported as missing above; not reported twice
  const got = path.basename(new URL(url).pathname);
  if (got !== want.asset) {
    bad(`platforms.${k} points at ${got}, which is not ${want.asset} — that architecture's installs `
      + "would be offered a payload that cannot run on them");
  }
  const first = seen.get(got);
  if (first) bad(`platforms.${first} and platforms.${k} both point at ${got}`);
  else seen.set(got, k);

  const file = path.join(assetsDir, got);
  if (!fs.existsSync(file)) continue; // already reported above
  const machine = elfMachine(file);
  if (machine === null) {
    bad(`${k}: ${got} is not a little-endian ELF — an AppImage's own runtime is one, so this is `
      + "not the artifact the feed says it is");
  } else if (machine !== want.machine) {
    const other = Object.values(LINUX_PAYLOAD).find((p) => p.machine === machine);
    bad(`${k}: ${got} is built for ${other ? other.arch : `ELF machine 0x${machine.toString(16)}`}, `
      + `not ${want.arch} — the filename and the signature are both right and the bytes are not`);
  } else {
    ok(`${k}: ${got} is ${want.arch} in its own ELF header`);
  }
}

/* ── SHA256SUMS: THE CHECKSUMS THE DOWNLOAD PAGE PROMISES, CHECKED ───────────────────────────
 *
 * The releases publish a `SHA256SUMS` covering every binary asset, because the page that links
 * the downloads offers "notes and checksums" beside the sentence saying the builds are unsigned —
 * and for a long time the checksums did not exist. A file nobody verifies is decoration, and a
 * decorative checksum file beside an unsigned binary is worse than none: it invites a reader to
 * believe a check happened.
 *
 * So it is checked here, in the same run that checks the signatures, and against the same bytes.
 * The two claims are different and both are wanted: a signature says the project produced these
 * bytes, a checksum lets a reader confirm the bytes they hold are the ones the release names,
 * without any key material at all.
 *
 * REQUIRED at or above the version that started publishing it, optional below — the same shape as
 * the arm64 key, and for the same reason. A verifier that shrugs at a missing checksum file
 * certifies an incomplete current release: the file can be missing because an upload failed or a
 * download was truncated, and both of those are exactly what a reader runs this to find out.
 * What is NOT optional either way is the coverage: when the file is there, every payload a
 * signature was verified over must appear in it, or the checksum file is quietly narrower than
 * the release it claims to describe.
 *
 * CHECKSUM MATCHES ARE COUNTED SEPARATELY FROM SIGNATURES, and that is not bookkeeping. The
 * closing line reports how many SIGNATURES were verified, and the last guard in this file refuses
 * a run that verified none — a run that checked nothing must never read as a run that found
 * nothing wrong. Folding hashes into that counter would let a release with no valid signature at
 * all satisfy the guard on checksums alone, and would print a number that is not true. */
const SUMS_FROM = [0, 13, 3];
const sumsExpected = atLeast(feedVersion, SUMS_FROM);
const sumsPath = path.join(assetsDir, "SHA256SUMS");
let sumsOk = 0;
if (!fs.existsSync(sumsPath)) {
  if (sumsExpected) {
    console.log("\nSHA256SUMS");
    bad(`SHA256SUMS is not in the asset set, and every release from ${SUMS_FROM.join(".")} publishes one `
      + "— an upload that failed or a download that did not finish looks exactly like this");
  } else {
    console.log(`\nSHA256SUMS — not attached at ${latest.version} (published from ${SUMS_FROM.join(".")} onward)`);
  }
} else {
  console.log("\nSHA256SUMS");
  const listed = new Set();
  for (const line of fs.readFileSync(sumsPath, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64})\s[\s*](.+)$/.exec(line.trimEnd());
    if (!line.trim()) continue;
    if (!m) { bad(`SHA256SUMS has a line that is not "<64 hex>  <name>": ${line.slice(0, 60)}`); continue; }
    const [, want, name] = m;
    listed.add(name);
    const file = path.join(assetsDir, name);
    if (!fs.existsSync(file)) { bad(`SHA256SUMS names ${name}, which is not in the asset set`); continue; }
    const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (got === want) { ok(`${name} — sha256 ${want.slice(0, 16)}…`); sumsOk++; }
    else bad(`${name} — SHA256SUMS says ${want.slice(0, 16)}…, the file is ${got.slice(0, 16)}…`);
  }
  for (const k of WANT) {
    const url = latest.platforms?.[k]?.url;
    if (!url) continue;
    const name = path.basename(new URL(url).pathname);
    if (!listed.has(name)) bad(`${name} is a published payload and SHA256SUMS does not list it`);
  }
}

// ── the Sparkle appcast: raw Ed25519 over the archive ────────────────────────────────────────
const plist = readFirst(
  path.join(root, "Resources/Info.plist"),
  path.join(root, "public/ohmail/Resources/Info.plist"),
);
if (!plist) { console.error(`no Resources/Info.plist under ${root}`); process.exit(1); }
const sparklePub = /<key>SUPublicEDKey<\/key>\s*<string>([^<]*)<\/string>/.exec(plist.text)?.[1];
if (!sparklePub) { console.error(`no SUPublicEDKey in ${plist.path}`); process.exit(1); }

const xml = fs.readFileSync(appcastPath, "utf8");
const encl = /<enclosure([^>]*)\/>/.exec(xml)?.[1] ?? "";
const attr = (n) => new RegExp(`${n}="([^"]*)"`).exec(encl)?.[1];
const sparkleVersion = /<sparkle:version>([^<]*)<\/sparkle:version>/.exec(xml)?.[1];

console.log(`\nappcast-macos.xml — sparkle:version ${sparkleVersion}`);
/* THE HANDOVER FLOOR, deliberately duplicated from the workflow that writes the feed.
 *
 * The macOS client that Sparkle serves is the previous, separate application, and it decides
 * "is this newer" by comparing this integer against its own installed build number. Those were
 * numbered up to 291. Anything at or below that is an appcast no installed Mac will ever act
 * on, and it fails the way nobody reports: the client says it is up to date.
 *
 * Stating it here as well as where the feed is generated is the point — a check that lives only
 * inside the thing it checks disappears the moment that thing is edited. */
const LAST_HANDOVER_BUILD = 291;
if (!sparkleVersion || !/^\d+$/.test(sparkleVersion)) {
  bad(`sparkle:version "${sparkleVersion}" is not an integer build number`);
} else if (Number(sparkleVersion) <= LAST_HANDOVER_BUILD) {
  bad(`sparkle:version ${sparkleVersion} is not above ${LAST_HANDOVER_BUILD} — every installed Mac would read it as a downgrade and refuse it, silently`);
} else {
  ok(`handover floor: ${sparkleVersion} > ${LAST_HANDOVER_BUILD}`);
}

const encUrl = attr("url");
const encLen = attr("length");
const encSig = attr("sparkle:edSignature");
if (!encUrl || !encLen || !encSig) {
  bad(`the enclosure is missing ${[["url", encUrl], ["length", encLen], ["sparkle:edSignature", encSig]].filter(([, v]) => !v).map(([n]) => n).join(", ")}`);
} else {
  const encFile = path.join(assetsDir, path.basename(new URL(encUrl).pathname));
  if (!fs.existsSync(encFile)) bad(`the enclosure ${path.basename(encFile)} is not in the asset set`);
  else {
    const bytes = fs.readFileSync(encFile);
    if (String(bytes.length) !== String(encLen)) bad(`enclosure length says ${encLen}, the file is ${bytes.length}`);
    else ok(`enclosure length ${encLen} matches the file`);
    if (crypto.verify(null, bytes, ed25519Key(Buffer.from(sparklePub, "base64")), Buffer.from(encSig, "base64"))) {
      ok("EdDSA signature verifies against the committed SUPublicEDKey");
      verified++;
    } else {
      bad("EdDSA signature does NOT verify against the committed SUPublicEDKey "
        + "— the signing key and the committed public key are not a pair");
    }
  }
}

/* A run that checked nothing is a failure, not a pass. This is the shape that turns a broken
 * invocation — wrong directory, empty asset set, a feed the parser did not understand — into a
 * green tick, and it is the reason a gate stops being evidence. */
if (verified === 0) bad("no signature was verified at all — nothing here was actually checked");

/* Reported apart from the signatures, for the reason the SHA256SUMS block gives at length: these
 * are two different claims, and one number covering both would be true of neither. */
const sumsNote = sumsOk ? ` · ${sumsOk} checksum(s) matched` : "";
console.log(failures
  ? `\n${failures} FAILURE(S) — ${verified} signature(s) verified${sumsNote}\n`
  : `\nboth feeds verify offline against the committed public keys (${verified} signatures)${sumsNote}\n`);
process.exit(failures ? 1 : 0);
