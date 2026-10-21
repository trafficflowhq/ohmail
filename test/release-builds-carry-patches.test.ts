import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * EVERY BUILD MADE FROM THE PUBLISHED TREE APPLIES OUR PATCHES, AND READS THEM IN WHAT IT MADE.
 *
 * The public workflows install with `npm ci`, which applies no patch, and for eight releases no
 * Android build carried the transport patch: the literals were absent from every release APK's dex
 * and a phone's STARTTLS send failed. These checkers read the workflows, the image recipes and the
 * Flatpak manifest as text; each is shown refusing a copy of the real file with one line removed.
 */
const ROOT = resolve(__dirname, "..");
const read = (f: string): string => readFileSync(join(ROOT, f), "utf8");
const WF = publicRel("github/workflows");
const WORKFLOWS = [`${WF}/android.yml`, `${WF}/build.yml`];
const DOCKERFILES = ["apps/server/Dockerfile", "apps/worker/Dockerfile.selfhost", "apps/webapp/Dockerfile"];
const FLATPAK = "apps/desktop/flatpak/app.ohmail.Desktop.yml";
const BUNDLERS = ["scripts/engine-bundle.mjs", "scripts/bundle-host.mjs", "apps/mobile/scripts/bundle-engine.mjs"];
const BUILDER = /engine-bundle\.mjs|bundle-engine\.mjs|bundle-host\.mjs|expo prebuild|gradlew/;
const APPLY = /^\s*(?:run:\s*|RUN\s+|- )?node scripts\/apply-patches\.mjs apply\s*$/;
const VERIFY = /^\s*(?:RUN\s+)?node scripts\/apply-patches\.mjs verify-tree\b/;
const code = (body: string): string[] => body.split("\n").filter((l) => !/^\s*#/.test(l));
/* npm's install commands by every name npm answers to (`npm help install`, `npm help ci`), flags allowed
 * before the command. A command spelled another way is an install this census would not read. */
const NPM = "npm(?:\\s+-{1,2}[\\w-]+(?:[=\\s]+[^\\s-]\\S*)?)*\\s+";
const CI_NAMES = "ci|clean-install|ic|install-clean|isntall-clean|cit|install-ci-test|clean-install-test|sit";
const ADD_NAMES = "install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|install-test|it";
const NPM_CI = new RegExp(`(^|[\\s;&|(\`-])${NPM}(?:${CI_NAMES})(?![\\w-])`);
const NPM_ADD = new RegExp(`(^|[\\s;&|(\`-])${NPM}(?:${ADD_NAMES})(?![\\w-])`);
const npmInstalls = (l: string) => NPM_CI.test(l) || NPM_ADD.test(l);

/* The published build files, DERIVED: every workflow the mirror publishes, and every recipe a workflow's
 * code names (an image's Dockerfile, the Flatpak manifest). A new one joins the census by existing. */
export function consumers(root: string): string[] {
  const wfs = readdirSync(join(root, WF)).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => `${WF}/${f}`);
  const named = new Set<string>();
  for (const f of wfs) {
    const text = code(readFileSync(join(root, f), "utf8")).join("\n");
    for (const m of text.matchAll(/\bapps\/[\w./-]*?(?:Dockerfile[\w.-]*|flatpak\/[\w.-]+\.ya?ml)/g)) {
      if (!m[0].endsWith(".dockerignore") && existsSync(join(root, m[0]))) named.add(m[0]);
    }
  }
  return [...wfs, ...[...named].sort()];
}

type Step = { job: string; line: number; wd: string | null; body: string };
function steps(text: string): Step[] {
  const lines = text.split("\n");
  const out: Step[] = [];
  let job = "";
  let cur: Step | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const [i, l] of lines.entries()) {
    const j = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l);
    if (j) { flush(); job = j[1]!; continue; }
    if (/^ {6}- (name|uses):/.test(l)) { flush(); cur = { job, line: i + 1, wd: null, body: "" }; }
    if (!cur) continue;
    cur.body += `${l}\n`;
    const wd = /^ {8}working-directory:\s*(\S+)/.exec(l);
    if (wd) cur.wd = wd[1]!;
  }
  flush();
  return out;
}

const rootInstall = (s: Step) => (s.wd === null || s.wd === ".") && code(s.body).some((l) => NPM_CI.test(l) && !/--prefix/.test(l));
const applies = (s: Step) => code(s.body).some((l) => APPLY.test(l));
const builds = (s: Step) => code(s.body).some((l) => BUILDER.test(l));

/** Workflow jobs where a root install is not followed by the apply step before a build. */
export function workflowOffenders(file: string, text: string): string[] {
  const all = steps(text);
  const found: string[] = [];
  for (const [i, s] of all.entries()) {
    if (!rootInstall(s)) continue;
    const rest = all.slice(i + 1).filter((t) => t.job === s.job);
    const at = rest.findIndex(applies);
    const build = rest.findIndex(builds);
    if (at === -1) found.push(`${file} ${s.job}: the install at line ${s.line} is never followed by the apply step`);
    else if (build !== -1 && build < at) found.push(`${file} ${s.job}: line ${rest[build]!.line} builds before the patches are applied`);
    /* A later `npm install` moves the tree `npm ci` laid down; its own step reads the tree back. */
    for (const t of rest) {
      const lines = code(t.body);
      const inst = lines.findIndex((l) => NPM_ADD.test(l));
      if (inst === -1) continue;
      if (!lines.slice(inst + 1).some((l) => VERIFY.test(l))) found.push(`${file} ${s.job}: the npm install at line ${t.line} is not read back by verify-tree before the step builds on it`);
    }
  }
  return found;
}

/** Jobs that run Gradle without reading the transport patch's literals in the dex before upload. */
export function dexOffenders(file: string, text: string): string[] {
  const all = steps(text);
  const found: string[] = [];
  for (const job of new Set(all.filter((s) => code(s.body).some((l) => /gradlew/.test(l))).map((s) => s.job))) {
    const js = all.filter((s) => s.job === job);
    const gradle = js.findIndex((s) => code(s.body).some((l) => /gradlew/.test(l)));
    const reads = js.findIndex((s, k) => k > gradle && code(s.body).some((l) => /apply-patches\.mjs assert --in \/tmp\/dexcmp\/apk --require react-native-tcp-socket\b/.test(l)));
    const upload = js.findIndex((s, k) => k > gradle && /uses: actions\/upload-artifact/.test(s.body));
    if (reads === -1) found.push(`${file} ${job}: no dex read of the transport patch after Gradle`);
    else if (upload !== -1 && upload < reads) found.push(`${file} ${job}: an artefact is uploaded before the dex read`);
    else {
      const body = code(js[reads]!.body).join("\n");
      if (body.indexOf("apply-patches.mjs assert") > body.indexOf("diff -u /tmp/dexcmp/apk.sha")) found.push(`${file} ${job}: the dex read comes after the bundle identity check`);
    }
  }
  return found;
}

/** Recipe stages where `npm ci` is not followed by git and the apply step before the build. */
export function dockerOffenders(file: string, text: string): string[] {
  const found: string[] = [];
  for (const stage of text.split(/^(?=FROM )/m)) {
    const runs = stage.split("\n").filter((l) => /^RUN /.test(l));
    const ci = runs.findIndex((l) => NPM_CI.test(l));
    if (ci === -1) continue;
    const at = runs.findIndex((l) => APPLY.test(l));
    const gitAt = runs.findIndex((l) => /apt-get install\b.*\bgit\b/.test(l));
    const build = runs.findIndex((l, k) => k > ci && /bundle-host\.mjs|next build/.test(l));
    if (at === -1 || at < ci) found.push(`${file}: the stage's npm ci is not followed by the apply step`);
    else if (build !== -1 && build < at) found.push(`${file}: the stage builds before the patches are applied`);
    else if (gitAt === -1 || gitAt > at) found.push(`${file}: the stage applies the patches without installing git first`);
    /* Nothing is installed outside the lock unless the next step reads the tree back. */
    runs.forEach((l, k) => {
      if (NPM_ADD.test(l) && !VERIFY.test(runs[k + 1] ?? "")) found.push(`${file}: "${l.trim()}" is not followed by verify-tree`);
    });
  }
  return found;
}

/** Every npm install line of a published build file that would run dependency install scripts. */
export function unscriptedInstalls(file: string, text: string): string[] {
  return code(text.replace(/\\\n\s*/g, " ")).filter((l) => npmInstalls(l) && !/--ignore-scripts\b/.test(l))
    .map((l) => `${file}: ${l.trim()}`);
}

/** The Flatpak's build commands: a root install followed by the apply step before the engine. */
export function flatpakOffenders(file: string, text: string): string[] {
  const cmds = text.split("\n").map((l) => /^ {6}- (.+)$/.exec(l)?.[1]).filter((c): c is string => c !== undefined);
  const ci = cmds.findIndex((c) => /^npm ci\b/.test(c) && !/--prefix/.test(c));
  if (ci === -1) return [`${file}: no root npm ci among the build commands — the reader stopped matching`];
  const at = cmds.findIndex((c, k) => k > ci && c === "node scripts/apply-patches.mjs apply");
  const engine = cmds.findIndex((c) => /engine-bundle\.mjs/.test(c));
  if (at === -1) return [`${file}: the root npm ci is never followed by the apply step`];
  return engine !== -1 && engine < at ? [`${file}: the engine is bundled before the patches are applied`] : [];
}

/** A bundler that hands over its output without asserting the mail sender's patch in it. */
export function bundlerOffenders(file: string, text: string): string[] {
  const call = /"apply-patches\.mjs"\), "assert",\s*"--root", \w+, "--in", \w+, "--require", "nodemailer"\]/.test(text);
  const acts = /if \(patched\.status !== 0\) \{\s*(?:rmSync|for \()/.test(text);
  return call && acts ? [] : [`${file}: the bundle is not asserted to carry the nodemailer patch, or a refusal keeps it`];
}

/** Every assert call in a build file names what it requires: an unrequired absence reads as a pass. */
export function unrequiredAsserts(file: string, text: string): string[] {
  return code(text).filter((l) => /apply-patches\.mjs assert\b/.test(l) && !/--require \S/.test(l)).map((l) => `${file}: ${l.trim()}`);
}

describe("every build from the published tree applies the patches before it builds", () => {
  it("in both workflows", () => {
    for (const f of WORKFLOWS) expect(steps(read(f)).filter(rootInstall).length, `${f}: no root npm ci found — the reader moved`).toBeGreaterThan(0);
    expect(WORKFLOWS.flatMap((f) => workflowOffenders(f, read(f)))).toEqual([]);
  });

  it("in the three self-host image recipes, with git in the build stage", () => {
    expect(DOCKERFILES.flatMap((f) => dockerOffenders(f, read(f)))).toEqual([]);
    for (const f of DOCKERFILES) expect(read(f), `${f} has no npm ci — the reader moved`).toMatch(/^RUN npm ci\b/m);
  });

  it("in the Flatpak manifest", () => {
    expect(flatpakOffenders(FLATPAK, read(FLATPAK))).toEqual([]);
  });

  it("and the one install left out is the desktop's own tree, which no engine is built from", () => {
    // apps/desktop lists the engine's packages as a licence record; every bundler resolves from the root.
    const own = WORKFLOWS.flatMap((f) => steps(read(f)).filter((s) => !rootInstall(s) && code(s.body).some((l) => NPM_CI.test(l))));
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) expect(s.wd, `${s.job} line ${s.line}`).toBe("apps/desktop");
  });
});

describe("no published build runs a dependency's install script", () => {
  it("every npm install, in every published workflow and every recipe one names, carries --ignore-scripts", () => {
    const files = consumers(ROOT);
    expect(files).toEqual(expect.arrayContaining([...["android", "build", "dco", "ghcr-images", "release-feeds"].map((w) => `${WF}/${w}.yml`), ...DOCKERFILES, FLATPAK]));
    for (const f of [...WORKFLOWS, ...DOCKERFILES, FLATPAK]) {
      expect(code(read(f).replace(/\\\n\s*/g, " ")).filter(npmInstalls).length, `${f}: no npm install line found — the reader moved`).toBeGreaterThan(0);
    }
    expect(files.flatMap((f) => unscriptedInstalls(f, read(f)))).toEqual([]);
  });

  it("reads npm's other names for an install, flags before the command included", () => {
    for (const l of ["run: npm i", "RUN npm add esbuild", "&& npm clean-install", "- npm --prefix apps/desktop ci", "npm isntall", "npm it"]) {
      expect(unscriptedInstalls("x", l), l).toEqual([`x: ${l}`]);
    }
    for (const l of ["npm info esbuild", "npm run build", "npm pack", "npm view esbuild version", "npx --offline next build"]) {
      expect(unscriptedInstalls("x", l), l).toEqual([]);
    }
  });

  it("refuses a scripted install planted in a workflow the old list left out, and an npm i side install", () => {
    const tree = mkdtempSync(join(tmpdir(), "ohmail-scripted-installs-"));
    try {
      for (const f of consumers(ROOT)) cpSync(join(ROOT, f), join(tree, f), { recursive: true });
      expect(consumers(tree)).toEqual(consumers(ROOT));
      const feeds = join(tree, WF, "release-feeds.yml");
      writeFileSync(feeds, `${readFileSync(feeds, "utf8")}      - run: npm ci --no-audit --no-fund\n`);
      const server = join(tree, "apps/server/Dockerfile");
      const text = readFileSync(server, "utf8").replace("RUN node scripts/apply-patches.mjs apply\n", "RUN node scripts/apply-patches.mjs apply\nRUN npm i --no-save esbuild@0.24.0\n");
      writeFileSync(server, text);
      expect(consumers(tree).flatMap((f) => unscriptedInstalls(f, readFileSync(join(tree, f), "utf8")))).toEqual([
        `${WF}/release-feeds.yml: - run: npm ci --no-audit --no-fund`,
        "apps/server/Dockerfile: RUN npm i --no-save esbuild@0.24.0",
      ]);
      expect(dockerOffenders("server", text)).toEqual(['server: "RUN npm i --no-save esbuild@0.24.0" is not followed by verify-tree']);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("refuses a copy with one flag removed, in a workflow, a recipe and the Flatpak manifest", () => {
    const wf = read(`${WF}/build.yml`).replace("npm ci --ignore-scripts --no-audit --no-fund", "npm ci --no-audit --no-fund");
    expect(unscriptedInstalls("build.yml", wf)).toEqual(['build.yml: run: bash "$GITHUB_WORKSPACE/.github/scripts/retry-infra.sh" npm-network -- npm ci --no-audit --no-fund']);
    const web = read("apps/webapp/Dockerfile").replace("npm install --no-save --ignore-scripts", "npm install --no-save");
    expect(unscriptedInstalls("webapp", web)).toHaveLength(1);
    const fp = read(FLATPAK).replace("--offline --ignore-scripts --no-audit --no-fund --prefix", "--offline --no-audit --no-fund --prefix");
    expect(unscriptedInstalls("flatpak", fp)).toEqual(["flatpak: - npm ci --offline --no-audit --no-fund --prefix apps/desktop"]);
  });
});

describe("a tree moved after npm ci is read back before anything is built from it", () => {
  it("the engine job and the web recipe read theirs, and the recipes install nothing else", () => {
    expect(read(`${WF}/build.yml`)).toMatch(/npm install --no-save[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*\n\s*node scripts\/apply-patches\.mjs verify-tree --extra typescript/);
    expect(read("apps/webapp/Dockerfile")).toMatch(/^RUN node scripts\/apply-patches\.mjs verify-tree --extra typescript/m);
    for (const f of ["apps/server/Dockerfile", "apps/worker/Dockerfile.selfhost"]) expect(read(f)).not.toMatch(/^RUN [^\n]*npm install\b/m);
  });

  it("refuses the web recipe without its verify-tree line, and a side install put back", () => {
    const web = read("apps/webapp/Dockerfile");
    const cut = web.replace(/^RUN node scripts\/apply-patches\.mjs verify-tree[^\n]*\n/m, "");
    expect(cut).not.toBe(web);
    expect(dockerOffenders("webapp", cut)).toEqual([expect.stringMatching(/^webapp: "RUN npm install --no-save --ignore-scripts --no-audit --no-fund \\" is not followed by verify-tree$/)]);
    const server = read("apps/server/Dockerfile").replace("RUN node scripts/apply-patches.mjs apply\n",
      "RUN node scripts/apply-patches.mjs apply\nRUN mkdir -p /tmp/esbuild && cd /tmp/esbuild && npm install --no-save --ignore-scripts esbuild@0.24.0\n");
    expect(dockerOffenders("server", server)).toHaveLength(1);
  });

  it("refuses the engine job without its verify-tree line", () => {
    const wf = read(`${WF}/build.yml`);
    const cut = wf.replace(/^\s*node scripts\/apply-patches\.mjs verify-tree --extra typescript[^\n]*\n/m, "");
    expect(cut).not.toBe(wf);
    expect(workflowOffenders("build.yml", cut)).toEqual([expect.stringMatching(/^build\.yml engine: the npm install at line \d+ is not read back by verify-tree before the step builds on it$/)]);
  });
});

describe("every build reads the patch in what it made", () => {
  it("both Android jobs read the transport patch in the dex, before any upload", () => {
    const text = read(`${WF}/android.yml`);
    expect(dexOffenders(`${WF}/android.yml`, text)).toEqual([]);
    // The mail frame's height patch is read in the same dex, in both jobs.
    expect(code(text).filter((l) => /apply-patches\.mjs assert --in \/tmp\/dexcmp\/apk .*--require react-native-webview\b/.test(l)).length).toBe(2);
    expect(steps(text).filter((s) => code(s.body).some((l) => /gradlew/.test(l))).length, "no Gradle step found — the reader moved").toBeGreaterThan(0);
  });

  it("the three bundlers assert the mail sender's patch in their output and remove a refused one", () => {
    expect(BUNDLERS.flatMap((f) => bundlerOffenders(f, read(f)))).toEqual([]);
  });

  it("the packaged engines and the image bundles are read too, and no read goes unrequired", () => {
    const build = steps(read(`${WF}/build.yml`));
    for (const job of ["macos", "linux", "linux-arm64"]) {
      const reads = build.filter((s) => s.job === job && code(s.body).some((l) => /apply-patches\.mjs assert --in \S*ohmail-engine\.mjs"? --require nodemailer/.test(l)));
      expect(reads.length, `${job}: the packaged engine is not read for the patch`).toBeGreaterThan(0);
    }
    expect(read(`${WF}/ghcr-images.yml`)).toContain("node scripts/apply-patches.mjs assert --in /tmp/image-bundle.mjs --require nodemailer");
    const files = [...WORKFLOWS, `${WF}/ghcr-images.yml`, ...DOCKERFILES, FLATPAK, ...BUNDLERS];
    expect(files.flatMap((f) => unrequiredAsserts(f, read(f)))).toEqual([]);
  });
});

describe("the checkers refuse the shape they exist for", () => {
  const android = read(`${WF}/android.yml`);
  const applyStep = "      - name: Apply the patches this repository carries\n        run: node scripts/apply-patches.mjs apply\n";

  it("a workflow job whose apply step is gone", () => {
    const cut = android.replace(applyStep, "");
    expect(cut).not.toBe(android);
    expect(workflowOffenders("android.yml", cut)).toEqual([expect.stringMatching(/^android\.yml apk: the install at line \d+ is never followed by the apply step$/)]);
  });

  it("a job that builds before it applies", () => {
    const moved = android.replace(applyStep, "").replace("      - name: Generate the native Android project\n", `${applyStep}\n      - name: Generate the native Android project\n`);
    expect(workflowOffenders("android.yml", moved)).toEqual([expect.stringMatching(/^android\.yml apk: line \d+ builds before the patches are applied$/)]);
  });

  it("a Gradle job with no dex read, and a read with no --require", () => {
    const line = "          node scripts/apply-patches.mjs assert --in /tmp/dexcmp/apk --require react-native-tcp-socket --require react-native-webview\n";
    const last = android.lastIndexOf(line);
    const cut = android.slice(0, last) + android.slice(last + line.length);
    expect(dexOffenders("android.yml", cut)).toEqual(["android.yml build: no dex read of the transport patch after Gradle"]);
    const bare = android.replace(line, "          node scripts/apply-patches.mjs assert --in /tmp/dexcmp/apk\n");
    expect(unrequiredAsserts("android.yml", bare)).toEqual(["android.yml: node scripts/apply-patches.mjs assert --in /tmp/dexcmp/apk"]);
  });

  it("a recipe without its apply step, or without git", () => {
    const server = read("apps/server/Dockerfile");
    expect(dockerOffenders("server", server.replace("RUN node scripts/apply-patches.mjs apply\n", ""))).toEqual(["server: the stage's npm ci is not followed by the apply step"]);
    const noGit = server.replace(/^RUN apt-get update && apt-get install [^\n]*\n/m, "");
    expect(noGit).not.toBe(server);
    expect(dockerOffenders("server", noGit)).toEqual(["server: the stage applies the patches without installing git first"]);
  });

  it("a Flatpak manifest and a bundler without theirs", () => {
    const manifest = read(FLATPAK);
    expect(flatpakOffenders("flatpak", manifest.replace("      - node scripts/apply-patches.mjs apply\n", ""))).toEqual(["flatpak: the root npm ci is never followed by the apply step"]);
    const engine = read("scripts/engine-bundle.mjs");
    expect(bundlerOffenders("engine", engine.replace('"--require", "nodemailer"]', "]"))).toHaveLength(1);
  });
});

describe("the patches and what derives from them", () => {
  const files = readdirSync(join(ROOT, "patches")).filter((f) => f.endsWith(".patch")).sort();
  const scratch = mkdtempSync(join(tmpdir(), "ohmail-carry-patches-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  type Table = Record<string, { name: string; paths: string[]; control: string | null; markers: string[] }>;
  const markers = (root?: string): Table => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/apply-patches.mjs"), "markers", "--json", ...(root ? ["--root", root] : [])], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as Table;
  };
  const appleOnly = (paths: string[]) => paths.every((p) => /^(ios|apple)\//.test(p));
  const unmarked = (t: Table) => Object.entries(t).filter(([, e]) => !appleOnly(e.paths) && (e.markers.length === 0 || !e.control)).map(([f]) => f);

  const table = markers();
  it.each(Object.entries(table).map(([f, e]) => [f, appleOnly(e.paths) ? "Apple sources only, which no build here compiles" : "has literals to read and a control"]))(
    "%s: %s", (file) => {
      expect(unmarked({ [file]: table[file]! })).toEqual([]);
    });

  it("refuses a patch whose added literals are gone", () => {
    mkdirSync(join(scratch, "patches"), { recursive: true });
    const text = read("patches/nodemailer@8.0.11.patch").split("\n").map((l) => (l.startsWith("+") ? l.replace(/'[^']*'/g, "x") : l)).join("\n");
    writeFileSync(join(scratch, "patches", "nodemailer@8.0.11.patch"), text);
    expect(unmarked(markers(scratch))).toEqual(["nodemailer@8.0.11.patch"]);
  });

});
