#!/usr/bin/env node
/**
 * flathub-manifest.mjs — render the Flathub submission manifest from the one in this repository,
 * and check that the offline sources beside it are still the lockfiles'.
 *
 *     node scripts/flathub-manifest.mjs --tag v0.19.0 --commit <40-hex> [-o <file>]
 *     node scripts/flathub-manifest.mjs --check [--mirror <published checkout>]
 *
 * Flathub builds a TAG; this repository's manifest builds the checkout it sits in. The two differ
 * in exactly one place — the app module's first source — so the pinned copy is derived and the
 * test asserts that is the only difference. A second hand-maintained manifest is how a permission
 * added here fails to reach the one people actually install.
 *
 * `--check` is the other half: `cargo-sources.json` and `node-sources.json` are GENERATED, and a
 * dependency bump that leaves them behind is not visible until `npm ci --offline` fails inside a
 * Flathub builder, at review time. Every checksum a lockfile names must be a source here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLATPAK = join(ROOT, "apps", "desktop", "flatpak");
export const MANIFEST = join(FLATPAK, "app.ohmail.Desktop.yml");
export const CARGO_SOURCES = join(FLATPAK, "cargo-sources.json");
export const NODE_SOURCES = join(FLATPAK, "node-sources.json");
export const CARGO_LOCK = join(ROOT, "apps", "desktop", "src-tauri", "Cargo.lock");
export const DESKTOP_LOCK = join(ROOT, "apps", "desktop", "package-lock.json");
export const REPO_URL = "https://github.com/trafficflowhq/ohmail.git";

/** The `type: dir` source, with its `skip:` list — everything up to the next list item. */
const DIR_SOURCE = /^( *)- type: dir\n(?:\1 .*\n|\1{2,}.*\n|\n)*?(?=\1- )/m;

export function pinnedSource(indent, tag, commit) {
  return [
    `${indent}- type: git`,
    `${indent}  url: ${REPO_URL}`,
    `${indent}  tag: ${tag}`,
    `${indent}  commit: ${commit}`,
    "",
  ].join("\n");
}

export function render(manifest, tag, commit) {
  const found = DIR_SOURCE.exec(manifest);
  if (!found) throw new Error("the manifest has no `type: dir` source to pin");
  return manifest.replace(DIR_SOURCE, pinnedSource(found[1], tag, commit));
}

/** Every `checksum = "…"` a Cargo.lock names. These are exactly the crates the build must resolve. */
export function cargoChecksums(lock) {
  return [...lock.matchAll(/^checksum = "([0-9a-f]{64})"$/gm)].map((found) => found[1]);
}

/** Every sha512 integrity an npm lockfile names, in the hex spelling the generated sources use. */
export function npmIntegrities(lockJson) {
  const packages = JSON.parse(lockJson).packages ?? {};
  const out = [];
  for (const entry of Object.values(packages)) {
    const integrity = entry?.integrity;
    if (typeof integrity === "string" && integrity.startsWith("sha512-")) {
      out.push(Buffer.from(integrity.slice(7), "base64").toString("hex"));
    }
  }
  return out;
}

/** The checksums a lockfile names and the generated file does not declare. Empty means current. */
export function missingSources(wanted, sources, field) {
  const have = new Set(sources.filter((source) => source[field]).map((source) => source[field]));
  return [...new Set(wanted)].filter((checksum) => !have.has(checksum));
}

/**
 * The whole check, as lines. One entry per lockfile, so a refusal names WHICH tree drifted: the
 * crates and the desktop's npm tree are in this repository, and the root npm lockfile is written
 * by the publisher and only exists in a published checkout — pass `--mirror` to include it.
 */
export function checkSources({ mirror = null } = {}) {
  const cargo = JSON.parse(readFileSync(CARGO_SOURCES, "utf8"));
  const node = JSON.parse(readFileSync(NODE_SOURCES, "utf8"));
  const out = [
    { lock: "apps/desktop/src-tauri/Cargo.lock", file: "cargo-sources.json",
      missing: missingSources(cargoChecksums(readFileSync(CARGO_LOCK, "utf8")), cargo, "sha256") },
    { lock: "apps/desktop/package-lock.json", file: "node-sources.json",
      missing: missingSources(npmIntegrities(readFileSync(DESKTOP_LOCK, "utf8")), node, "sha512") },
  ];
  if (mirror !== null) {
    const rootLock = join(mirror, "package-lock.json");
    if (!existsSync(rootLock)) {
      throw new Error(`flathub-manifest: ${rootLock} does not exist — --mirror wants a published checkout`);
    }
    out.push({ lock: `${rootLock}`, file: "node-sources.json",
      missing: missingSources(npmIntegrities(readFileSync(rootLock, "utf8")), node, "sha512") });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : null;
  };
  if (argv.includes("--check")) {
    const mirror = value("--mirror") ?? process.env.OHMAIL_MIRROR ?? null;
    const rows = checkSources({ mirror });
    let stale = 0;
    for (const row of rows) {
      const count = row.missing.length;
      stale += count;
      process.stdout.write(`flathub-manifest: ${row.file} vs ${row.lock} — ${count} missing\n`);
      for (const checksum of row.missing.slice(0, 10)) process.stdout.write(`    ${checksum}\n`);
    }
    if (mirror === null) {
      process.stdout.write("flathub-manifest: the published root package-lock.json was not checked " +
        "(pass --mirror <checkout>) — it is the one a Flathub build installs first\n");
    }
    if (stale > 0) {
      process.stderr.write("\nflathub-manifest: a generated source file is behind its lockfile. " +
        "An offline build resolves only what is declared, so this is a build failure at review " +
        "time. Regenerate both files (apps/desktop/flatpak/REVIEW-NOTES.md names the commands).\n");
      process.exit(1);
    }
    process.stdout.write("flathub-manifest: every checksum the lockfiles name is a declared source\n");
    process.exit(0);
  }
  const tag = value("--tag");
  const commit = value("--commit");
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    process.stderr.write("flathub-manifest: --tag vX.Y.Z is required\n");
    process.exit(2);
  }
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    process.stderr.write("flathub-manifest: --commit <40-hex> is required — the tag alone is a " +
      "moving target, and Flathub records both\n");
    process.exit(2);
  }
  const out = value("-o");
  const rendered = render(readFileSync(MANIFEST, "utf8"), tag, commit);
  if (out) {
    writeFileSync(out, rendered);
    process.stdout.write(`flathub-manifest: wrote ${out} at ${tag} (${commit})\n`);
  } else {
    process.stdout.write(rendered);
  }
}
