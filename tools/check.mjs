#!/usr/bin/env node
// The one runner of the repository's tools: the linter with the import borders, the style linter,
// the formatter and the checks around the typed contracts. tools/README.md says how to use it.
//
//   node tools/check.mjs --base <rev>     everything, and the baseline against <rev>'s
//   node tools/check.mjs --controls       every rule refuses its planted violation, in a copy of HEAD
//   node tools/check.mjs --by-task        the baseline's counts per task
//   node tools/check.mjs --retirement [--base <rev>] | --references | --coverage   one part alone
//   node tools/check.mjs --list <rule>    every finding of one rule
//   node tools/check.mjs --format        format the new tree (npm run format)
//   node tools/check.mjs --write-baseline | --write-prettierignore
//   node tools/check.mjs --table <standard.md> [<twin.md>]
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareWithBase,
  compareWithTree,
  countFindings,
  parseBaseline,
  renderBaseline,
  rowRule,
  totals,
} from "./lib/baseline.mjs";
import { judgeControls, plant, ruleSlug, verdictOf } from "./lib/controls.mjs";
import {
  CONFIG_COMMENT_RULE,
  formatFiles,
  isSource,
  linterConfig,
  otherLinterConfigs,
  runEslint,
  runPrettier,
  runStylelint,
} from "./lib/findings.mjs";
import { inNewTree, parseNewTree, renderPrettierIgnore } from "./lib/new-tree.mjs";
import { checkReferences, explicitTypechecks } from "./lib/references.mjs";
import { checkRetirement, isSuiteTest, parseRetirement, readingTests } from "./lib/retirement.mjs";
import { checkTable } from "./lib/table.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (root, rel) => readFileSync(path.join(root, rel), "utf8");
const readIf = (root, rel) => (existsSync(path.join(root, rel)) ? read(root, rel) : null);
const say = (line) => process.stdout.write(`${line}\n`);

function args(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) throw new Error(`unknown argument ${argv[i]}`);
    const values = [];
    while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) values.push(argv[(i += 1)]);
    flags.set(argv[i - values.length].slice(2), values);
  }
  return flags;
}

const git = (root, ...command) =>
  execFileSync("git", command, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Every file of the tree that is tracked or new, and still on disk. */
function treeFiles(root) {
  const listed = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    .filter(Boolean);
  return listed.filter((rel) => existsSync(path.join(root, rel)));
}

/** The findings of the three tools over `files` (paths from the root). */
async function findingsOf(root, files, { concurrency } = {}) {
  const newTree = parseNewTree(readIf(root, "tools/new-tree.txt"));
  const bound = files.filter((rel) => inNewTree(rel, newTree) && !rel.startsWith("tools/plant/"));
  const absolute = (list) => list.map((rel) => path.join(root, rel));
  const [lint, style, format] = await Promise.all([
    runEslint(root, absolute(files.filter(isSource)), { concurrency }),
    runStylelint(root, absolute(bound.filter((rel) => rel.endsWith(".css")))),
    runPrettier(root, absolute(bound)),
  ]);
  return [...lint, ...style, ...format];
}

/** Every rule the configuration switches on, and the source files the border rule does not reach. */
async function coverage(root, files) {
  const { ESLint } = await import("eslint");
  const { default: stylelint } = await import("stylelint");
  const eslint = new ESLint({ cwd: root, overrideConfigFile: linterConfig(root) });
  const active = new Set(["prettier", "eslint:unused-directive", CONFIG_COMMENT_RULE]);
  const unreached = [];
  for (const rel of files.filter(isSource)) {
    const config = await eslint.calculateConfigForFile(path.join(root, rel));
    const on = Object.entries(config?.rules ?? {}).filter(([, setting]) =>
      [2, "error"].includes([setting].flat()[0]),
    );
    for (const [rule] of on) active.add(rule);
    if (!on.some(([rule]) => rule === "ohmail/package-borders")) unreached.push(rel);
  }
  for (const rel of files.filter((file) => file.endsWith(".css"))) {
    const resolved = await stylelint.resolveConfig(path.join(root, rel), {
      cwd: root,
      configFile: path.join(root, "stylelint.config.mjs"),
    });
    for (const [rule, setting] of Object.entries(resolved?.rules ?? {}))
      if (setting !== null) active.add(`stylelint:${rule}`);
  }
  return { active: [...active].sort(), unreached };
}

const unreachedRefusal = (rel) => `coverage: the border rule does not reach ${rel}`;

/** A door file names its platform, or it has no reason to be on the list. */
async function staleDoors(root) {
  const { doors, platforms = [] } = JSON.parse(read(root, "tools/doors.json"));
  const { ESLint } = await import("eslint");
  const everyFile = new ESLint({
    cwd: root,
    overrideConfigFile: linterConfig(root),
    overrideConfig: [
      {
        rules: {
          "ohmail/platform-name": ["error", { root, doors: ["no file is a door in this pass"], platforms }],
        },
      },
    ],
  });
  const refusals = [];
  for (const platform of platforms) {
    if (!platform.id || !(platform.packages?.length || platform.names?.length))
      refusals.push(`doors: the platform ${platform.id ?? "without an id"} names no package and no prefix`);
  }
  const known = new Set(platforms.map((platform) => platform.id));
  for (const door of doors) {
    if (!door.id || !door.platform || !door.reason || !door.files?.length)
      refusals.push(`doors: ${door.id ?? "a door"} needs an id, a platform, a reason and its files`);
    else if (!known.has(door.platform))
      refusals.push(
        `doors: ${door.id} is a door to ${door.platform}, which the list of platforms does not name`,
      );
    for (const entry of [...(door.files ?? []), ...(door.tests ?? [])]) {
      const target = path.join(root, entry.replace(/\/\*\*$/, ""));
      if (!existsSync(target)) {
        refusals.push(`doors: ${entry} (${door.id}) is not in the tree; a door that is gone leaves the list`);
        continue;
      }
      const results = await everyFile.lintFiles([
        entry.endsWith("/**") ? `${target}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` : target,
      ]);
      const named = results.some((result) =>
        [...result.messages, ...result.suppressedMessages].some(
          (message) => message.ruleId === "ohmail/platform-name",
        ),
      );
      if (!named) refusals.push(`doors: ${entry} (${door.id}) names no platform; it leaves the list`);
    }
  }
  return refusals;
}

function references(root) {
  const folders = ["apps", "packages"].flatMap((parent) =>
    readdirSync(path.join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  );
  const workflowDir = path.join(root, ".github/workflows");
  const rootManifest = JSON.parse(read(root, "package.json"));
  const manifests = Object.fromEntries(
    folders
      .filter((folder) => existsSync(path.join(root, folder, "package.json")))
      .map((folder) => [folder, JSON.parse(read(root, `${folder}/package.json`))]),
  );
  return checkReferences({
    folders: folders.filter((folder) => existsSync(path.join(root, folder, "tsconfig.json"))),
    references: JSON.parse(read(root, "tsconfig.json")).references.map((reference) => reference.path),
    explicit: explicitTypechecks({
      workflows: existsSync(workflowDir)
        ? readdirSync(workflowDir).map((name) => readFileSync(path.join(workflowDir, name), "utf8"))
        : [],
      rootScripts: rootManifest.scripts ?? {},
      manifests,
    }),
  });
}

function retirement(root, files, base) {
  const { rows, refusals } = parseRetirement(read(root, "tools/retirement.tsv"));
  const tests = files.filter(isSuiteTest);
  const tracked = new Set(files);
  const texts = new Map();
  const textOf = (rel) => {
    if (!tracked.has(rel)) return null;
    if (!texts.has(rel)) texts.set(rel, read(root, rel));
    return texts.get(rel);
  };
  const deleted = base
    ? git(root, "diff", "--name-only", "--diff-filter=D", "-M", base, "HEAD").split("\n").filter(isSuiteTest)
    : [];
  return [
    ...refusals,
    ...checkRetirement({
      rows,
      reading: readingTests({ tests, textOf }),
      present: new Set(tests),
      deleted,
      verdictExists: (rel) => existsSync(path.join(root, rel)),
    }),
  ];
}

function baseBaseline(root, base) {
  try {
    return parseBaseline(git(root, "show", `${base}:tools/baseline.tsv`)).rows;
  } catch {
    git(root, "rev-parse", "--verify", `${base}^{commit}`); // an unknown revision is an error, not a pass
    return null; // the base is older than the tools: there is nothing yet to grow against
  }
}

async function everything(root, flags) {
  const base = flags.get("base")?.[0];
  if (process.env.CI === "true" && !base)
    throw new Error("in CI the baseline is read against a base: pass --base <rev>");
  const files = treeFiles(root);
  const newTree = parseNewTree(readIf(root, "tools/new-tree.txt"));
  const concurrency = Math.min(4, os.availableParallelism());
  const [findings, covered, doors] = await Promise.all([
    findingsOf(root, files, { concurrency }),
    coverage(root, files),
    staleDoors(root),
  ]);
  const baseline = parseBaseline(read(root, "tools/baseline.tsv"));

  const refusals = [...baseline.refusals, ...compareWithTree(baseline.rows, findings), ...doors];
  refusals.push(...otherLinterConfigs(readdirSync(root)));
  refusals.push(...covered.unreached.map(unreachedRefusal));
  if (readIf(root, ".prettierignore") !== renderPrettierIgnore(newTree)) {
    refusals.push(
      "format: .prettierignore is not what tools/new-tree.txt renders; run node tools/check.mjs --write-prettierignore",
    );
  }
  refusals.push(...references(root), ...retirement(root, files, base));
  // "Checked by a tool" is said of a rule only with the record of its planted violation.
  const planted = JSON.parse(read(root, "tools/plant/controls.json")).filter((c) => c.expect === "refused");
  for (const rule of new Set(planted.flatMap((control) => control.rule))) {
    const verdict = `docs/tool-verdicts/${ruleSlug(rule)}.json`;
    if (!existsSync(path.join(root, verdict))) refusals.push(`controls: ${rule} has no record at ${verdict}`);
  }
  if (base) {
    const before = baseBaseline(root, base);
    if (before) refusals.push(...compareWithBase(baseline.rows, before));
    else say(`baseline: ${base} has no tools/baseline.tsv; nothing to grow against`);
  }

  say(`rules active: ${covered.active.length} (${covered.active.join(", ")})`);
  say(
    `files: ${files.filter(isSource).length} linted, ${files.filter((rel) => inNewTree(rel, newTree)).length} in the new tree`,
  );
  say(
    `baseline: ${baseline.rows.length} rows, ${[...countFindings(findings).values()].reduce((a, b) => a + b, 0)} findings`,
  );
  say(
    `  by rule: ${totals(baseline.rows, "rule")
      .map(([rule, count]) => `${rule} ${count}`)
      .join(", ")}`,
  );
  say(
    `  by task: ${totals(baseline.rows, "task")
      .map(([task, count]) => `${task} ${count}`)
      .join(", ")}`,
  );
  say(`retirement: ${parseRetirement(read(root, "tools/retirement.tsv")).rows.length} rows`);
  return refusals;
}

/** The planted violations, in a copy of HEAD: the tree itself is never planted in. */
async function controls(root, flags) {
  const controlsFile = JSON.parse(read(root, "tools/plant/controls.json"));
  const copy = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "ohmail-controls-"));
  const link = path.join(copy, "node_modules");
  try {
    execFileSync("sh", ["-c", 'git archive HEAD | tar -x -C "$1"', "sh", copy], { cwd: root });
    symlinkSync(path.join(root, "node_modules"), link);
    plant(copy, controlsFile);
    const planted = controlsFile.map((control) => control.plant);
    const findings = await findingsOf(copy, planted);
    const unreached = references(copy).map((refusal) => ({
      path: `${/references: (\S+)/.exec(refusal)[1]}/tsconfig.json`,
      rule: "references",
      message: refusal,
    }));
    // Every rule that binds any listed folder needs its control, also where no file was planted.
    const probes = parseNewTree(readIf(copy, "tools/new-tree.txt"))
      .filter((entry) => !path.extname(entry))
      .flatMap((entry) =>
        ["src/probe.ts", "src/probe.tsx", "test/probe.test.ts", "src/probe.css"].map(
          (leaf) => `${entry}/${leaf}`,
        ),
      );
    const { active } = await coverage(copy, [...planted, ...probes]);
    const judged = judgeControls(controlsFile, [...findings, ...unreached], [...active, "references"]);
    const rules = [...new Set(judged.records.map((record) => record.rule))].sort();
    if (flags.has("verbose")) {
      for (const r of judged.records) {
        const what =
          r.outcome === "refused"
            ? `RED\t${r.rule}\t${r.plant}:${r.line ?? 1}\t${r.message ?? ""}`
            : `GREEN\t${r.rule}\t${r.plant}\t`;
        say(`${what}\t(${r.id})`);
      }
    }
    if (flags.has("write-verdicts") && judged.refusals.length === 0) {
      const about = { base: flags.get("write-verdicts")[0], recorded: new Date().toISOString().slice(0, 10) };
      mkdirSync(path.join(root, "docs/tool-verdicts"), { recursive: true });
      for (const rule of rules) {
        const file = path.join(root, "docs/tool-verdicts", `${ruleSlug(rule)}.json`);
        writeFileSync(file, JSON.stringify(verdictOf(rule, judged.records, about), null, 2) + "\n");
      }
    }
    const count = (outcome) => judged.records.filter((record) => record.outcome === outcome).length;
    say(
      `controls: ${rules.length} rules, ${count("refused")} planted violations refused as expected, ${count("passed")} clean readings passed as expected`,
    );
    return judged.refusals;
  } finally {
    if (existsSync(link)) unlinkSync(link);
    rmSync(copy, { recursive: true, force: true });
  }
}

async function main() {
  const flags = args(process.argv.slice(2));
  const root = flags.get("root")?.[0] ? path.resolve(flags.get("root")[0]) : ROOT;
  if (flags.has("controls")) return controls(root, flags);
  if (flags.has("table")) {
    const [standard, twin] = flags.get("table");
    return checkTable(
      JSON.parse(read(root, "tools/borders.json")),
      readFileSync(standard, "utf8"),
      twin && readFileSync(twin, "utf8"),
    );
  }
  if (flags.has("retirement")) return retirement(root, treeFiles(root), flags.get("base")?.[0]);
  if (flags.has("references")) return references(root);
  if (flags.has("coverage")) {
    const { active, unreached } = await coverage(root, treeFiles(root));
    say(`rules active: ${active.length} (${active.join(", ")})`);
    return unreached.map(unreachedRefusal);
  }
  if (flags.has("write-prettierignore")) {
    writeFileSync(
      path.join(root, ".prettierignore"),
      renderPrettierIgnore(parseNewTree(readIf(root, "tools/new-tree.txt"))),
    );
    return [];
  }
  if (flags.has("format")) {
    // The old files of a listed folder wait for their rewrite: a row of the baseline keeps them as they are.
    const waiting = new Set(
      parseBaseline(read(root, "tools/baseline.tsv"))
        .rows.filter((row) => row.rule === "prettier")
        .map((row) => row.path),
    );
    const newTree = parseNewTree(readIf(root, "tools/new-tree.txt"));
    const bound = treeFiles(root).filter(
      (rel) => inNewTree(rel, newTree) && !rel.startsWith("tools/plant/") && !waiting.has(rel),
    );
    for (const rel of await formatFiles(
      root,
      bound.map((rel) => path.join(root, rel)),
    ))
      say(`formatted ${rel}`);
    return [];
  }
  if (flags.has("by-task")) {
    const { rows } = parseBaseline(read(root, "tools/baseline.tsv"));
    for (const [task, count] of totals(rows, "task"))
      say(`${task}\t${count}\t${rows.filter((row) => row.task === task).length} rows`);
    return [];
  }
  if (flags.has("list") || flags.has("write-baseline")) {
    const findings = await findingsOf(root, treeFiles(root), {
      concurrency: Math.min(4, os.availableParallelism()),
    });
    if (flags.has("list")) {
      const wanted = flags.get("list")[0];
      for (const f of findings.filter((f) => !wanted || f.rule === wanted || rowRule(f) === wanted))
        say(`${f.path}:${f.line}\t${rowRule(f)}\t${f.message}`);
      return [];
    }
    // Counts follow the tree; a row keeps its task, and a new row has none until a person names it.
    const known = new Map(
      parseBaseline(readIf(root, "tools/baseline.tsv") ?? "").rows.map((row) => [
        `${row.path}\t${row.rule}`,
        row.task,
      ]),
    );
    const rows = [...countFindings(findings)].map(([key, count]) => {
      const [file, rule] = key.split("\t");
      return { path: file, rule, count, task: known.get(key) ?? flags.get("write-baseline")[0] ?? "" };
    });
    writeFileSync(path.join(root, "tools/baseline.tsv"), renderBaseline(rows));
    say(`baseline: ${rows.length} rows written`);
    return [];
  }
  return everything(root, flags);
}

main().then(
  (refusals) => {
    for (const refusal of refusals) process.stderr.write(`REFUSED ${refusal}\n`);
    say(refusals.length ? `check: ${refusals.length} refused` : "check: 0 refused");
    process.exit(refusals.length ? 1 : 0);
  },
  (error) => {
    process.stderr.write(`check: ${error.message}\n`);
    process.exit(2);
  },
);
