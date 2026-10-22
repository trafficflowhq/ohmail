/**
 * THE INSTALLED COPIES OF A PATCHED NATIVE PACKAGE, AND WHETHER THEY CARRY THE PATCH.
 *
 * `scripts/apply-patches.mjs` patches every installed copy after `npm ci`; the phone's native build
 * compiles the copy autolinking resolves from `apps/mobile`. These read both, and read a copy against
 * its patch's own lines: every line it adds is present, every line it removes is gone. Nothing here
 * returns quietly: a package that does not resolve throws, naming it and where it was asked from.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The real directory `name` resolves to from `from`, through node's own resolution. */
export function resolvedFrom(from: string, name: string): string {
  try {
    return dirname(realpathSync(createRequire(join(realpathSync(from), "noop.js")).resolve(`${name}/package.json`)));
  } catch (err) {
    throw new Error(`${name} does not resolve from ${from} (${(err as NodeJS.ErrnoException).code ?? String(err)}): install the workspace first`);
  }
}

/** The version a package directory declares. */
export const versionOf = (dir: string): string =>
  (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;

/**
 * Every installed copy of `name` under the root's `node_modules` and each workspace's own, nested
 * copies included, as real paths. A symlink is a workspace link, not a copy, and is not followed.
 */
export function installedCopies(root: string, name: string): string[] {
  const out = new Set<string>();
  const walk = (modules: string): void => {
    if (!existsSync(modules)) return;
    for (const e of readdirSync(modules, { withFileTypes: true })) {
      if (e.name.startsWith(".") || !e.isDirectory()) continue;
      const at = join(modules, e.name);
      const pkgs = e.name.startsWith("@")
        ? readdirSync(at, { withFileTypes: true }).filter((s) => s.isDirectory()).map((s) => [`${e.name}/${s.name}`, join(at, s.name)] as const)
        : [[e.name, at] as const];
      for (const [key, dir] of pkgs) {
        if (key === name && existsSync(join(dir, "package.json"))) out.add(realpathSync(dir));
        walk(join(dir, "node_modules"));
      }
    }
  };
  walk(join(root, "node_modules"));
  for (const ws of ["apps", "packages"]) {
    if (!existsSync(join(root, ws))) continue;
    for (const d of readdirSync(join(root, ws))) walk(join(root, ws, d, "node_modules"));
  }
  return [...out].sort();
}

/** Per file, the lines a patch adds and removes (a line on both sides is neither). */
export function hunks(patch: string): { file: string; added: string[]; removed: string[] }[] {
  return patch.replace(/\r\n/g, "\n").split(/^diff --git /m).slice(1).map((chunk) => {
    const file = /^a\/(\S+) b\//.exec(chunk)![1]!;
    const body = chunk.split("\n").filter((l) => !/^(---|\+\+\+) /.test(l));
    const added = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1).trimEnd()).filter((l) => l.trim());
    const removed = body.filter((l) => l.startsWith("-")).map((l) => l.slice(1).trimEnd()).filter((l) => l.trim());
    return { file, added: added.filter((l) => !removed.includes(l)), removed: removed.filter((l) => !added.includes(l)) };
  });
}

/** What a copy lacks of the patch, or still holds of upstream; empty means it carries the patch. */
export function unpatchedIn(copy: string, patch: string): string[] {
  const out: string[] = [];
  for (const h of hunks(patch)) {
    const path = join(copy, h.file);
    if (!existsSync(path)) { out.push(`${h.file}: missing`); continue; }
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());
    for (const l of h.added) if (!text.includes(l)) out.push(`${h.file}: lacks ${JSON.stringify(l.trim())}`);
    for (const l of h.removed) if (text.includes(l)) out.push(`${h.file}: still has ${JSON.stringify(l.trim())}`);
  }
  return out;
}
