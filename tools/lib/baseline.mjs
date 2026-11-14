// tools/baseline.tsv: the violations the tree had when a rule arrived, one row per file and rule,
// each with the task that removes it. A border row is kept per package reached, so that one crossing
// cannot stand in for another. The file is an exact mirror of the tree: a violation beyond
// a row is refused, and so is a row beyond the violations.

export const BASELINE_HEADER = "path\trule\tcount\ttask";
const TASK = /^(ruling:[A-Za-z0-9][A-Za-z0-9-]*|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/;
const keyOf = (row) => `${row.path}\t${row.rule}`;
const order = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/** @returns {{ rows: { path: string, rule: string, count: number, task: string }[], refusals: string[] }} */
export function parseBaseline(text) {
  const refusals = [];
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines[0] !== BASELINE_HEADER)
    refusals.push(`baseline: the first line is not "${BASELINE_HEADER.replaceAll("\t", " ")}"`);
  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const [path, rule, count, task, ...rest] = line.split("\t");
    const row = { path, rule, count: Number(count), task: task ?? "" };
    const at = `baseline: ${path} ${rule}`;
    if (rest.length || !path || !rule) refusals.push(`${at}: a row has four columns`);
    else if (!Number.isInteger(row.count) || row.count < 1)
      refusals.push(`${at}: the count "${count}" is not a whole number above zero`);
    else if (!TASK.test(row.task))
      refusals.push(
        `${at}: the task "${row.task}" is empty or not a task's name; a row names the task that removes it, or ruling:<id>`,
      );
    else if (seen.has(keyOf(row))) refusals.push(`${at}: the row stands twice`);
    seen.add(keyOf(row));
    rows.push(row);
  }
  const sorted = [...rows].sort(order);
  if (rows.some((row, i) => row !== sorted[i]))
    refusals.push("baseline: the rows are not sorted by path, then rule");
  return { rows, refusals };
}

export function renderBaseline(rows) {
  const lines = [...rows].sort(order).map((row) => [row.path, row.rule, row.count, row.task].join("\t"));
  return [BASELINE_HEADER, ...lines].join("\n") + "\n";
}

/** The rule a finding's row is written under: `ohmail/package-borders:db` for an import that reached db. */
export const rowRule = (finding) => (finding.reach ? `${finding.rule}:${finding.reach}` : finding.rule);

/** Findings, one per violation, counted per file and rule. */
export function countFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = `${finding.path}\t${rowRule(finding)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The mirror: every refusal that the tree and the baseline disagree on.
 * @param {{ path: string, rule: string, count: number }[]} rows
 * @param {{ path: string, rule: string, reach?: string, line?: number, message?: string }[]} findings
 */
export function compareWithTree(rows, findings) {
  const refusals = [];
  const live = countFindings(findings);
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  for (const [key, count] of live) {
    const allowed = byKey.get(key)?.count ?? 0;
    if (count <= allowed) continue;
    const [path, rule] = key.split("\t");
    const where = findings
      .filter((f) => f.path === path && rowRule(f) === rule)
      .map((f) => `    ${path}:${f.line ?? 1}  ${f.message ?? ""}`);
    refusals.push(
      [`${rule}: ${path} has ${count}, the baseline allows ${allowed}`, ...where.slice(0, 12)].join("\n"),
    );
  }
  for (const row of rows) {
    const count = live.get(keyOf(row)) ?? 0;
    if (count < row.count)
      refusals.push(
        `stale: ${row.path} ${row.rule} reads ${count}, its row says ${row.count}; the fix carries its row's change`,
      );
  }
  return refusals;
}

/**
 * Growth against the base branch: per rule and task the count never grows, so a row appears only
 * where the same task lost as much under another path (a move).
 */
export function compareWithBase(rows, baseRows) {
  const base = new Map(baseRows.map((row) => [keyOf(row), row]));
  const head = new Map(rows.map((row) => [keyOf(row), row]));
  const moved = new Map(); // "rule\ttask" → { grew, lost, where }
  const slot = (rule, task) => {
    const key = `${rule}\t${task}`;
    if (!moved.has(key)) moved.set(key, { rule, task, grew: 0, lost: 0, where: [] });
    return moved.get(key);
  };
  for (const row of rows) {
    const before = base.get(keyOf(row))?.count ?? 0;
    if (row.count > before) {
      const s = slot(row.rule, row.task);
      s.grew += row.count - before;
      s.where.push(`${row.path} (${before} → ${row.count})`);
    }
  }
  for (const row of baseRows) {
    const now = head.get(keyOf(row))?.count ?? 0;
    if (now < row.count) slot(row.rule, row.task).lost += row.count - now;
  }
  return [...moved.values()]
    .filter((s) => s.grew > s.lost)
    .map(
      (s) =>
        `the baseline grew: ${s.rule} for the task ${s.task} gained ${s.grew} and lost ${s.lost}: ${s.where.join(", ")}`,
    );
}

/** Totals for the run's summary and for a pull request's text. */
export function totals(rows, column) {
  const sums = new Map();
  for (const row of rows) sums.set(row[column], (sums.get(row[column]) ?? 0) + row.count);
  return [...sums].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
