import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every dependency the shell's manifest names must appear in Cargo.lock's own
 * package block. When one is missing, any cargo invocation rewrites the lock
 * as a side effect, and a packager's `cargo build --locked` refuses outright —
 * `gtk` sat in Cargo.toml without a lock entry and did exactly that. Cargo
 * only ever records the resolved graph, so the fix is regenerating the lock,
 * never hand-editing versions; this test refuses the drift at the manifest.
 */

const TAURI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");

/** Dependency names from every `[dependencies]`-family table, `package =` renames honoured. */
function manifestDepNames(toml: string): string[] {
  const names: string[] = [];
  let inDeps = false;
  for (const line of toml.split("\n")) {
    const header = /^\[+([^\]]+)\]+\s*$/.exec(line.trim());
    if (header) {
      const h = header[1];
      inDeps =
        h === "dependencies" ||
        h === "dev-dependencies" ||
        h === "build-dependencies" ||
        (h.startsWith("target.") && /\.(dev-|build-)?dependencies$/.test(h));
      continue;
    }
    if (!inDeps || line.trimStart().startsWith("#")) continue;
    const dep = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*=/.exec(line);
    if (!dep) continue;
    const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(line);
    names.push(renamed ? renamed[1] : dep[1]);
  }
  return names;
}

/** The dependency list of one named package block in a Cargo.lock, version suffixes dropped. */
function lockDepsOf(lock: string, pkg: string): string[] | undefined {
  for (const block of lock.split("[[package]]")) {
    if (!new RegExp(`^name = "${pkg}"$`, "m").test(block)) continue;
    const list = /dependencies = \[([\s\S]*?)\]/.exec(block);
    if (!list) return [];
    return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].split(" ")[0]);
  }
  return undefined;
}

function missingFromLock(toml: string, lock: string, pkg: string): string[] {
  const have = new Set(lockDepsOf(lock, pkg) ?? []);
  return [...new Set(manifestDepNames(toml))].filter((name) => !have.has(name)).sort();
}

describe("Cargo.lock carries every dependency the manifest names", () => {
  const toml = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
  const lock = fs.readFileSync(path.join(TAURI, "Cargo.lock"), "utf8");

  it("reads a real manifest and a real lock block, not two empty sets", () => {
    const names = manifestDepNames(toml);
    expect(names).toContain("tauri");
    expect(names).toContain("gtk");
    expect(lockDepsOf(lock, "ohmail")).toBeDefined();
  });

  it("finds no manifest dependency absent from the lock's ohmail block", () => {
    expect(missingFromLock(toml, lock, "ohmail")).toEqual([]);
  });

  it("refuses a manifest dependency the lock does not carry (positive control)", () => {
    const manifest = '[dependencies]\nserde = "1"\n\n[target.\'cfg(unix)\'.dependencies]\ngtk = "0.18"\n';
    const carried = '[[package]]\nname = "demo"\nversion = "0.1.0"\ndependencies = [\n "gtk",\n "serde",\n]\n';
    const drifted = '[[package]]\nname = "demo"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n';
    expect(missingFromLock(manifest, carried, "demo")).toEqual([]);
    expect(missingFromLock(manifest, drifted, "demo")).toEqual(["gtk"]);
    expect(missingFromLock(manifest, "", "demo")).toEqual(["gtk", "serde"]);
  });
});
