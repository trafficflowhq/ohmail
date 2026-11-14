// tools/old-tests.tsv and tools/never-red.tsv: the older tests of today's shell, sorted ONCE (the ruling
// RULING-NEW-SHELL-FIRST, section D), and the cases that are never left red (its E1). One row a test file; one
// row a case where a file's cases differ. A row says what the file or case is (its class), who holds it at the
// new shell (its holder), which share of the census sorted it, and where it stands (its state). The rules here
// read the rows against a tree the caller has read; tools/lib/old-tests-tree.mjs reads it.
import { isOldTestFile, SEP, splitKey } from "./test-cases.mjs";

export const OLD_TESTS_HEADER = "file\tclass\tholder\tshare\tstate";
export const NEVER_RED_HEADER = "test\tact\tplace\tholder\tstates";
/** D's classes 1 to 4: a behaviour a person meets, an old view's markup alone, a census over source, a gap. */
export const CLASSES = ["behaviour", "markup", "census", "gap"];
/** What a never-red case guards (D, point b; E1). */
export const ACTS = ["FILE", "TRASH", "UNDO", "SEND", "UNSENT", "PICTURES", "SIGNIN", "SCOPE"];
/**
 * The switch's commits by their names, in their order: a holder until the switch lands. The contract; the tests
 * written red first; the Ohbox's own seat; the reader's parts; Write and the reply; the feeders (keys, notices, the
 * boot duties); the way out (Settings' Account pane); the hosts' entries handing the new shell; the deletions; the
 * rows of the files whose subject left.
 */
export const SWITCH = [
  "switch-contract",
  "switch-tests",
  "switch-ohbox",
  "switch-reader",
  "switch-write",
  "switch-feeders",
  "switch-way-out",
  "switch-entries",
  "switch-deletions",
  "switch-rows",
];
/** What the switch mounts: the Ohbox, the reader, Write, Settings' Account pane, the first run, the ground. */
const SWITCH_HOLDS = ["ohbox", "reader", "write", "settings", "pane:account", "stage:firstRun", "ground"];
/** Each mount by its name, and what it mounts ("pane:*" any pane of Settings). */
export const MOUNTS = {
  "mount-first-run": ["stage:firstRun", "pane:mailboxes"],
  "mount-drafts": ["drafts"],
  "mount-screener": ["screener"],
  "mount-search": ["search"],
  "mount-streams": ["news", "receipts", "later", "parked", "resurface"],
  "mount-lists": ["history", "tags", "folder", "address"],
  "mount-trash": ["trash"],
  "mount-settings": ["settings", "pane:*"],
  "host-panes": ["pane:*"],
  "mount-calendar": ["calendar", "reader:invitation"],
};
/** Who may own a gap: a mount, the switch (or one of its commits), the kit, or the dispatcher for a product decision. */
export const OWNERS = [...Object.keys(MOUNTS), ...SWITCH, "switch", "kit", "dispatcher"];

const holdsTarget = (holder, target) => {
  const holds = SWITCH.includes(holder) ? SWITCH_HOLDS : MOUNTS[holder];
  return Boolean(holds?.some((t) => t === target || (t === "pane:*" && target.startsWith("pane:"))));
};

/**
 * A waiting row's holder: the mount (or the switch's commit) that will hold it, alone or followed by ": " and what
 * it is handed in one line (a ruled answer: kept, re-pointed, or what it retires with and what holds it then).
 */
export function readHolder(cell) {
  const at = cell.indexOf(": ");
  return at < 0 ? { mount: cell, said: null } : { mount: cell.slice(0, at), said: cell.slice(at + 2) };
}

/** `WAITS:<target>`, `GAP:<owner>`, `KEPT`, `RETIRED`: the state's word and what follows its colon. */
export function readState(cell) {
  const colon = cell.indexOf(":");
  return colon < 0 ? { word: cell, what: "" } : { word: cell.slice(0, colon), what: cell.slice(colon + 1) };
}

function rowsOf(text, header, columns, name) {
  const refusals = [];
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines[0] !== header) refusals.push(`${name}: the first line is not "${header.replaceAll("\t", " ")}"`);
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    if (cells.length !== columns.length)
      refusals.push(`${name}: ${cells[0]}: a row has ${columns.length} columns`);
    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ""]));
  });
  return { rows, refusals };
}

export function parseOldTests(text) {
  const { rows, refusals } = rowsOf(
    text,
    OLD_TESTS_HEADER,
    ["file", "class", "holder", "share", "state"],
    "old tests",
  );
  if (rows.some((row, i) => i > 0 && rows[i - 1].file >= row.file))
    refusals.push("old tests: the rows are not sorted by file and case, each once");
  return { rows, refusals };
}

export function parseNeverRed(text) {
  const columns = ["test", "act", "place", "holder", "states"];
  const { rows, refusals } = rowsOf(text, NEVER_RED_HEADER, columns, "never red");
  const key = (row) => `${row.test}\t${row.states}`;
  if (rows.some((row, i) => i > 0 && key(rows[i - 1]) >= key(row)))
    refusals.push("never red: the rows are not sorted by test and then by what they state, each once");
  return { rows, refusals };
}

/**
 * Where a test file and case stand: `<test>` or `<test>#<case>`. Null when it holds; else why not.
 * @param {string} cell
 * A case written to be skipped, left to do or expected to fail holds nothing.
 * @param {{ isTest: (rel: string) => boolean, casesIn: (rel: string) => Set<string> | null,
 *   idleIn?: (rel: string) => Map<string, string> | null }} tree
 * @param {{ needsCase?: boolean }} [how]
 */
export function holderFault(cell, tree, how = {}) {
  const { path, name } = splitKey(cell);
  if (!tree.isTest(path)) return `${path} is not a test file in the tree`;
  if (name === null) return how.needsCase ? `${cell} names no case: write <test>#<case>` : null;
  if (!tree.casesIn(path)?.has(name)) return `${path} holds no case "${name}"`;
  const idle = tree.idleIn?.(path)?.get(name);
  return idle ? `${path} holds "${name}" only as ${idle}: no case that stands` : null;
}

/** The shape of one row: its class, share and state, and the holder its state asks for. */
function shapeFaults(row, given) {
  const faults = [];
  const { word, what } = readState(row.state);
  if (!CLASSES.includes(row.class))
    faults.push(`the class "${row.class}" is not one of ${CLASSES.join(", ")}`);
  if (!/^\d{2}$/.test(row.share))
    faults.push(`the share "${row.share}" is not the census's share by its two digits`);
  if (word === "WAITS" && !given.targets.has(what))
    faults.push(
      `WAITS:${what} names no place, pane:<id>, stage:<id>, reader, reader:invitation, ground or calendar`,
    );
  else if (word === "GAP" && !OWNERS.includes(what))
    faults.push(`GAP:${what} names no owner: a mount, the switch or one of its commits, kit, or dispatcher`);
  else if (
    !["WAITS", "GAP", "KEPT", "RETIRED"].includes(word) ||
    (["KEPT", "RETIRED"].includes(word) && what)
  )
    faults.push(`the state "${row.state}" is none of KEPT, RETIRED, WAITS:<place>, GAP:<owner>`);
  if ((row.class === "gap") !== (word === "GAP"))
    faults.push("a gap's row is GAP:<owner>, and a GAP row is of the class gap");
  if (row.class === "markup" && !["WAITS", "RETIRED"].includes(word))
    faults.push("markup leaves with its view: WAITS until its mount, then RETIRED, never KEPT");
  if (word === "WAITS") {
    const { mount, said } = readHolder(row.holder);
    if (!holdsTarget(mount, what))
      faults.push(`the holder "${row.holder}" is no mount nor a commit of the switch that mounts ${what}`);
    else if (said !== null && !said.trim())
      faults.push(
        `the holder "${row.holder}" says nothing after its mount: write the mount alone, or what it is handed`,
      );
  }
  if (word === "GAP" && !row.holder.trim())
    faults.push("a GAP row says in its holder, in one line, what is missing");
  // A behaviour or a look a named ruling dropped, replaced by nothing: the ruling holds it, and no case can.
  const dropped = word === "WAITS" || word === "RETIRED" ? droppedOf(row.holder) : null;
  if (dropped && row.class === "census")
    faults.push(
      `the holder "${row.holder}": a ruling drops a behaviour or a look, never a census: its subject moves, or the census is said void`,
    );
  else if (dropped && !dropped.named)
    faults.push(`the holder "${row.holder}": the word after "dropped:" is no ruling's name`);
  if (word === "KEPT" || (word === "RETIRED" && !dropped?.whole)) {
    const fault = holderFault(row.holder, given, { needsCase: word === "RETIRED" });
    if (fault) faults.push(`its holder: ${fault}`);
  }
  return faults;
}

/**
 * @param {object} given
 * @param {{ file: string, class: string, holder: string, share: string, state: string }[]} given.rows
 * @param {{ test: string, act: string, place: string, holder: string, states: string }[]} given.neverRed
 * @param {Set<string>} given.scope the test files in scope, read from the tree
 * @param {(rel: string) => boolean} given.isTest a test file of the tree
 * @param {(rel: string) => Set<string> | null} given.casesIn a test file's cases by name, null where it is gone
 * @param {Set<string>} given.targets every place, pane and stage a row may name
 * @param {Set<string>} given.mounted what a host's entry mounts
 * @param {(rel: string) => { leaves: string[], unreached: string[] }} given.partOf what a test runs that leaves with
 *   the switch, and the parts it imports that no host's entry reaches
 * @param {Map<string, string>} given.retired tools/retirement.tsv: a file and its proof
 * @param {(rel: string) => boolean} given.isSuiteTest
 */
export function checkOldTests(given) {
  const refusals = [];
  const byPath = new Map();
  for (const row of given.rows) {
    const { path } = splitKey(row.file);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(row);
  }
  for (const row of given.rows) {
    const at = `old tests: ${row.file}`;
    for (const fault of shapeFaults(row, given)) refusals.push(`${at}: ${fault}`);
    refusals.push(...rowRules(row, at, given));
  }
  for (const [path, rows] of byPath) refusals.push(...fileRules(path, rows, given));
  for (const file of [...given.scope].sort()) {
    if (!byPath.has(file))
      refusals.push(
        `old tests: ${file} is in scope (it names today's shell or mounts through its test doors) and has no row: add its row to tools/old-tests.tsv (tools/README.md, "The older tests")`,
      );
  }
  refusals.push(...neverRedRules(given, byPath));
  return refusals;
}

/** A row against the tree: a deleted file's row, a WAITS for what is mounted, a KEPT over what leaves. */
function rowRules(row, at, given) {
  const refusals = [];
  const { path, name } = splitKey(row.file);
  const { word, what } = readState(row.state);
  const cases = given.casesIn(path);
  if (!isOldTestFile(path)) refusals.push(`${at}: ${path} is not the name of a test file`);
  if (cases === null && word !== "RETIRED")
    refusals.push(`${at}: the file is not in the tree, so its row is RETIRED and names its holder`);
  if (cases === null && name === null && given.isSuiteTest(path) && !given.retired.get(path))
    refusals.push(`${at}: a deleted test leaves by its row in tools/retirement.tsv, with its proof`);
  if (cases !== null && word === "RETIRED" && (name === null || cases.has(name)))
    refusals.push(`${at}: it is still in the tree; it is RETIRED in the pull request that takes it out`);
  if (cases !== null && name !== null && word !== "RETIRED" && !cases.has(name))
    refusals.push(
      `${at}: ${path} holds no case of that name (the case's titles as written, joined by "${SEP}")`,
    );
  if (word === "WAITS" && given.mounted.has(what))
    refusals.push(
      `${at}: WAITS for ${what}, which a host's entry mounts: re-point it and keep it green, or a GAP with its owner`,
    );
  if (word === "KEPT" && cases !== null) {
    const { leaves, unreached } = given.partOf(path);
    if (leaves.length)
      refusals.push(
        `${at}: KEPT over today's shell (${leaves.slice(0, 3).join(", ")}): it WAITS for the mount that re-points it`,
      );
    if (unreached.length)
      refusals.push(
        `${at}: KEPT over a part no host's entry reaches (${unreached.slice(0, 3).join(", ")}): it WAITS`,
      );
  }
  return refusals;
}

/** A file is one row, or one row a case and then every case; never both. */
function fileRules(path, rows, given) {
  const at = `old tests: ${path}`;
  const whole = rows.filter((row) => splitKey(row.file).name === null);
  const byCase = rows.filter((row) => splitKey(row.file).name !== null);
  if (whole.length && byCase.length) return [`${at}: a file is one row, or one row a case; it has both`];
  const cases = given.casesIn(path);
  if (!byCase.length || cases === null) return [];
  const named = new Set(byCase.map((row) => splitKey(row.file).name));
  const missing = [...cases].filter((name) => !named.has(name));
  return missing.length
    ? [`${at}: it is sorted case by case and ${missing.length} of its cases have no row: "${missing[0]}"`]
    : [];
}

const DROPPED = "dropped: ";
/**
 * A holder that names the ruling which dropped its behaviour with nothing in its place: `dropped: <ruling>`, the
 * whole cell or its last part after ": ". Null when the cell has no such part; else the ruling's name as written,
 * whether it is one (a capital, then letters, digits, `_` or `-`), and whether the form is the whole cell.
 */
export function droppedOf(cell) {
  const at = cell.lastIndexOf(DROPPED);
  if (at < 0 || (at > 0 && cell.slice(at - 2, at) !== ": ")) return null;
  const ruling = cell.slice(at + DROPPED.length);
  return { ruling, named: /^[A-Z][\w-]*$/.test(ruling), whole: at === 0 };
}

/**
 * The two lists against the base's (D; RULING-QUESTIONS Q-6): a row never leaves, but for a whole file's row whose
 * file is now sorted case by case; a never-red row never leaves, but with an act a named ruling dropped, when its
 * case's row is RETIRED with the holder `dropped: <ruling>`. A never-red row is the same row by its test and what
 * it states: one promise is stated by many cases.
 * @param {{ rows: { file: string, holder: string, state: string }[], neverRed: { test: string, states: string }[],
 *   baseRows: { file: string }[], baseNeverRed: { test: string, states: string }[] }} given
 */
export function compareOldTestsWithBase({ rows, neverRed, baseRows, baseNeverRed }) {
  const refusals = [];
  const held = new Map(rows.map((row) => [row.file, row]));
  const sortedByCase = new Set(
    rows.map((row) => splitKey(row.file)).flatMap(({ path, name }) => (name === null ? [] : [path])),
  );
  for (const row of baseRows) {
    if (held.has(row.file) || sortedByCase.has(row.file)) continue;
    // A row whose case has no name named no case: an older reader took a call with no argument (`if (test())`)
    // for one. It leaves without a holder; a case of a name is never written so.
    if (splitKey(row.file).name === "") continue;
    refusals.push(
      `old tests: ${row.file}: a row never leaves the checklist; a file or case that leaves is RETIRED by its row (D)`,
    );
  }
  const redKey = (row) => `${row.test}\t${row.states}`;
  const reds = new Set(neverRed.map(redKey));
  for (const row of baseNeverRed) {
    if (reds.has(redKey(row))) continue;
    const old = held.get(row.test);
    const dropped = old && readState(old.state).word === "RETIRED" ? droppedOf(old.holder) : null;
    if (dropped?.named && dropped.whole) continue;
    refusals.push(`never red: ${row.states}: a never-red row never leaves (Q-6)`);
  }
  return refusals;
}

function neverRedRules(given, byPath) {
  const refusals = [];
  const caseRow = new Map(given.rows.map((row) => [row.file, row]));
  for (const row of given.neverRed) {
    const at = `never red: ${row.test === "none" ? row.states : row.test}`;
    if (!ACTS.includes(row.act))
      refusals.push(`${at}: the act "${row.act}" is not one of ${ACTS.join(", ")}`);
    if (!row.states.trim()) refusals.push(`${at}: the row says in one line what a person is promised`);
    if (!given.targets.has(row.place))
      refusals.push(`${at}: the place "${row.place}" is no place, pane:<id>, stage:<id>, reader or ground`);
    const mounted = given.mounted.has(row.place);
    const byName = holderFault(row.holder, given, { needsCase: true });
    if (mounted && byName)
      refusals.push(`${at}: ${row.place} is mounted, so its holder is a case at the new part: ${byName}`);
    if (!mounted && byName && !holdsTarget(row.holder, row.place))
      refusals.push(
        `${at}: the holder "${row.holder}" is no case in the tree, and no mount nor commit of the switch that mounts ${row.place}`,
      );
    if (row.test === "none") continue;
    const { path, name } = splitKey(row.test);
    const old = caseRow.get(row.test);
    if (name === null || !old) {
      const sorted = byPath.has(path) ? "its case has no row of its own" : "its file has no row";
      refusals.push(
        `${at}: a never-red case is sorted case by case in tools/old-tests.tsv (D, point b): ${sorted}`,
      );
      continue;
    }
    if (old.class === "markup")
      refusals.push(`${at}: an act is never markup: its row's class is ${old.class}`);
    const { word } = readState(old.state);
    if (mounted && (word === "WAITS" || word === "GAP"))
      refusals.push(
        `${at}: ${row.place} is mounted and its row is ${old.state}: green over the real entry, never WAITS or GAP`,
      );
  }
  return refusals;
}
