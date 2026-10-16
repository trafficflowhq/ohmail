import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  cargoChecksums,
  checkSources,
  missingSources,
  npmIntegrities,
  render,
  MANIFEST,
} from "../scripts/flathub-manifest.mjs";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE FLATPAK BUILD'S IDENTITY, PERMISSIONS AND SHIPPED LAYOUT.
 *
 * Three things about this manifest are not free to drift. The app id must equal the Tauri
 * identifier the Flatpak compiles with, or single-instance cannot own its D-Bus name and a
 * `mailto:` activation starts a second copy that fights the first for the engine's lock. The
 * permission set must stay the measured one — a grant added to get past something is a hole
 * shipped to everyone. And the installed paths must be the ones `engine.rs` composes from
 * `resource_dir()`, because every mistake there produces an app that installs cleanly and cannot
 * start its engine.
 *
 * The manifest is read as text rather than parsed: there is no YAML parser in this workspace, and
 * the assertions below are about exact lines anyway.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const MANIFEST_PATH = "apps/desktop/flatpak/app.ohmail.Desktop.yml";
const manifest = read(MANIFEST_PATH);

/** The `- ` items of a top-level block, e.g. `finish-args:`. Stops at the next unindented key. */
function items(source: string, key: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) throw new Error(`the manifest has no top-level \`${key}:\``);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = /^ {2}- (.+)$/.exec(line);
    if (item) out.push(item[1]);
  }
  return out;
}

/** The app module's `build-commands:` list, joined. Comments elsewhere in the manifest are not
 *  commands, and an assertion that reads the whole file passes or fails on prose. */
function buildCommands(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^ {4}build-commands:$/.test(line));
  if (start < 0) throw new Error("the manifest has no `build-commands:`");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !/^ {6}/.test(line)) break;
    if (!/^ *#/.test(line)) out.push(line);
  }
  return out.join("\n");
}

describe("the Flatpak app id is the identifier the build compiles with", () => {
  const flatpakConf = JSON.parse(read("apps/desktop/src-tauri/tauri.flatpak.conf.json"));
  const baseConf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));

  it("the manifest's id and the Flatpak Tauri config agree", () => {
    expect(flatpakConf.identifier).toBe("app.ohmail.Desktop");
    expect(manifest).toMatch(/^id: app\.ohmail\.Desktop$/m);
  });

  it("every exported file is named after that id", () => {
    for (const name of [
      "/app/share/applications/app.ohmail.Desktop.desktop",
      "/app/share/metainfo/app.ohmail.Desktop.metainfo.xml",
      "/app/share/icons/hicolor/512x512/apps/app.ohmail.Desktop.png",
    ]) {
      expect(manifest).toContain(name);
    }
  });

  it("the AppImage, .deb and .rpm keep the identifier they shipped with", () => {
    // Their data directories are not migrated by this release. A Flatpak has its own regardless,
    // so the two identities can differ without anybody losing a local mirror — but moving the
    // OTHER one would move those installs' data out from under them.
    expect(baseConf.identifier).toBe("io.ohmail.desktop");
    expect(flatpakConf.identifier).not.toBe(baseConf.identifier);
  });

  it("the Flatpak config is not a file the CLI merges into every Linux build", () => {
    // `tauri.linux.conf.json` is looked up and merged by platform, which would move the .deb and
    // the AppImage too. This one is passed by name, and only by the Flatpak manifest.
    expect(read(MANIFEST_PATH)).toContain("--config src-tauri/tauri.flatpak.conf.json");
  });
});

describe("the runtime is one that carries the webview", () => {
  it("is the GNOME platform, and its SDK, at one version", () => {
    // Only the GNOME runtime carries WebKitGTK 4.1, which is the whole Tauri v2 stack on Linux;
    // org.freedesktop.Platform has libsoup-3 and no webview. Re-measure with
    // `flatpak run --command=sh org.gnome.Sdk//<v> -c 'pkg-config --modversion webkit2gtk-4.1'`
    // before moving this number — the choice is only as good as the day it was measured.
    const runtime = /^runtime: (.+)$/m.exec(manifest)?.[1];
    const sdk = /^sdk: (.+)$/m.exec(manifest)?.[1];
    const version = /^runtime-version: '(\d+)'$/m.exec(manifest)?.[1];
    expect(runtime).toBe("org.gnome.Platform");
    expect(sdk).toBe("org.gnome.Sdk");
    expect(version).toBeDefined();
  });

  it("takes exactly the two SDK extensions the build commands use", () => {
    expect(items(manifest, "sdk-extensions")).toEqual([
      "org.freedesktop.Sdk.Extension.rust-stable",
      "org.freedesktop.Sdk.Extension.node22",
    ]);
    // Both are on the PATH of the build, and nothing else is.
    expect(manifest).toContain("append-path: /usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node22/bin");
  });
});

describe("the app id is one Flathub accepts", () => {
  // flatpak-builder-lint refuses an id whose last component is lowercase `desktop`
  // (checks/appid.py: `if split[-1] == "desktop"`), and refuses fewer than three
  // components. This is that rule, read offline.
  const id = /^id: (.+)$/m.exec(manifest)?.[1] ?? "";

  it("has three to five components, none of them lowercase `desktop`", () => {
    const parts = id.split(".");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.length).toBeLessThanOrEqual(5);
    expect(parts[parts.length - 1]).not.toBe("desktop");
  });

  it("every component is a name the rule admits", () => {
    for (const part of id.split(".")) expect(part).toMatch(/^[A-Za-z_][\w-]*$/);
  });
});

describe("the permission set is the measured one and no more", () => {
  const finishArgs = items(manifest, "finish-args");

  it("is exactly these eight", () => {
    expect([...finishArgs].sort()).toEqual([
      "--device=dri",
      "--share=ipc",
      "--share=network",
      "--socket=fallback-x11",
      "--socket=wayland",
      "--talk-name=org.freedesktop.Notifications",
      "--talk-name=org.kde.StatusNotifierWatcher",
      "--talk-name=org.freedesktop.secrets",
    ].sort());
  });

  it("grants the tray's bus name for as long as a tray is built, and no longer", () => {
    // The grant and the feature are one fact. A sandboxed app that builds a tray icon without
    // this name gets no icon and no error, which is the shape where host mode is serving a
    // phone and nothing on screen says so; a grant kept after the tray went is a hole.
    const host = read("apps/desktop/src-tauri/src/host.rs")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const wired = host.includes("TrayIconBuilder");
    expect(finishArgs.includes("--talk-name=org.kde.StatusNotifierWatcher")).toBe(wired);
  });

  it("grants no access to the host's files", () => {
    // The engine's database, its log and any attachment it writes live in the app's own data
    // directory; a file the person opens goes out through the portal. A `--filesystem` grant of
    // any kind means that stopped being true.
    expect(finishArgs.filter((arg) => arg.startsWith("--filesystem"))).toEqual([]);
    expect(finishArgs.filter((arg) => arg.startsWith("--persist"))).toEqual([]);
  });

  it("holds none of the three escapes a review would refuse", () => {
    for (const escape of [
      "--talk-name=org.freedesktop.Flatpak",
      "--device=all",
      "--socket=session-bus",
      "--socket=system-bus",
    ]) {
      expect(finishArgs).not.toContain(escape);
    }
  });

  it("no module asks the build for a network", () => {
    // `build-args: --share=network` is how a manifest reaches the network at build time. Flathub
    // refuses it, and so does a `--sandbox` build here; this is the same refusal read offline.
    expect(manifest).not.toMatch(/build-args:/);
  });
});

describe("the shipped layout is the one engine.rs resolves", () => {
  // Tauri's resource_dir() on Linux is <exe dir>/../lib/<product name>, so a binary at
  // /app/bin/ohmail resolves /app/lib/ohmail — and these three names are what the engine overlay
  // (tauri.engine.conf.json) calls its resources.
  it("installs the binary where the resource directory is composed from", () => {
    expect(manifest).toContain("/app/bin/ohmail");
  });

  it("carries the engine, its runtime and the served host client", () => {
    expect(manifest).toContain("/app/lib/ohmail/engine");
    expect(manifest).toContain("/app/lib/ohmail/runtime");
    expect(manifest).toContain("/app/lib/ohmail/host-client");
  });

  it("takes the runtime from the SDK extension, with its licence", () => {
    // Built from source by freedesktop-sdk rather than downloaded: a Flathub build resolves only
    // declared sources, and `stage-desktop-resources.mjs` refuses to stage a runtime with no
    // licence beside it.
    const commands = buildCommands(manifest);
    expect(commands).toContain("/usr/lib/sdk/node22/bin/node");
    expect(commands).toContain("build/vendor/node.LICENSE");
  });

  it("does not call the script that downloads a runtime", () => {
    // Over the COMMANDS, not the file: the manifest's own header says vendor-node.mjs is not
    // called here, and an assertion that reads the whole file would be answered by that sentence.
    const commands = buildCommands(manifest);
    expect(commands).not.toContain("vendor-node.mjs");
    expect(commands).not.toContain("nodejs.org");
    expect(commands).toContain("/usr/lib/sdk/node22/bin/node");
  });
});

describe("the offline sources are declared and current", () => {
  it("both generated files are sources of the app module", () => {
    expect(manifest).toContain("- cargo-sources.json");
    expect(manifest).toContain("- node-sources.json");
  });

  it("the cargo sources cover the lockfile's crates", () => {
    const lock = read("apps/desktop/src-tauri/Cargo.lock");
    const crates = new Set(
      [...lock.matchAll(/^name = "(.+)"$/gm)].map((found) => found[1]),
    );
    const sources = JSON.parse(read("apps/desktop/flatpak/cargo-sources.json"));
    const named = JSON.stringify(sources);
    // A spot check with a real cost: these four are load-bearing for the window and the keystore,
    // and a regenerate that silently produced an empty set would still pass a length assertion.
    for (const crate of ["tauri", "keyring", "tauri-plugin-single-instance", "serde"]) {
      expect(crates.has(crate)).toBe(true);
      expect(named).toContain(crate);
    }
    expect(sources.length).toBeGreaterThan(crates.size);
  });
});

describe("the Flathub submission manifest is derived, never kept by hand", () => {
  const TAG = "v0.19.0";
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const pinned = render(manifest, TAG, COMMIT);

  it("pins the tag and the commit Flathub builds", () => {
    expect(pinned).toContain(`tag: ${TAG}`);
    expect(pinned).toContain(`commit: ${COMMIT}`);
    expect(pinned).toContain("url: https://github.com/trafficflowhq/ohmail.git");
  });

  it("differs from the committed manifest in the source block and nowhere else", () => {
    // This is what makes one manifest the truth: a permission, a runtime version or an install
    // path added here reaches the file people actually install, because that file is rendered
    // from this one rather than edited beside it.
    const strip = (text: string) =>
      text.split("\n").filter((line) => !/^ *(- type: (dir|git)|path:|url:|tag:|commit:|skip:|- \.git|- node_modules|- apps\/desktop\/(node_modules|dist|dist-host|src-tauri\/target)|- build)/.test(line.trim() ? line : "x"));
    expect(strip(pinned)).toEqual(strip(manifest));
  });

  it("the pinned manifest keeps the same permissions", () => {
    expect(items(pinned, "finish-args")).toEqual(items(manifest, "finish-args"));
  });
});

describe("the tool the submission is rendered with reads the manifest that is here", () => {
  // The constant is the whole CLI: `node scripts/flathub-manifest.mjs --tag … --commit …` is the
  // one command in the submission steps, and a path literal left behind by a rename dies ENOENT
  // at the moment somebody is opening a pull request. Nothing else in this file reads it, which
  // is exactly why it went unmeasured.
  it("names a file that exists, and it is this one", () => {
    expect(existsSync(MANIFEST)).toBe(true);
    expect(MANIFEST).toBe(join(HERE, "..", MANIFEST_PATH));
    expect(readFileSync(MANIFEST, "utf8")).toBe(manifest);
  });
});

describe("the offline sources are the lockfiles', not a copy that was once true", () => {
  // `npm ci --offline` and cargo's vendor directory resolve ONLY what these two files declare.
  // A dependency bump that does not regenerate them builds here and fails inside the Flathub
  // builder, where the first person to see it is a reviewer.
  const rows = checkSources();

  it("checks the crates and the desktop npm tree, and says the published lock is not checked", () => {
    expect(rows.map((row) => row.file)).toEqual(["cargo-sources.json", "node-sources.json"]);
    expect(rows.map((row) => row.lock)).toEqual([
      "apps/desktop/src-tauri/Cargo.lock",
      "apps/desktop/package-lock.json",
    ]);
  });

  it("every checksum both lockfiles name is declared", () => {
    for (const row of rows) expect({ [row.lock]: row.missing }).toEqual({ [row.lock]: [] });
  });

  it("the lockfile readers find the crates and the packages, not zero of them", () => {
    // A reader whose regex stopped matching would report every file current. Both counts are
    // floors read from the real files, so an empty read is red rather than green.
    expect(cargoChecksums(read("apps/desktop/src-tauri/Cargo.lock")).length).toBeGreaterThan(400);
    expect(npmIntegrities(read("apps/desktop/package-lock.json")).length).toBeGreaterThan(300);
  });

  it("one source whose hash moved is named, and the rest are not", () => {
    // The control: take the real cargo sources, change one declared hash, and the crate the
    // lockfile names comes back as missing. This is the drift the check exists to refuse.
    const sources = JSON.parse(read("apps/desktop/flatpak/cargo-sources.json"));
    const checksums = cargoChecksums(read("apps/desktop/src-tauri/Cargo.lock"));
    const target = checksums[0];
    const moved = sources.map((source: { sha256?: string }) =>
      source.sha256 === target ? { ...source, sha256: `${target.slice(0, 63)}0` } : source,
    );
    expect(missingSources(checksums, moved, "sha256")).toEqual([target]);
    expect(missingSources(checksums, sources, "sha256")).toEqual([]);
  });
});

/**
 * AND THE JOB THAT BUILDS IT, WHICH HAS NEVER ONCE CONCLUDED SUCCESS.
 *
 * Every run died `Failed to init: Unable to find sdk` while the install step reported success.
 * Neither the installation nor the runner's flatpak version is the variable: the builder ran
 * inside the org.flatpak.Builder sandbox and asks the HOST's flatpak over a portal no CI step has
 * a session bus to reach. Under `dbus-run-session` it gets past that and then refuses its own
 * finished tree, `Command 'ohmail' not found` with the binary in files/bin; the HOST builder built
 * the same manifest from the same tree to a repository. One container, the runner's flatpak, both
 * arms — so the build runs the host binary and the sandbox keeps the Flathub review tools.
 */
describe("the job that builds the Flatpak gives the builder a session bus", () => {
  const wf = read(publicRel("github/workflows/build.yml"));
  const job = wf.slice(wf.indexOf("  linux-flatpak:"));
  const lines = job.split("\n");

  it("puts the runtime, the sdk and the extensions in the system installation", () => {
    const install = lines.find((l) => l.includes("flatpak install") && l.includes("--system"));
    expect(install, "nothing is installed system-wide, so the builder sees no runtime").toBeDefined();
    const at = lines.indexOf(install as string);
    const refs = lines.slice(at, at + 5).join("\n");
    expect(refs).toContain("org.gnome.Platform//$RUNTIME_VERSION");
    expect(refs).toContain("org.gnome.Sdk//$RUNTIME_VERSION");
    expect(refs).toContain("org.freedesktop.Sdk.Extension.rust-stable");
    expect(refs).toContain("org.freedesktop.Sdk.Extension.node22");
    // The version is read out of the manifest and never written down here.
    expect(job).not.toMatch(/org\.gnome\.Sdk\/\/[0-9]/);
  });

  it("does not bring back the variable that did not work, and says why it is gone", () => {
    /* FLATPAK_USER_DIR is the fix this job carried while it was failing: it reads like a fix, the
     * step that sets it goes green, and the build dies anyway. The USE of it is refused; the
     * MENTION is required, because a removal with no reason beside it is an oversight somebody
     * helpfully undoes. */
    const set = lines.filter((l) => l.includes("FLATPAK_USER_DIR=") && !l.trim().startsWith("#"));
    expect(set, "the job sets FLATPAK_USER_DIR again").toHaveLength(0);
    expect(job, "nothing records that the variable did not work").toContain("FLATPAK_USER_DIR");
  });

  it("asks whether the builder can see them, before the build depends on it", () => {
    const assertAt = lines.findIndex((l) => l.includes("--stop-at="));
    expect(assertAt, "nothing asks about the runtime before the build").toBeGreaterThan(-1);
    const buildAt = lines.findIndex((l) => l.includes("--repo=flatpak-repo"));
    expect(buildAt, "the build step is gone").toBeGreaterThan(-1);
    expect(assertAt, "the question is asked after the build already answered it")
      .toBeLessThan(buildAt);
    const step = lines.slice(assertAt - 6, assertAt + 6).join("\n");
    expect(step, "the refusal does not say what was not found, or where")
      .toMatch(/is not installed where flatpak-builder looks/);
  });

  it("runs every command in the builder sandbox under a session bus of its own", () => {
    /* Anything in that sandbox reaches the host's flatpak over the org.freedesktop.Flatpak portal,
     * and with no session bus the question cannot be asked: the builder answered `Unable to find
     * sdk` about a runtime that was installed, which is how two repairs went to the installation.
     * The review tools run in the same sandbox and carry the same wrapper. */
    const runs = lines.filter((l) => l.includes("flatpak run") && l.includes("org.flatpak.Builder"));
    expect(runs.length, "the job no longer runs anything in org.flatpak.Builder").toBeGreaterThan(4);
    const bare = runs.filter((l) => !l.includes("dbus-run-session -- flatpak run"));
    expect(bare, `these builder runs have no session bus: ${bare.join(" | ")}`).toHaveLength(0);
  });

  it("gives flatpak a runtime directory when the runner has none", () => {
    /* flatpak allocates an instance directory under XDG_RUNTIME_DIR for every sandbox it starts,
     * and the nested `flatpak build` a module build spawns dies `Unable to allocate instance id`
     * without one — ten minutes in, with the app's own build as the apparent subject. */
    const handed = lines.findIndex(
      (l) => l.includes("XDG_RUNTIME_DIR=") && l.includes("GITHUB_ENV"),
    );
    expect(handed, "nothing hands the steps below a runtime directory").toBeGreaterThan(-1);
    const step = lines.slice(handed - 4, handed + 1).join("\n");
    expect(step, "the directory is made unconditionally, over a runner that already has one")
      .toContain('if [ -z "${XDG_RUNTIME_DIR:-}" ]');
  });

  it("builds with the host flatpak-builder, not the one in the sandbox", () => {
    /* Under a session bus the sandboxed builder gets past the runtime check and then refuses its
     * own finished tree — `Command 'ohmail' not found`, with the binary in files/bin — while the
     * host builder builds the same manifest from the same tree to a repository. Measured both ways
     * in one container on the runner's own flatpak. */
    const steps = lines.filter((l) => l.trim().startsWith("flatpak-builder --force-clean"));
    expect(steps, "the build steps do not run the host flatpak-builder").toHaveLength(3);
    const sandboxed = lines.filter((l) =>
      l.includes("--command=flatpak-builder org.flatpak.Builder"),
    );
    expect(sandboxed, "a build step runs the builder inside the sandbox again").toHaveLength(0);
    const apt = lines.find((l) => l.includes("apt-get install") && l.includes("flatpak"));
    expect(apt, "the host flatpak-builder is never installed").toContain("flatpak-builder");
  });

  it("asks the generated sources about the published lockfile before it downloads", () => {
    /* `node-sources.json` is derived from the ROOT lockfile, which only a published checkout
     * carries — the job runs in one. Asked there, a file left behind refuses in a second; unasked,
     * it arrives as an ENOTCACHED inside npm ten minutes in, reading like the app's own failure. */
    const checkAt = lines.findIndex((l) => l.includes("flathub-manifest.mjs --check"));
    expect(checkAt, "nothing asks whether the generated sources still cover the lockfiles")
      .toBeGreaterThan(-1);
    expect(lines[checkAt], "the check cannot see the root lockfile without the published tree")
      .toContain("--mirror");
    const downloadAt = lines.findIndex((l) => l.includes("--download-only"));
    expect(checkAt, "the question is asked after the download it exists to save")
      .toBeLessThan(downloadAt);
  });

  it("refuses the repo-local --check instead of greening over the lockfile it cannot see", () => {
    /* FLATHUB-NODE-SOURCES-DERIVE-AT-CEREMONY. Run without a mirror, `--check` read the two
     * repo-local lockfiles, found nothing wrong with either, and printed a green — while the
     * PUBLISHED root lockfile, the one a Flathub build installs first and the one the publisher
     * rewrites at every ceremony, was never opened. The file sat sixteen packages behind under
     * that green. A derived file's check names the tree it derives from, or refuses. */
    const root = resolve(HERE, "..");
    const run = (args: string[]) =>
      spawnSync("node", [resolve(root, "scripts/flathub-manifest.mjs"), "--check", ...args],
        { cwd: root, encoding: "utf8" });
    const bare = run([]);
    expect(bare.status, "the repo-local check still passes for a file it cannot derive").toBe(3);
    expect(`${bare.stderr}`).toContain("NOT DERIVABLE HERE");
    expect(`${bare.stderr}`).toContain("--mirror");

    /* And the admitting arm, so the refusal is a refusal of something: asked for the two local
     * lockfiles ON PURPOSE it passes, and the verdict NAMES what it did not cover. */
    const local = run(["--local-only"]);
    expect(local.status, `--local-only: ${local.stderr}`).toBe(0);
    expect(`${local.stdout}`).toContain("was NOT covered");
    expect(`${local.stdout}`).toContain("2 lockfile(s)");
  });

  it("asserts the wrapper as a tool it spawns, before the subject starts", () => {
    // A missing dbus-run-session would read as the app failing rather than as the runner.
    const spawn = lines.find((l) => l.includes("for t in flatpak"));
    expect(spawn, "the host-tool assertion is gone").toBeDefined();
    expect(spawn).toContain("dbus-run-session");
  });

  it("lets the summary say that the manifest was not built", () => {
    /* The summary step runs on a failed job too and claimed a build on every one of them. A
     * summary that cannot state the failure is a claim, not a reading. */
    const at = lines.findIndex((l) => l.includes("- name: Run summary"));
    expect(at, "the flatpak job has no run summary").toBeGreaterThan(-1);
    const step = lines.slice(at, at + 20).join("\n");
    expect(step, "the summary does not read the job's status").toContain("job.status");
    expect(step, "the summary has no sentence for a job that did not build")
      .toMatch(/FLATPAK: FAILED/);
  });

  it("installs the same way the README tells a reader to", () => {
    /* The README publishes this build to anyone with the repository, and its install has no
     * `--user` — the system installation, which is flatpak's default and the one that works. A
     * job and a README that install into different places cannot both be describing what builds. */
    const readme = read(publicRel("README.md"));
    const recipe = readme.slice(readme.indexOf("#### Flatpak"));
    const install = recipe.split("\n").find((l) => l.includes("flatpak install"));
    expect(install, "the README no longer shows how to install the runtimes").toBeDefined();
    expect(install, "the README installs per-user while the job installs system-wide")
      .not.toContain("--user");
  });
});
