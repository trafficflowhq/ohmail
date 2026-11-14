import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildVariant, DISTRIBUTIONS } from "../scripts/build-variant.mjs";

/**
 * A PREVIEW BUILD CAN NEVER OPEN A RELEASED INSTALL'S FOLDER.
 *
 * A preview is a nightly build of the next major version, and it runs on computers that also hold a
 * released ohmail. Every folder the app keeps is named by its identifier, and a newer build that
 * opened the released store would migrate it, which cannot be taken back. So the preview's bundler
 * configuration is merged here the way the bundler merges it, for each of the three desktop
 * systems, and the folders that result are compared with those of every identifier a release
 * carries: the download's, the Mac App Store's and the Flatpak's.
 */

const TAURI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri");
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const conf = (name: string): Json => JSON.parse(fs.readFileSync(path.join(TAURI, name), "utf8")) as Json;
const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON Merge Patch (RFC 7396), which is how the bundler lays one config over another: an object
 *  merges key by key, and anything else, a list included, replaces what was there. */
function merge(base: Json, patch: Json): Json {
  if (!isObject(patch)) return patch;
  const out: { [key: string]: Json } = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key] ?? null, value);
  }
  return out;
}

const SYSTEMS = { linux: "tauri.linux.conf.json", darwin: "tauri.macos.conf.json", win32: "tauri.windows.conf.json" } as const;
type System = keyof typeof SYSTEMS;

/** The config a build ends up with: the base, the system's own file, then each overlay in order. */
function merged(system: System, overlays: readonly string[]): { [key: string]: Json } {
  const out = [SYSTEMS[system], ...overlays].reduce<Json>((acc, name) => merge(acc, conf(name)), conf("tauri.conf.json"));
  if (!isObject(out)) throw new Error("the merged configuration is not an object");
  return out;
}

/** Every folder the app keeps on one system, by the framework's own rule: the system's base
 *  directory, then the identifier. Written with `/` on all three; only equality and prefixes matter. */
function folders(system: System, identifier: string): string[] {
  if (system === "linux") {
    return [`~/.local/share/${identifier}`, `~/.local/share/${identifier}/logs`, `~/.config/${identifier}`, `~/.cache/${identifier}`];
  }
  if (system === "darwin") {
    return [
      `~/Library/Application Support/${identifier}`, `~/Library/Logs/${identifier}`, `~/Library/Caches/${identifier}`,
      `~/Library/WebKit/${identifier}`,
    ];
  }
  return [`%APPDATA%/${identifier}`, `%LOCALAPPDATA%/${identifier}`, `%LOCALAPPDATA%/${identifier}/logs`];
}

/** The identifiers a released ohmail carries, each read from the configuration that ships it. */
const RELEASED: Array<[string, System, readonly string[]]> = [
  ["the download on Linux", "linux", buildVariant({ distribution: "direct", platform: "linux" }).configs],
  ["the download on macOS", "darwin", buildVariant({ distribution: "direct", platform: "darwin" }).configs],
  ["the download on Windows", "win32", buildVariant({ distribution: "direct", platform: "win32" }).configs],
  ["the Mac App Store's", "darwin", ["tauri.engine.conf.json", "tauri.mas.conf.json"]],
  ["the Flatpak", "linux", ["tauri.engine.conf.json", "tauri.flatpak.conf.json"]],
];

/** The overlays a preview build passes. Asked of Linux, the one system it is built on, and laid
 *  over each system's files below: the folders must be apart wherever it is ever built. */
const PREVIEW = buildVariant({ distribution: "preview", platform: "linux" }).configs;

describe("a preview build is a different app to the system", () => {
  it("resolves no folder of a released install on Linux, macOS or Windows", () => {
    const released = new Set(RELEASED.map(([, system, overlays]) => String(merged(system, overlays).identifier)));
    expect([...released].sort()).toEqual(["app.ohmail", "app.ohmail.Desktop", "io.ohmail.desktop"]);
    for (const system of Object.keys(SYSTEMS) as System[]) {
      const preview = String(merged(system, PREVIEW).identifier);
      expect(preview, system).toBe("io.ohmail.preview");
      for (const other of released) {
        expect(preview, `${system}: the preview carries a released identifier`).not.toBe(other);
        /* Neither name begins with the other, so no prefix match or glob over one reaches the other. */
        expect(preview.startsWith(other) || other.startsWith(preview), `${system}: ${preview} and ${other} share a prefix`).toBe(false);
        for (const mine of folders(system, preview)) {
          for (const theirs of folders(system, other)) {
            expect(mine, `${system}: a preview folder is a released one`).not.toBe(theirs);
            expect(mine.startsWith(`${theirs}/`) || theirs.startsWith(`${mine}/`), `${system}: ${mine} and ${theirs} nest`).toBe(false);
          }
        }
      }
    }
  });

  it("says it is a preview, takes no mail link and builds the one package that installs nothing", () => {
    const preview = merged("linux", PREVIEW);
    const released = merged("linux", buildVariant({ distribution: "direct", platform: "linux" }).configs);
    expect(preview.productName).toBe("ohmail preview");
    expect(released.productName).toBe("ohmail");
    /* The released build registers the mail-link schemes; a preview that did would take them from it. */
    const schemes = (c: { [key: string]: Json }) => (((c.plugins as { [k: string]: Json })["deep-link"] as { [k: string]: Json }).desktop as { [k: string]: Json }).schemes;
    expect(schemes(released)).toEqual(["ohmail", "mailto"]);
    expect(schemes(preview)).toEqual([]);
    /* An AppImage is one file a person runs. A .deb or an .rpm would install over the released app's own files. */
    expect((preview.bundle as { [k: string]: Json }).targets).toEqual(["appimage"]);
  });

  it("changes the window's title and nothing else about the window", () => {
    const windowOf = (c: { [key: string]: Json }) => ((c.app as { [k: string]: Json }).windows as Json[])[0] as { [k: string]: Json };
    const preview = windowOf(merged("linux", PREVIEW));
    const released = windowOf(merged("linux", ["tauri.engine.conf.json"]));
    expect(preview.title).toBe("ohmail preview");
    /* A list replaces a list in the merge, so the overlay restates the window; it may not drift from it. */
    expect({ ...preview, title: released.title }).toEqual(released);
  });

  it("overlays exactly the keys that make it a preview, so it is no fork of the configuration", () => {
    const leaves = (v: Json, at: string): string[] =>
      isObject(v) ? Object.entries(v).flatMap(([k, inner]) => leaves(inner, at ? `${at}.${k}` : k)) : [at];
    expect(leaves(conf("tauri.preview.conf.json"), "").sort()).toEqual([
      "$schema", "app.windows", "bundle.targets", "identifier", "plugins.deep-link.desktop.schemes", "productName",
    ]);
  });
});

describe("one word selects every half of a build", () => {
  it("gives each distribution its literal, its features in one value and its overlays", () => {
    expect([...DISTRIBUTIONS]).toEqual(["direct", "mas", "preview"]);
    expect(buildVariant({ distribution: "direct", platform: "linux" })).toEqual({
      literal: "direct", features: "local-engine", configs: ["tauri.engine.conf.json"],
    });
    expect(buildVariant({ distribution: "mas", platform: "darwin" })).toEqual({
      literal: "mas", features: "local-engine,mas", configs: ["tauri.engine.conf.json"],
    });
    expect(buildVariant({ distribution: "preview", platform: "linux" })).toEqual({
      literal: "preview", features: "local-engine,preview", configs: ["tauri.engine.conf.json", "tauri.preview.conf.json"],
    });
  });

  it("refuses a preview where it would not be apart from an installed ohmail, and a word it does not know", () => {
    for (const platform of ["darwin", "win32"]) {
      expect(() => buildVariant({ distribution: "preview", platform })).toThrow(/built on linux only/);
    }
    expect(() => buildVariant({ distribution: "nightly", platform: "linux" })).toThrow(/unknown --distribution nightly \(direct \| mas \| preview\)/);
  });
});
