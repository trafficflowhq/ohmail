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
 * thing that stops that happening quietly. */
const WANT = ["windows-x86_64", "linux-x86_64", "linux-aarch64", "darwin-aarch64", "darwin-x86_64"];
for (const k of WANT) {
  const entry = latest.platforms?.[k];
  if (!entry) { bad(`platforms.${k} is missing — those clients would never update again`); continue; }
  if (!entry.url || !entry.signature) { bad(`platforms.${k} has no ${entry.url ? "signature" : "url"}`); continue; }
  const file = path.join(assetsDir, path.basename(new URL(entry.url).pathname));
  if (!fs.existsSync(file)) { bad(`${k}: ${path.basename(file)} is not in the asset set`); continue; }
  const r = minisignVerify(tauriPub, entry.signature, fs.readFileSync(file));
  if (r.ok) { ok(`${k}: ${path.basename(file)} — ${r.why}`); verified++; } else bad(`${k}: ${path.basename(file)} — ${r.why}`);
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
 * The filename is the only statement of architecture anywhere in the feed, so the filename is what
 * is checked, by exact name. Restated here rather than derived from the manifest on purpose: a
 * check that reads the value it is checking proves the value equals itself. These are the names
 * `build.yml`'s header calls a contract, and this is the other party to it. */
const LINUX_PAYLOAD = {
  "linux-x86_64": "ohmail-linux-x86_64.AppImage",
  "linux-aarch64": "ohmail-linux-aarch64.AppImage",
};
const seen = new Map();
for (const [k, want] of Object.entries(LINUX_PAYLOAD)) {
  const url = latest.platforms?.[k]?.url;
  if (!url) continue; // already reported as missing above; not reported twice
  const got = path.basename(new URL(url).pathname);
  if (got !== want) {
    bad(`platforms.${k} points at ${got}, which is not ${want} — that architecture's installs `
      + "would be offered a payload that cannot run on them");
  }
  const first = seen.get(got);
  if (first) bad(`platforms.${first} and platforms.${k} both point at ${got}`);
  else seen.set(got, k);
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

console.log(failures
  ? `\n${failures} FAILURE(S) — ${verified} signature(s) verified\n`
  : `\nboth feeds verify offline against the committed public keys (${verified} signatures)\n`);
process.exit(failures ? 1 : 0);
