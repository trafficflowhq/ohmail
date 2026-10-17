import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * THE APPLIER PUTS OUR PATCHES INTO AN npm TREE, OR REFUSES BY NAME.
 *
 * No release build from the published tree carried `patches/` (measured on every Android release
 * APK from 0.17.0 to 0.25.3: the transport patch's literals absent from the dex, and a phone's 587
 * send refused). Each fixture here is upstream's own code, recovered by applying the real patch in
 * reverse to the copy this checkout installed and patched, so every arm runs the patches that ship.
 */
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "apply-patches.mjs");
const SCRATCH = mkdtempSync(join(tmpdir(), "ohmail-apply-patches-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

type Ran = { code: number; out: string; err: string };
function run(args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** The copy carrying the CURRENT patch: this checkout's own npm tree, which `node scripts/apply-patches.mjs
 *  apply` patched in place after `npm ci` (the suite applies before it runs). A copy that is not patched
 *  fails the fixture's reverse apply below, by name. */
function installedPatched(name: string): string {
  const copy = join(ROOT, "node_modules", name);
  expect(existsSync(join(copy, "package.json")), `this checkout has no installed copy of ${name}: run npm ci, then apply-patches apply`).toBe(true);
  return copy;
}

function patchPaths(file: string): string[] {
  return [...readFileSync(join(ROOT, "patches", file), "utf8").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
}

function git(args: string[], cwd: string, input: string): Ran {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) } });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let seq = 0;
/** An npm-shaped tree: `patches/` holding the named files, and each package as upstream ships it. */
function tree(patchFiles: string[], opts: { version?: string; nestAt?: string } = {}): string {
  const root = join(SCRATCH, `t${++seq}`);
  mkdirSync(join(root, "patches"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["apps/mobile"] }));
  for (const file of patchFiles) {
    cpSync(join(ROOT, "patches", file), join(root, "patches", file));
    const name = file.replace(/\.patch$/, "").replace(/@\d.*$/, "");
    const from = installedPatched(name);
    const version = opts.version ?? JSON.parse(readFileSync(join(from, "package.json"), "utf8")).version;
    for (const base of [join(root, "node_modules", name), ...(opts.nestAt ? [join(root, opts.nestAt, "node_modules", name)] : [])]) {
      for (const p of patchPaths(file)) cpSync(join(from, p), join(base, p));
      writeFileSync(join(base, "package.json"), JSON.stringify({ name, version }));
      const back = git(["apply", "--reverse", "-"], base, readFileSync(join(root, "patches", file), "utf8"));
      expect(back.code, `reverse-applying ${file} to recover upstream: ${back.err}`).toBe(0);
    }
  }
  relock(root);
  return root;
}

/** The lockfile of what a fixture tree holds, as `npm ci` would have left it: one entry per package directory. */
function relock(root: string, extra: Record<string, Record<string, unknown>> = {}): void {
  const packages: Record<string, Record<string, unknown>> = { "": { name: "fixture", workspaces: ["apps/mobile"] } };
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      for (const name of e.startsWith("@") ? readdirSync(join(dir, e)).map((n) => `${e}/${n}`) : [e]) {
        const pj = join(dir, name, "package.json");
        if (!existsSync(pj)) continue;
        packages[`${rel}/${name}`] = { version: JSON.parse(readFileSync(pj, "utf8")).version };
        walk(join(dir, name, "node_modules"), `${rel}/${name}/node_modules`);
      }
    }
  };
  walk(join(root, "node_modules"), "node_modules");
  walk(join(root, "apps", "mobile", "node_modules"), "apps/mobile/node_modules");
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { ...packages, ...extra } }));
}

const NODEMAILER = "nodemailer@8.0.11.patch";
const TCP = "react-native-tcp-socket@6.4.2.patch";
const WEBVIEW = "react-native-webview@13.16.1.patch";
const POSTGRES = "postgres@3.4.9.patch";
const SMTP = "node_modules/nodemailer/lib/smtp-connection/index.js";
const REFUSAL = "the server sent more data after its STARTTLS response";

describe("apply", () => {
  it("applies each patch to the installed copy and says so", () => {
    const root = tree([NODEMAILER, TCP]);
    expect(readFileSync(join(root, SMTP), "utf8")).not.toContain(REFUSAL);
    const r = run(["apply", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("PATCHES_APPLIED 2/2");
    expect(readFileSync(join(root, SMTP), "utf8")).toContain(REFUSAL);
  });

  it("patches every copy of the patch's version, and leaves another version alone", () => {
    const root = tree([NODEMAILER], { nestAt: "apps/mobile" });
    const other = join(root, "node_modules", "imapflow", "node_modules", "nodemailer");
    mkdirSync(join(other, "lib", "smtp-connection"), { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "nodemailer", version: "9.0.3" }));
    writeFileSync(join(other, "lib", "smtp-connection", "index.js"), "// another release\n");
    const r = run(["apply", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/copies=2 \(node_modules\/nodemailer, apps\/mobile\/node_modules\/nodemailer\)/);
    expect(r.out).toContain("other versions, not this patch's: node_modules/imapflow/node_modules/nodemailer is 9.0.3");
    expect(readFileSync(join(root, "apps/mobile", SMTP), "utf8")).toContain(REFUSAL);
    expect(readFileSync(join(other, "lib", "smtp-connection", "index.js"), "utf8")).toBe("// another release\n");
  });

  it("refuses a patch that no longer applies, quoting git, and changes nothing", () => {
    const root = tree([NODEMAILER]);
    const upstream = readFileSync(join(root, SMTP), "utf8");
    const moved = upstream.replace("    _upgradeConnection(callback) {", "    _upgradeConnection(done) {");
    expect(moved).not.toBe(upstream);
    writeFileSync(join(root, SMTP), moved);
    const r = run(["apply", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`patch ${NODEMAILER} does not apply to node_modules/nodemailer (8.0.11)`);
    expect(r.err).toContain("error: patch failed: lib/smtp-connection/index.js");
    expect(r.out).not.toContain("PATCHES_APPLIED");
    expect(readFileSync(join(root, SMTP), "utf8")).toBe(moved);
  });

  it("refuses a patch whose version the tree does not hold, naming both", () => {
    const root = tree([NODEMAILER], { version: "8.0.12" });
    const r = run(["apply", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("patch nodemailer@8.0.11 names a version the tree does not hold: node_modules/nodemailer is 8.0.12");
  });

  it("refuses when there are no patches, rather than applying none", () => {
    const root = tree([NODEMAILER]);
    rmSync(join(root, "patches", NODEMAILER));
    const empty = run(["apply", "--root", root]);
    rmSync(join(root, "patches"), { recursive: true });
    const absent = run(["apply", "--root", root]);
    for (const r of [empty, absent]) {
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("no patches to apply");
      expect(r.out).not.toContain("PATCHES_APPLIED");
    }
  });

  it("refuses without git before it reads anything", () => {
    const root = tree([NODEMAILER]);
    const bin = join(root, "bin-without-git");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const r = run(["apply", "--root", root], { PATH: bin });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("TOOL_MISSING git");
    expect(readFileSync(join(root, SMTP), "utf8")).not.toContain(REFUSAL);
  });

  it("refuses a tree with no installed copy of a patched package", () => {
    const root = tree([NODEMAILER]);
    rmSync(join(root, "node_modules", "nodemailer"), { recursive: true });
    mkdirSync(join(root, "node_modules", "filler"), { recursive: true });
    writeFileSync(join(root, "node_modules", "filler", "package.json"), JSON.stringify({ name: "filler", version: "1.0.0" }));
    relock(root);
    const r = run(["apply", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`patch ${NODEMAILER}: no copy of nodemailer is installed in this tree`);
  });

  it("refuses a pnpm tree, whose store copies other checkouts share", () => {
    const root = tree([NODEMAILER]);
    mkdirSync(join(root, "node_modules", ".pnpm"));
    const r = run(["apply", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("was installed by pnpm, which applies these patches itself");
    expect(readFileSync(join(root, SMTP), "utf8")).not.toContain(REFUSAL);
  });

  it("applies inside a git checkout, where a bare git apply skips the file and exits 0", () => {
    const root = tree([NODEMAILER]);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const copy = join(root, "node_modules", "nodemailer");
    const text = readFileSync(join(root, "patches", NODEMAILER), "utf8");
    const bare = spawnSync("git", ["apply", "--verbose", "-"], { cwd: copy, input: text, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: "" } });
    expect(bare.status, "the trap this guards: git reports success").toBe(0);
    expect(bare.stderr).toContain("Skipped patch 'lib/smtp-connection/index.js'");
    expect(readFileSync(join(root, SMTP), "utf8")).not.toContain(REFUSAL);
    const r = run(["apply", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(root, SMTP), "utf8")).toContain(REFUSAL);
  });

  it("writes the patched file's bytes as they are where git's config asks for CRLF", () => {
    // A Windows runner's global core.autocrlf=true: git apply outside a repository rewrote every line.
    const root = tree([NODEMAILER]);
    const config = join(root, "gitconfig-autocrlf");
    writeFileSync(config, "[core]\n\tautocrlf = true\n");
    const r = run(["apply", "--root", root], { GIT_CONFIG_GLOBAL: config });
    expect(r.code, r.err).toBe(0);
    const text = readFileSync(join(root, SMTP), "utf8");
    expect(text).toContain(REFUSAL);
    expect(text.includes("\r"), "the patched file gained CR bytes").toBe(false);
  });

  it("names a copy that already carries the change, and refuses one that carries neither", () => {
    const root = tree([NODEMAILER]);
    expect(run(["apply", "--root", root]).code).toBe(0);
    const again = run(["apply", "--root", root]);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("already carried by node_modules/nodemailer is 8.0.11");
    expect(again.out).toContain("PATCHES_APPLIED 1/1 (1 already carried by the installed copy)");
    const half = readFileSync(join(root, SMTP), "utf8").replace("this._remainder.length)) {", "this._remainder.length)) {\n");
    writeFileSync(join(root, SMTP), half);
    const neither = run(["apply", "--root", root]);
    expect(neither.code).not.toBe(0);
    expect(neither.err).toContain("and that copy does not already carry it");
  });
});

describe("verify-tree: the installed tree is the locked one, read off the disk", () => {
  const add = (root: string, at: string, json: Record<string, unknown>) => {
    mkdirSync(join(root, at), { recursive: true });
    writeFileSync(join(root, at, "package.json"), JSON.stringify(json));
  };
  const other = process.platform === "win32" ? "linux" : "win32";

  it("admits the tree the lock describes, and apply reads it first", () => {
    const root = tree([NODEMAILER]);
    const r = run(["verify-tree", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^TREE_AS_LOCKED locked=1 present=1 skipped-optional=0 extra=\[\] tree=\.$/m);
    const a = run(["apply", "--root", root]);
    expect(a.code, a.err).toBe(0);
    expect(a.out.indexOf("TREE_AS_LOCKED")).toBeLessThan(a.out.indexOf("PATCH "));
  });

  it("refuses a package the disk holds at another version, before any patch is applied", () => {
    const root = tree([NODEMAILER]);
    add(root, "node_modules/nodemailer", { name: "nodemailer", version: "8.0.19" });
    const r = run(["apply", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("MOVED node_modules/nodemailer: the lock says nodemailer@8.0.11, the disk holds nodemailer@8.0.19");
    expect(r.out).not.toContain("PATCHES_APPLIED");
  });

  it("refuses a required package that is gone", () => {
    const root = tree([NODEMAILER]);
    relock(root, { "node_modules/gone": { version: "1.0.0" } });
    const r = run(["verify-tree", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("MISSING node_modules/gone (gone@1.0.0)");
  });

  it("admits an absent optional whose platform excludes this host", () => {
    const root = tree([NODEMAILER]);
    relock(root, { "node_modules/native-other": { version: "1.0.0", optional: true, os: [other] } });
    const r = run(["verify-tree", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("skipped-optional=1");
  });

  it("refuses an absent optional whose platform matches this host", () => {
    const root = tree([NODEMAILER]);
    relock(root, { "node_modules/tool-native": { version: "1.0.0", optional: true, os: [process.platform], cpu: [process.arch] } });
    const r = run(["verify-tree", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("MISSING node_modules/tool-native (tool-native@1.0.0) — optional, and its platform admits this host");
  });

  it("refuses an installed optional package's absent required peer, and admits a fallback only platform builds name", () => {
    // An admission by "who needs it" must count peers: requiring `host` fails on the absent peer. The fallback
    // only platform-excluded builds list is the shape Vercel's npm leaves out (the 0.26.0 Cloud deploy).
    const root = tree([NODEMAILER]);
    add(root, "node_modules/host", { name: "host", version: "1.0.0", peerDependencies: { plugin: "^1.0.0" } });
    relock(root, {
      "node_modules/host": { version: "1.0.0", optional: true, peerDependencies: { plugin: "^1.0.0" } },
      "node_modules/plugin": { version: "1.0.0", optional: true },
      "node_modules/build-other": { version: "1.0.0", optional: true, os: [other], dependencies: { fallback: "1.0.0" } },
      "node_modules/fallback": { version: "1.0.0", optional: true },
    });
    const r = run(["verify-tree", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("MISSING node_modules/plugin (plugin@1.0.0) — optional, and its platform admits this host");
    expect(r.err).toContain("needed by node_modules/host");
    expect(r.err).not.toContain("fallback");
    expect(r.err).not.toContain("build-other");
  });

  describe("an optional entry no installed package needs may be absent (Vercel's npm)", () => {
    // The tag's lock: sharp's wasm32 build and @emnapi/runtime under it, optional with no os/cpu, listed only by
    // two platform builds this host skips. npm 10.9.8 installs both; the Vercel build image's npm does not.
    const vercelShape = (root: string, over: Record<string, Record<string, unknown>> = {}) =>
      relock(root, {
        "node_modules/@img/sharp-freebsd-wasm32": { version: "0.35.5", optional: true, os: [other], dependencies: { "@img/sharp-wasm32": "0.35.5" } },
        "node_modules/@img/sharp-webcontainers-wasm32": { version: "0.35.5", optional: true, cpu: ["wasm32"], dependencies: { "@img/sharp-wasm32": "0.35.5" } },
        "node_modules/@img/sharp-wasm32": { version: "0.35.5", optional: true, dependencies: { "@emnapi/runtime": "1.11.3" } },
        "node_modules/@emnapi/runtime": { version: "1.11.3", optional: true, dependencies: { tslib: "2.8.1" } },
        ...over,
      });

    it("admits the two orphans Vercel's install leaves out, names them, and apply patches", () => {
      const root = tree([NODEMAILER]);
      vercelShape(root);
      const r = run(["verify-tree", "--root", root]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/^ORPHAN_OPTIONAL_ADMITTED n=2 @img\/sharp-wasm32@0\.35\.5 @emnapi\/runtime@1\.11\.3 tree=\. /m);
      expect(r.out).toMatch(/^TREE_AS_LOCKED locked=5 present=1 skipped-optional=2 extra=\[\] tree=\.$/m);
      const a = run(["apply", "--root", root]);
      expect(a.code, a.err).toBe(0);
      expect(a.out).toContain("ORPHAN_OPTIONAL_ADMITTED n=2");
      expect(a.out).toContain("PATCHES_APPLIED 1/1");
    });

    it("refuses an orphan an installed package lists, by dependency or by peer", () => {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const root = tree([NODEMAILER]);
        add(root, "node_modules/user", { name: "user", version: "1.0.0" });
        vercelShape(root, { "node_modules/user": { version: "1.0.0", [field]: { "@img/sharp-wasm32": "0.35.5" } } });
        const r = run(["apply", "--root", root]);
        expect(r.code, field).not.toBe(0);
        expect(r.err).toContain("MISSING node_modules/@img/sharp-wasm32 (@img/sharp-wasm32@0.35.5) — optional, and its platform admits this host; needed by node_modules/user");
        expect(r.out).not.toContain("PATCHES_APPLIED");
      }
    });

    it("refuses an orphan the root lists, and one a present platform build lists", () => {
      const root = tree([NODEMAILER]);
      vercelShape(root, { "": { name: "fixture", workspaces: ["apps/mobile"], devDependencies: { "@emnapi/runtime": "1.11.3" } } });
      const r = run(["verify-tree", "--root", root]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("MISSING node_modules/@emnapi/runtime (@emnapi/runtime@1.11.3) — optional, and its platform admits this host; needed by the root");
      const built = tree([NODEMAILER]);
      add(built, "node_modules/@img/sharp-webcontainers-wasm32", { name: "@img/sharp-webcontainers-wasm32", version: "0.35.5" });
      vercelShape(built);
      const b = run(["verify-tree", "--root", built]);
      expect(b.code).not.toBe(0);
      expect(b.err).toContain("MISSING node_modules/@img/sharp-wasm32 (@img/sharp-wasm32@0.35.5) — optional, and its platform admits this host; needed by node_modules/@img/sharp-webcontainers-wasm32");
    });

    it("refuses a missing entry that is not optional, though only skipped builds list it", () => {
      const root = tree([NODEMAILER]);
      vercelShape(root, { "node_modules/@emnapi/runtime": { version: "1.11.3", dependencies: { tslib: "2.8.1" } } });
      const r = run(["apply", "--root", root]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("TREE_NOT_AS_LOCKED .: 1 difference(s)");
      expect(r.err).toContain("MISSING node_modules/@emnapi/runtime (@emnapi/runtime@1.11.3)\n");
      expect(r.out).not.toContain("ORPHAN_OPTIONAL_ADMITTED");
    });

    it("never admits a patched package absent, even optional and listed only by skipped builds", () => {
      const root = tree([NODEMAILER]);
      rmSync(join(root, "node_modules", "nodemailer"), { recursive: true });
      add(root, "node_modules/filler", { name: "filler", version: "1.0.0" });
      vercelShape(root, {
        "node_modules/nodemailer": { version: "8.0.11", optional: true },
        "node_modules/filler": { version: "1.0.0" },
        "node_modules/@img/sharp-wasm32": { version: "0.35.5", optional: true, dependencies: { "@emnapi/runtime": "1.11.3", nodemailer: "8.0.11" } },
      });
      const r = run(["apply", "--root", root]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("MISSING node_modules/nodemailer (nodemailer@8.0.11) — optional, and its platform admits this host; a patched package");
      expect(r.out).not.toContain("PATCHES_APPLIED");
    });

    it("still refuses a version mismatch and an extra package beside admitted orphans", () => {
      const root = tree([NODEMAILER]);
      vercelShape(root);
      add(root, "node_modules/nodemailer", { name: "nodemailer", version: "8.0.19" });
      add(root, "node_modules/stray", { name: "stray", version: "1.0.0" });
      const r = run(["apply", "--root", root]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("TREE_NOT_AS_LOCKED .: 2 difference(s)");
      expect(r.err).toContain("MOVED node_modules/nodemailer");
      expect(r.err).toContain("EXTRA node_modules/stray: on disk and not in the lock");
      expect(r.out).not.toContain("PATCHES_APPLIED");
    });
  });

  it("refuses a package directory the lock does not name, unless --extra names it, and reads no package's inner files", () => {
    const root = tree([NODEMAILER]);
    add(root, "node_modules/nodemailer/lib/esm", { type: "module" });
    add(root, "node_modules/typescript", { name: "typescript", version: "5.9.3" });
    add(root, "node_modules/typescript/node_modules/inner", { name: "inner", version: "1.0.0" });
    const r = run(["verify-tree", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("EXTRA node_modules/typescript: on disk and not in the lock");
    expect(r.err).not.toContain("lib/esm");
    const named = run(["verify-tree", "--root", root, "--extra", "typescript"]);
    expect(named.code, named.err).toBe(0);
    expect(named.out).toContain("extra=[typescript,inner]");
  });

  it("reads the desktop app's own tree beside the root's when it is installed", () => {
    const root = tree([NODEMAILER]);
    add(root, "apps/desktop/node_modules/vite", { name: "vite", version: "5.4.11" });
    writeFileSync(join(root, "apps/desktop/package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/vite": { version: "5.4.10" } } }));
    const r = run(["verify-tree", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("tree=.");
    expect(r.err).toContain("TREE_NOT_AS_LOCKED apps/desktop: 1 difference(s)");
    expect(r.err).toContain("MOVED node_modules/vite");
  });

  it("refuses a vacuous read: no lockfile, or one that names nothing", () => {
    const root = tree([NODEMAILER]);
    rmSync(join(root, "package-lock.json"));
    const none = run(["verify-tree", "--root", root]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("no package-lock.json to read the tree against");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    const empty = run(["verify-tree", "--root", root]);
    expect(empty.code).not.toBe(0);
    expect(empty.err).toContain("a vacuous read");
  });
});

describe("assert", () => {
  it("refuses upstream's code where the package is present, and admits ours", () => {
    const root = tree([NODEMAILER, TCP]);
    const lib = join(root, "node_modules", "nodemailer", "lib");
    const java = join(root, "node_modules", "react-native-tcp-socket", "android");
    const before = run(["assert", "--root", root, "--in", lib, "--require", "nodemailer"]);
    expect(before.code).not.toBe(0);
    expect(before.out).toContain("PATCH_MARKERS nodemailer present=0/2");
    expect(before.err).toContain("UNPATCHED nodemailer");
    const tcpBefore = run(["assert", "--root", root, "--in", java, "--require", "react-native-tcp-socket"]);
    expect(tcpBefore.code).not.toBe(0);
    expect(tcpBefore.out).toMatch(/PATCH_MARKERS react-native-tcp-socket present=0\/\d+/);
    expect(run(["apply", "--root", root]).code).toBe(0);
    const after = run(["assert", "--root", root, "--in", lib, "--in", java, "--require", "nodemailer", "--require", "react-native-tcp-socket"]);
    expect(after.code, after.err).toBe(0);
    expect(after.out).toContain("PATCH_MARKERS nodemailer present=2/2");
    expect(after.out).toMatch(/PATCH_MARKERS react-native-tcp-socket present=(\d+)\/\1/);
  });

  it("refuses a required package whose bytes are absent, and one marker missing", () => {
    const root = tree([NODEMAILER]);
    expect(run(["apply", "--root", root]).code).toBe(0);
    const other = join(root, "other.js");
    writeFileSync(other, "console.log('nothing of nodemailer here');\n");
    const absent = run(["assert", "--root", root, "--in", other, "--require", "nodemailer"]);
    expect(absent.code).not.toBe(0);
    expect(absent.err).toContain("NOT PRESENT nodemailer");
    writeFileSync(join(root, SMTP), readFileSync(join(root, SMTP), "utf8").replace("'those bytes arrived in cleartext", "'bytes arrived in cleartext"));
    const one = run(["assert", "--root", root, "--in", join(root, SMTP), "--require", "nodemailer"]);
    expect(one.code).not.toBe(0);
    expect(one.out).toContain("PATCH_MARKERS nodemailer present=1/2");
    expect(one.err).toContain('UNPATCHED nodemailer: "those bytes arrived in cleartext');
  });

  it("refuses a call that requires nothing, or a package no patch names", () => {
    const root = tree([NODEMAILER]);
    const none = run(["assert", "--root", root, "--in", join(root, SMTP)]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("assert needs --require");
    const unknown = run(["assert", "--root", root, "--in", join(root, SMTP), "--require", "nodemailerx"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("--require nodemailerx: no patch names it");
  });
});

describe("markers", () => {
  type Table = Record<string, { name: string; paths: string[]; control: string | null; markers: string[]; appleMarkers: string[] }>;
  const table = JSON.parse(run(["markers", "--json"]).out) as Table;

  it("read Apple sources apart: a dex is never asked for a literal only the iOS half carries", () => {
    const web = table[WEBVIEW]!;
    expect(web.appleMarkers).toEqual(["ohmail-webview-document-height-ios"]);
    expect(web.markers).not.toContain("ohmail-webview-document-height-ios");
    expect(web.markers).toContain("ohmail-webview-document-height");
    expect(table[TCP]!.appleMarkers).toEqual([]);
  });

  it("are the literals the patch adds, which upstream lacks and our installed copy carries", () => {
    const withMarkers = Object.entries(table).filter(([, t]) => t.markers.length > 0);
    expect(withMarkers.map(([f]) => f).sort()).toEqual([NODEMAILER, POSTGRES, TCP, WEBVIEW]);
    const root = tree(withMarkers.map(([f]) => f));
    for (const [file, t] of withMarkers) {
      const read = (base: string) => t.paths.map((p) => readFileSync(join(base, p), "utf8")).join("\n");
      const upstream = read(join(root, "node_modules", t.name));
      const ours = read(installedPatched(t.name));
      for (const m of t.markers) {
        expect(upstream.includes(m), `${file}: upstream already carries ${JSON.stringify(m)}`).toBe(false);
        expect(ours.includes(m), `${file}: our installed copy lacks ${JSON.stringify(m)}`).toBe(true);
      }
      expect(t.control && upstream.includes(t.control), `${file}: the control is upstream's literal`).toBe(true);
    }
  });

  it("skip comments, context and removed lines, short literals and escapes", () => {
    const root = join(SCRATCH, "synthetic");
    mkdirSync(join(root, "patches"), { recursive: true });
    const lines = [
      "diff --git a/lib/x.js b/lib/x.js",
      "index 1111111..2222222 100644",
      "--- a/lib/x.js",
      "+++ b/lib/x.js",
      "@@ -1,3 +1,9 @@",
      " const kept = \"a literal upstream already has on a context line\";",
      "-const gone = \"a literal on a removed line that is not ours\";",
      "+const added = \"a literal this patch adds to the code\";",
      "+const again = \"a literal upstream already has on a context line\";",
      "+// \"a literal inside a line comment is not code\"",
      "+/* \"a literal inside a block comment is not code\"",
      "+ * \"still inside that block comment, on its next line\" */",
      "+const short = \"too short\";",
      "+const escaped = \"a literal with an escape \\n inside it here\";",
    ];
    writeFileSync(join(root, "patches", "x.patch"), `${lines.join("\n")}\n`);
    const r = run(["markers", "--json", "--root", root]);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as Table)["x.patch"]!.markers).toEqual(["a literal this patch adds to the code"]);
  });
});

// The fixture builder is itself checked: an arm run against a copy that was never recovered to
// upstream would pass the refusals for the wrong reason.
describe("the fixtures are upstream's code", () => {
  it("recovers the pre-patch file the patch applies to", () => {
    const root = tree([NODEMAILER]);
    expect(existsSync(join(root, SMTP))).toBe(true);
    expect(git(["apply", "--check", "-"], join(root, "node_modules", "nodemailer"), readFileSync(join(root, "patches", NODEMAILER), "utf8")).code).toBe(0);
  });
});
