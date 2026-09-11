#!/usr/bin/env node
/**
 * appstream-releases.mjs — keep the Flatpak metainfo's <releases> block equal to the changelog.
 *
 *     node scripts/appstream-releases.mjs            # check; exit 1 when they disagree
 *     node scripts/appstream-releases.mjs --write    # rewrite the block from the changelog
 *
 * AppStream wants release notes and the changelog already is them, so this derives one from the
 * other rather than letting a second copy exist. The check is what makes a tag that moves
 * `## [Unreleased]` to a version and forgets the metainfo go red instead of shipping a release
 * whose software centre entry stops at the previous one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG = join(ROOT, "public", "ohmail", "CHANGELOG.md");
export const METAINFO = join(ROOT, "apps", "desktop", "flatpak", "app.ohmail.Desktop.metainfo.xml");

/** How many released versions the block carries. Newest first, which is the order AppStream reads. */
export const LIMIT = 5;

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\][^\n]*?(\d{4}-\d{2}-\d{2})\s*$/;
const ITEM_HEADING = /^### (.+?)\s*$/;

/** Changelog prose to one line of AppStream text: no code ticks, no link syntax, no entities. */
export function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

/** Every RELEASED version in the changelog, newest first. `[Unreleased]` has no version and no date
 *  and is therefore not a release — which is the whole reason the check bites at tag time. */
export function releasesFrom(changelog) {
  const out = [];
  let current = null;
  for (const line of changelog.split("\n")) {
    const version = VERSION_HEADING.exec(line);
    if (version) {
      current = { version: version[1], date: version[2], items: [] };
      out.push(current);
      continue;
    }
    if (/^## /.test(line)) { current = null; continue; }
    const item = ITEM_HEADING.exec(line);
    if (item && current) current.items.push(plainText(item[1]));
  }
  return out;
}

export function renderReleases(releases, indent = "  ") {
  const lines = [`${indent}<releases>`];
  for (const { version, date, items } of releases) {
    lines.push(`${indent}  <release version="${version}" date="${date}">`);
    lines.push(`${indent}    <description>`);
    lines.push(`${indent}      <ul>`);
    for (const item of items) lines.push(`${indent}        <li>${item}</li>`);
    lines.push(`${indent}      </ul>`);
    lines.push(`${indent}    </description>`);
    lines.push(`${indent}  </release>`);
  }
  lines.push(`${indent}</releases>`);
  return lines.join("\n");
}

const BLOCK = /^[ \t]*<releases>[\s\S]*?^[ \t]*<\/releases>/m;

/** The metainfo with its <releases> block replaced. Refuses a file that has none, rather than
 *  appending one somewhere the schema does not allow it. */
export function withReleases(metainfo, block) {
  if (!BLOCK.test(metainfo)) throw new Error("the metainfo has no <releases> block to replace");
  return metainfo.replace(BLOCK, block);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const wanted = withReleases(
    readFileSync(METAINFO, "utf8"),
    renderReleases(releasesFrom(readFileSync(CHANGELOG, "utf8")).slice(0, LIMIT)),
  );
  const have = readFileSync(METAINFO, "utf8");
  if (have === wanted) {
    process.stdout.write("appstream-releases: the metainfo matches the changelog\n");
    process.exit(0);
  }
  if (write) {
    writeFileSync(METAINFO, wanted);
    process.stdout.write("appstream-releases: rewrote the <releases> block\n");
    process.exit(0);
  }
  process.stderr.write(
    "\nappstream-releases: the metainfo's <releases> block is not what the changelog says.\n" +
    "  Run `node scripts/appstream-releases.mjs --write` and commit the result.\n",
  );
  process.exit(1);
}
