// The tree as tools/old-tests.tsv is read against it: which test files are in scope, their cases by name, what is
// mounted, what each host's entry reaches, and what a kept test still runs of today's shell.
import path from "node:path";
import { readMounted } from "./mounted.mjs";
import { hostEntries, isUiPart, makeGraph, makeResolver } from "./reach.mjs";
import { readSource } from "./source-text.mjs";
import { casesOf, isOldTestFile } from "./test-cases.mjs";

const SHELL = "apps/webapp/app/shell/";
const VIEWS = "apps/webapp/app/views/";
const isHelper = (rel) => /(^|\/)test\//.test(rel) && !isOldTestFile(rel) && /\.[cm]?[jt]sx?$/.test(rel);
/**
 * The ruling's scope by its words: a file that names today's shell or its views, comments aside: by a path, or by
 * the path's two segments handed to a join (`join(app, "app", "views")`). A test is in scope too when its imports by
 * value reach, through any module, a file that leaves with the switch.
 */
const NAMES_TODAYS = /\bapp\/(shell|views)(?=[/"'`]|$)|["'`]app["'`]\s*,\s*["'`](shell|views)["'`]/m;
/**
 * What leaves with the switch's deletions: every view of today's, today's composition and its feeds, and the first
 * run's old files. A kept test runs none of it. Once the deletions have landed none of it is in the tree, and a view
 * that waits for its mount is caught by the reach of the hosts' entries instead.
 */
const SWITCH_DELETES = new Set([
  "AppShell.tsx",
  "reader-parts.tsx",
  "shell-derivations.ts",
  "shell-keys.tsx",
  "shell-open-state.ts",
  "shell-verbs.ts",
  "FirstRun.tsx",
  "decision-reopen.ts",
  "seed-offer.ts",
  "pull-rate.ts",
]);
export function leavesWithTheSwitch(rel) {
  if (rel.startsWith(VIEWS)) return true;
  if (!rel.startsWith(SHELL)) return false;
  const base = path.posix.basename(rel);
  return SWITCH_DELETES.has(base) || /^(Todays|todays-)/.test(base);
}

/**
 * @param {object} given
 * @param {string[]} given.files every file of the tree
 * @param {(rel: string) => string | null} given.textOf
 * @param {Record<string, object>} given.manifests every package.json under apps/ and packages/, by folder
 */
export function readOldTestsTree({ files, textOf, manifests }) {
  const present = new Set(files);
  const resolve = makeResolver(present, manifests);
  const graph = makeGraph(resolve, textOf);
  const names = new Map();
  const namesTodays = (rel) => {
    if (!names.has(rel)) names.set(rel, NAMES_TODAYS.test(readSource(textOf(rel) ?? "").bare));
    return names.get(rel);
  };
  const doors = new Map();
  const isDoor = (helper) => {
    if (!doors.has(helper)) {
      doors.set(helper, false); // a helper that imports itself in a circle is no door by that
      doors.set(helper, namesTodays(helper) || graph.edgesOf(helper).some((t) => isHelper(t) && isDoor(t)));
    }
    return doors.get(helper);
  };
  const tests = files.filter(isOldTestFile);
  const scope = new Set(
    tests.filter(
      (rel) =>
        namesTodays(rel) ||
        graph.edgesOf(rel).some((t) => isHelper(t) && isDoor(t)) ||
        [...graph.closure([rel])].some(leavesWithTheSwitch),
    ),
  );
  const cases = new Map();
  const read = (rel) => {
    if (!cases.has(rel)) {
      const all = casesOf(textOf(rel) ?? "");
      const standing = new Set(all.filter((c) => !c.idle).map((c) => c.name));
      const idle = new Map(all.filter((c) => c.idle && !standing.has(c.name)).map((c) => [c.name, c.idle]));
      cases.set(rel, { names: new Set(all.map((c) => c.name)), idle });
    }
    return cases.get(rel);
  };
  const casesIn = (rel) => (present.has(rel) ? read(rel).names : null);
  const idleIn = (rel) => (present.has(rel) ? read(rel).idle : null);
  let reached = null;
  const partOf = (rel) => {
    reached ??= graph.closure(hostEntries(files));
    const parts = new Set();
    const seen = new Set();
    const walk = (at) => {
      if (seen.has(at)) return;
      seen.add(at);
      for (const target of graph.edgesOf(at)) {
        if (isHelper(target)) walk(target);
        else if (isUiPart(target)) parts.add(target);
      }
    };
    walk(rel);
    const leaves = [...graph.closure([rel])].filter(leavesWithTheSwitch).sort();
    return { leaves, unreached: [...parts].filter((part) => !reached.has(part)).sort() };
  };
  const mounted = readMounted({ files, textOf });
  return {
    scope,
    tests,
    isTest: (rel) => present.has(rel) && isOldTestFile(rel),
    casesIn,
    idleIn,
    partOf,
    targets: mounted.targets,
    mounted: mounted.mounted,
    said: mounted.said,
    refusals: mounted.refusals,
  };
}
