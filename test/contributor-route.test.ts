import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARDS } from "./support/ci-shards.mjs";
import { ROOT, publicPath } from "./support/public-root.mjs";

/**
 * THE WEEKLY FRESH-CLONE JOB RUNS WHAT THE DOCUMENTS SAY, WORD FOR WORD (1.0 criterion 7).
 *
 * `.github/workflows/contributor.yml` clones the repository on a clean Linux, macOS and Windows runner and runs
 * the build in docs/install.md, CONTRIBUTING's install, the suite and the desktop app's checks: per platform one build job
 * and the suite in PARTS jobs, each its own fresh clone. Each of those is a bash
 * block marked `<!-- run by .github/workflows/contributor.yml: <id> -->` (with ` in <dir>` when it runs in a
 * directory) and a step named `<doc> · <id>` whose run is that block. The commands live in the workflow, where
 * the workflow tests read them (pins, --ignore-scripts, the Rust pin, downloads); this file holds the two
 * equal, so a pull request that edits a block is red until the workflow follows, and the job holds no
 * credential, no secret and no trigger but the schedule and a dispatch.
 */
const yaml = createRequire(__filename)("js-yaml") as { load(text: string): unknown; dump(v: unknown): string };

export const MARKER = /^\s*<!-- run by \.github\/workflows\/contributor\.yml: ([a-z0-9-]+)(?: in ([\w./-]+))? -->$/;
export const DOCS = ["docs/install.md", "CONTRIBUTING.md", "apps/desktop/README.md"] as const;

/** The suite's parts per platform, one job each: run 39637951099 measured it serial at 310 min on Windows, 156 on
 *  macOS and 268 with the services on Linux, so one job per platform ran up against its timeout. */
export const PARTS: Record<string, number> = { linux: 2, macos: 2, windows: 4 };
/** The first line of a block a part runs: unset, it is the whole suite. */
export const PART_DEFAULT = ': "${PART:=1}" "${PARTS:=1}"';
const BUILD = ["docs/install.md · interface", "docs/install.md · engine", "CONTRIBUTING.md · install", "CONTRIBUTING.md · desktop", "apps/desktop/README.md · verify"];
const suiteOf = (os: string) => (os === "linux" ? "CONTRIBUTING.md · suite-services" : "CONTRIBUTING.md · suite");
/** Each job's steps in order: the three setup steps by kind, every other step by its block's label. */
export const ROUTE: Record<string, string[]> = Object.fromEntries(
  Object.entries(PARTS).flatMap(([os, n]) => [
    [`${os}-build`, ["checkout", "setup-node", ...(os === "linux" ? ["docs/install.md · linux-packages"] : []), "Toolchain", ...BUILD]],
    ...Array.from({ length: n }, (_, k) => [`${os}-suite-${k + 1}`, ["checkout", "setup-node", "CONTRIBUTING.md · install", suiteOf(os)]]),
  ]),
);
const RUNNERS: Record<string, string> = { macos: "macos-latest", windows: "windows-latest" };
const TRIGGERS = { schedule: [{ cron: "41 4 * * 0" }], workflow_dispatch: null };
const CONCURRENCY = { group: "contributor-${{ github.ref }}", "cancel-in-progress": false };
const JOB_KEYS = ["defaults", "name", "runs-on", "steps", "timeout-minutes"];
const ALONE_GREP = /git grep -l '@postpush: alone' -- (.+?)\)/;

type Step = Record<string, unknown> & { name?: unknown; uses?: unknown; run?: unknown; with?: unknown };
type Workflow = Record<string, unknown> & { on?: unknown; env?: Record<string, unknown>; jobs?: Record<string, Record<string, unknown>> };
export type Block = { doc: string; id: string; label: string; dir: string | null; line: number; text: string; commands: string[] };
export type Inputs = { contributor: string; docs: Record<string, string>; build: string; ci: string; claude: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const indentOf = (l: string) => /^ */.exec(l)![0].length;

/** A line without its `#` comment: a `#` that starts a word outside quotes. */
function uncomment(line: string): string {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = "";
      else if (c === "\\" && q === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/** A block's commands: the common indent removed, continuations joined, comments and blank lines dropped. */
export function commandsOf(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const cut = Math.min(...raw.filter((l) => l.trim()).map(indentOf));
  return raw.map((l) => l.slice(Math.min(cut, indentOf(l)))).join("\n").replace(/[ \t]*\\\n\s*/g, " ")
    .split("\n").map((l) => uncomment(l).trimEnd()).filter((l) => l.trim() !== "");
}

/** Every marked block of the documents, and every marker that is not where it must be. */
export function markedBlocks(docs: Record<string, string>): { blocks: Block[]; findings: string[] } {
  const blocks: Block[] = [];
  const findings: string[] = [];
  for (const [doc, text] of Object.entries(docs)) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    lines.forEach((l, i) => {
      const m = MARKER.exec(l);
      if (!m) {
        if (l.includes("run by .github/workflows/contributor.yml")) findings.push(`${doc}:${i + 1}: a marker this reader cannot read: ${l.trim()}`);
        return;
      }
      const fence = /^(\s*)```bash\s*$/.exec(lines[i + 1] ?? "");
      if (!fence) return void findings.push(`${doc}:${i + 1}: the marker ${m[1]} is not directly above a \`\`\`bash fence`);
      const end = lines.findIndex((e, k) => k > i + 1 && /^\s*```\s*$/.test(e));
      if (end < 0) return void findings.push(`${doc}:${i + 2}: the block ${m[1]} is never closed`);
      const label = `${doc} · ${m[1]}`;
      if (blocks.some((b) => b.label === label)) return void findings.push(`${doc}:${i + 1}: the id ${m[1]} is marked twice`);
      const body = lines.slice(i + 2, end).join("\n");
      blocks.push({ doc, id: m[1]!, label, dir: m[2] ?? null, line: i + 2, text: body, commands: commandsOf(body) });
    });
  }
  return { blocks, findings };
}

const parsed = new Map<string, boolean>();
/** bash -n over a block: it parses, or the run would fail at its first line. */
function parses(text: string): boolean {
  if (!parsed.has(text)) parsed.set(text, spawnSync("bash", ["-n"], { input: text, encoding: "utf8" }).status === 0);
  return parsed.get(text)!;
}

/** The kind or label a step is read as in ROUTE. */
function labelOf(s: Step): string {
  const uses = String(s.uses ?? "");
  if (uses.startsWith("actions/checkout@")) return "checkout";
  if (uses.startsWith("actions/setup-node@")) return "setup-node";
  return String(s.name ?? uses);
}

/** The first bash block under a heading of a markdown file. */
function blockUnder(text: string, heading: string): string[] {
  const from = text.indexOf(`\n${heading}\n`);
  const m = from < 0 ? null : /```bash\n([\s\S]*?)\n```/.exec(text.slice(from));
  return m ? commandsOf(m[1]!) : [];
}

/** Every way the workflow departs from the documents and the shape above, one line each; [] when they hold. */
export function routeFindings(inputs: Inputs): string[] {
  const out: string[] = [];
  let wf: Workflow, build: Workflow;
  try {
    wf = (yaml.load(inputs.contributor) ?? {}) as Workflow;
    build = (yaml.load(inputs.build) ?? {}) as Workflow;
  } catch (e) {
    return [`a workflow does not parse: ${String(e).slice(0, 120)}`];
  }
  const { blocks, findings } = markedBlocks(inputs.docs);
  out.push(...findings);
  const byLabel = new Map(blocks.map((b) => [b.label, b]));
  const routed = new Set(Object.values(ROUTE).flat());

  // The workflow's own settings.
  const on = (wf.on ?? {}) as Record<string, unknown>;
  if (!same(Object.keys(on).sort(), Object.keys(TRIGGERS))) out.push(`the triggers are ${Object.keys(on).sort().join(", ")}, not schedule and workflow_dispatch alone`);
  if (!same(on.schedule, TRIGGERS.schedule)) out.push(`the schedule is ${JSON.stringify(on.schedule)}, not ${JSON.stringify(TRIGGERS.schedule)}`);
  if ("workflow_dispatch" in on && on.workflow_dispatch !== null && !same(on.workflow_dispatch, {})) out.push("workflow_dispatch takes inputs");
  if (!same(wf.permissions, { contents: "read" })) out.push(`permissions are ${JSON.stringify(wf.permissions)}, not contents: read`);
  if (!same(wf.concurrency, CONCURRENCY)) out.push(`concurrency is ${JSON.stringify(wf.concurrency)}`);
  const pin = build.env?.RUST_TOOLCHAIN;
  if (!same(wf.env, { RUST_TOOLCHAIN: pin })) out.push(`env is ${JSON.stringify(wf.env)}, not RUST_TOOLCHAIN ${String(pin)} as in build.yml`);
  const extraTop = Object.keys(wf).filter((k) => !["name", "on", "permissions", "concurrency", "env", "jobs"].includes(k));
  if (extraTop.length) out.push(`the workflow carries ${extraTop.join(", ")}`);
  inputs.contributor.split("\n").forEach((l, i) => {
    if (!/^\s*#/.test(l) && /\bsecrets\.|\bvars\.|\bgithub\.token\b/.test(l)) out.push(`contributor.yml:${i + 1}: reads ${l.trim().slice(0, 80)}`);
  });

  // The things a step must equal, read off the other files.
  const node = /\(CI runs (\d+\.\d+\.\d+)\)/.exec(inputs.docs["CONTRIBUTING.md"] ?? "")?.[1];
  if (!node) out.push("CONTRIBUTING.md names no Node CI runs");
  const ubuntu = /\bon Ubuntu\s+(\d+\.\d+)/.exec(inputs.docs["docs/install.md"] ?? "")?.[1];
  if (!ubuntu) out.push("docs/install.md names no Ubuntu release");
  const toolchain = ((build.jobs?.linux?.steps ?? []) as Step[]).find((s) => s.name === "Toolchain")?.run;
  if (typeof toolchain !== "string") out.push("build.yml's linux job has no Toolchain step");

  // Per job; one finding per departure, naming every job it holds in.
  const where = new Map<string, string[]>();
  const note = (what: string, job: string) => where.set(what, [...(where.get(what) ?? []), job]);
  const jobs = wf.jobs ?? {};
  if (!same(Object.keys(jobs).sort(), Object.keys(ROUTE).sort())) out.push(`the jobs are ${Object.keys(jobs).sort().join(", ")}, not ${Object.keys(ROUTE).sort().join(", ")}`);
  for (const [id, want] of Object.entries(ROUTE)) {
    const job = jobs[id];
    if (!job) continue;
    const extra = Object.keys(job).filter((k) => !JOB_KEYS.includes(k));
    if (extra.length) note(`a job carries ${extra.sort().join(", ")}`, id);
    const os = id.split("-")[0]!;
    const part = /-suite-(\d+)$/.exec(id)?.[1];
    const label = os === "linux" ? `ubuntu-${ubuntu}` : RUNNERS[os];
    if (job["runs-on"] !== label) note(`runs-on is ${String(job["runs-on"])}, not ${label}`, id);
    if (job["timeout-minutes"] !== 345) note("timeout-minutes is not 345", id);
    if (!same(job.defaults, { run: { shell: "bash" } })) note("defaults.run is not shell: bash alone", id);
    const steps = (job.steps ?? []) as Step[];
    const got = steps.map(labelOf);
    if (!same(got, want)) {
      out.push(`${id}: the steps are [${got.join(" | ")}], not the route [${want.join(" | ")}]`);
      continue;
    }
    steps.forEach((s, k) => {
      const keys = Object.keys(s).sort().join(",");
      const kind = want[k]!;
      if (kind === "checkout") {
        if (keys !== "uses,with" || !same(s.with, { "fetch-depth": 0, "persist-credentials": false })) note("checkout is not exactly fetch-depth: 0 and persist-credentials: false", id);
      } else if (kind === "setup-node") {
        if (keys !== "uses,with" || !same(s.with, { "node-version": node })) note(`setup-node is not exactly node-version ${node}, the Node CONTRIBUTING.md says CI runs`, id);
      } else if (kind === "Toolchain") {
        if (keys !== "name,run" || s.run !== toolchain) note("the Toolchain step is not build.yml's linux Toolchain step byte for byte", id);
      } else {
        const b = byLabel.get(kind);
        if (!b) return;
        const isPart = part !== undefined && kind === suiteOf(os);
        const bad = Object.keys(s).filter((key) => !["name", "run", "working-directory", ...(isPart ? ["env"] : [])].includes(key));
        if (bad.length) note(`${kind}: the step carries ${bad.sort().join(", ")}`, id);
        if (isPart) {
          const env = Object.fromEntries(Object.entries((s.env ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
          if (!same(env, { PART: part, PARTS: String(PARTS[os]) })) note(`${kind}: env is ${JSON.stringify(s.env ?? null)}, not PART ${part} of PARTS ${PARTS[os]}`, id);
        }
        if ((s["working-directory"] ?? null) !== b.dir) note(`${kind}: working-directory is ${String(s["working-directory"] ?? "none")}, the marker says ${b.dir ?? "none"}`, id);
        if (typeof s.run !== "string" || !same(commandsOf(s.run), b.commands)) note(`${kind}: the run is not the block at ${b.doc}:${b.line}`, id);
      }
    });
  }
  for (const [what, ids] of where) out.push(`${what} (${ids.join(", ")})`);

  // The blocks themselves.
  for (const label of routed) {
    if (["checkout", "setup-node", "Toolchain"].includes(label) || byLabel.has(label)) continue;
    out.push(`${label}: the route runs it and ${label.split(" · ")[0]} marks no such block`);
  }
  for (const b of blocks) {
    if (!routed.has(b.label)) out.push(`${b.doc}:${b.line}: the marked block ${b.id} is run by no job`);
    if (!parses(b.text)) out.push(`${b.doc}:${b.line}: bash -n refuses the block ${b.id}`);
  }
  for (const label of new Set(Object.keys(PARTS).map(suiteOf))) {
    const b = byLabel.get(label);
    if (b && b.commands[0] !== PART_DEFAULT) out.push(`${label}: the block does not open with ${PART_DEFAULT}`);
  }
  const services = byLabel.get("CONTRIBUTING.md · suite-services");
  if (services) {
    const seq = /\bseq \$\(\(PART - 1\)\) "\$PARTS" (\d+)\b/.exec(services.text)?.[1];
    if (Number(seq) !== SHARDS - 1) out.push(`suite-services runs shards 0 to ${seq ?? "?"}, the map holds ${SHARDS}`);
    const mine = ALONE_GREP.exec(services.text)?.[1];
    const ci = ALONE_GREP.exec(inputs.ci)?.[1];
    if (!mine || mine !== ci) out.push(`suite-services greps the alone files in ${mine ?? "nothing"}, ci.yml's plan in ${ci ?? "nothing"}`);
  }
  const install = byLabel.get("CONTRIBUTING.md · install");
  if (install && !same(blockUnder(inputs.claude, "## Setting it up"), install.commands)) out.push("CLAUDE.md's setup block is not CONTRIBUTING.md's install block");
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const WORKFLOW = publicPath("github/workflows/contributor.yml");
function real(): Inputs {
  let contributor = "";
  try {
    contributor = readFileSync(WORKFLOW, "utf8");
  } catch {
    contributor = "";
  }
  return {
    contributor,
    docs: Object.fromEntries(DOCS.map((d) => [d, read(d)])),
    build: readFileSync(publicPath("github/workflows/build.yml"), "utf8"),
    ci: readFileSync(publicPath("github/workflows/ci.yml"), "utf8"),
    claude: read("CLAUDE.md"),
  };
}

describe("contributor.yml runs the documents' marked blocks, and nothing else", () => {
  it("the real files: every marked block is a step, every step is a block, and the job holds the shape", () => {
    const inputs = real();
    expect(inputs.contributor, "contributor.yml is missing").not.toBe("");
    expect(markedBlocks(inputs.docs).blocks.length, "the reader found too few marked blocks").toBe(8);
    expect(routeFindings(inputs)).toEqual([]);
  });

  it("commandsOf drops comments outside quotes and joins continuations", () => {
    expect(commandsOf("  a \\\n    b   # c\n\n  echo '# kept' \"# kept\" x#y\n")).toEqual(["a b", "echo '# kept' \"# kept\" x#y"]);
  });

  describe("each plant reads as exactly one finding", () => {
    const base = real();
    const wf = () => yaml.load(base.contributor) as Workflow;
    const steps = (w: Workflow, job: string) => w.jobs![job]!.steps as Step[];
    const step = (w: Workflow, job: string, label: string) => steps(w, job).find((s) => labelOf(s) === label)!;
    const withWf = (w: Workflow): Inputs => ({ ...base, contributor: yaml.dump(w) });
    const withDoc = (doc: string, from: string, to: string): Inputs => {
      expect(base.docs[doc], `${doc} carries the text the plant replaces`).toContain(from);
      return { ...base, docs: { ...base.docs, [doc]: base.docs[doc]!.replace(from, to) } };
    };

    it("the positive control: the real files re-dumped read clean", () => {
      expect(routeFindings(withWf(wf()))).toEqual([]);
    });

    const plants: Array<[string, () => Inputs, RegExp]> = [
      ["a block edited: --ignore-scripts dropped", () => withDoc("docs/install.md", "cd apps/desktop\nnpm ci --ignore-scripts", "cd apps/desktop\nnpm ci"), /docs\/install\.md · interface: the run is not the block .*\(linux-build, macos-build, windows-build\)$/],
      ["a command appended to a step", () => {
        const w = wf();
        const s = step(w, "windows-suite-3", "CONTRIBUTING.md · install");
        s.run = `${String(s.run)}echo more\n`;
        return withWf(w);
      }, /^CONTRIBUTING\.md · install: the run is not the block .*\(windows-suite-3\)$/],
      ["two steps swapped", () => {
        const w = wf();
        const s = steps(w, "linux-build");
        [s[4], s[5]] = [s[5]!, s[4]!];
        return withWf(w);
      }, /^linux-build: the steps are/],
      ["an extra step", () => {
        const w = wf();
        steps(w, "macos-build").push({ name: "extra", run: "echo extra\n" });
        return withWf(w);
      }, /^macos-build: the steps are/],
      ["env on a document step", () => {
        const w = wf();
        step(w, "linux-build", "docs/install.md · engine").env = { X: "1" };
        return withWf(w);
      }, /^docs\/install\.md · engine: the step carries env \(linux-build\)$/],
      ["if on a document step", () => {
        const w = wf();
        step(w, "macos-suite-1", "CONTRIBUTING.md · suite").if = "always()";
        return withWf(w);
      }, /^CONTRIBUTING\.md · suite: the step carries if \(macos-suite-1\)$/],
      ["a part's env naming another part", () => {
        const w = wf();
        step(w, "windows-suite-2", "CONTRIBUTING.md · suite").env = { PART: "1", PARTS: "4" };
        return withWf(w);
      }, /^CONTRIBUTING\.md · suite: env is .*, not PART 2 of PARTS 4 \(windows-suite-2\)$/],
      ["a part's env missing", () => {
        const w = wf();
        delete step(w, "linux-suite-2", "CONTRIBUTING.md · suite-services").env;
        return withWf(w);
      }, /^CONTRIBUTING\.md · suite-services: env is null, not PART 2 of PARTS 2 \(linux-suite-2\)$/],
      ["env on install in a part", () => {
        const w = wf();
        step(w, "macos-suite-2", "CONTRIBUTING.md · install").env = { PART: "2", PARTS: "2" };
        return withWf(w);
      }, /^CONTRIBUTING\.md · install: the step carries env \(macos-suite-2\)$/],
      ["a part's job missing", () => {
        const w = wf();
        delete w.jobs!["windows-suite-4"];
        return withWf(w);
      }, /^the jobs are .*, not .*windows-suite-4/],
      ["a suite block that does not default its part", () => {
        const w = wf();
        for (const id of ["macos-suite-1", "macos-suite-2", "windows-suite-1", "windows-suite-2", "windows-suite-3", "windows-suite-4"]) {
          const s = step(w, id, "CONTRIBUTING.md · suite");
          s.run = String(s.run).split("\n").slice(1).join("\n");
        }
        const planted = withWf(w);
        const doc = base.docs["CONTRIBUTING.md"]!;
        const at = doc.indexOf(PART_DEFAULT, doc.indexOf("contributor.yml: suite -->"));
        return { ...planted, docs: { ...base.docs, "CONTRIBUTING.md": doc.slice(0, at) + doc.slice(doc.indexOf("\n", at) + 1) } };
      }, /^CONTRIBUTING\.md · suite: the block does not open with/],
      ["a marker removed", () => withDoc("CONTRIBUTING.md", "<!-- run by .github/workflows/contributor.yml: suite -->\n", ""), /^CONTRIBUTING\.md · suite: the route runs it and CONTRIBUTING\.md marks no such block$/],
      ["a marked block no job runs", () => withDoc("CONTRIBUTING.md", "\n## Sign your commits", "\n<!-- run by .github/workflows/contributor.yml: stray -->\n```bash\necho stray\n```\n\n## Sign your commits"), /the marked block stray is run by no job$/],
      ["setup-node differing from CONTRIBUTING's version", () => withDoc("CONTRIBUTING.md", "(CI runs 22.23.4)", "(CI runs 22.23.5)"), /^setup-node is not exactly node-version 22\.23\.5.*\(linux-build, linux-suite-1, .*, windows-suite-4\)$/],
      ["a secrets. read", () => ({ ...base, contributor: base.contributor.replace(/^name: (.*)$/m, "name: $1 ${{ secrets.TOKEN }}") }), /^contributor\.yml:\d+: reads name: .*secrets\.TOKEN/],
      ["persist-credentials missing", () => {
        const w = wf();
        steps(w, "linux-suite-1")[0]!.with = { "fetch-depth": 0 };
        return withWf(w);
      }, /^checkout is not exactly .*\(linux-suite-1\)$/],
      ["a pull_request trigger", () => {
        const w = wf();
        (w.on as Record<string, unknown>).pull_request = null;
        return withWf(w);
      }, /^the triggers are pull_request, schedule, workflow_dispatch/],
      ["the Linux label differing from docs/install.md's Ubuntu", () => withDoc("docs/install.md", "on Ubuntu\n24.04:", "on Ubuntu\n26.04:"), /^runs-on is ubuntu-24\.04, not ubuntu-26\.04 \(linux-build, linux-suite-1, linux-suite-2\)$/],
      ["shards to 14, in the block and the steps alike", () => {
        const w = wf();
        const to = (t: string) => t.replace('"$PARTS" 15', '"$PARTS" 14');
        for (const id of ["linux-suite-1", "linux-suite-2"]) {
          const s = step(w, id, "CONTRIBUTING.md · suite-services");
          s.run = to(String(s.run));
        }
        const planted = withWf(w);
        return { ...planted, docs: withDoc("CONTRIBUTING.md", '"$PARTS" 15', '"$PARTS" 14').docs };
      }, /^suite-services runs shards 0 to 14, the map holds 16$/],
    ];

    it.each(plants)("%s", (_what, plant, want) => {
      const got = routeFindings(plant());
      expect(got, got.join("\n")).toHaveLength(1);
      expect(got[0]).toMatch(want);
    });

    it("a comment naming secrets. is no read", () => {
      expect(routeFindings({ ...base, contributor: `${base.contributor}# secrets.X and vars.Y in a comment\n` })).toEqual([]);
    });
  });
});
