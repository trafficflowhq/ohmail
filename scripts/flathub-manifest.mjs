#!/usr/bin/env node
/**
 * flathub-manifest.mjs — render the Flathub submission manifest from the one in this repository.
 *
 *     node scripts/flathub-manifest.mjs --tag v0.19.0 --commit <40-hex> [-o <file>]
 *
 * Flathub builds a TAG; this repository's manifest builds the checkout it sits in. The two differ
 * in exactly one place — the app module's first source — so the pinned copy is derived and
 * `--check` asserts that is the only difference. A second hand-maintained manifest is how a
 * permission added here fails to reach the one people actually install.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST = join(ROOT, "apps", "desktop", "flatpak", "app.ohmail.desktop.yml");
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : null;
  };
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
