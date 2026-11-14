import { describe, expect, it } from "vitest";
import {
  BASELINE_HEADER,
  compareWithBase,
  compareWithTree,
  countFindings,
  parseBaseline,
  renderBaseline,
  rowRule,
} from "../../tools/lib/baseline.mjs";
import { inNewTree, parseNewTree, renderPrettierIgnore } from "../../tools/lib/new-tree.mjs";

const row = (path: string, rule: string, count: number, task: string) => ({ path, rule, count, task });
const finding = (path: string, rule: string, line = 1) => ({ path, rule, line, message: "refused" });
const BORDERS = "ohmail/package-borders";

describe("the baseline file", () => {
  it("reads back what it writes, sorted by path and rule", () => {
    const rows = [row("b.ts", BORDERS, 2, "engine"), row("a.ts", "prettier", 1, "ruling:R-7")];
    const text = renderBaseline(rows);
    expect(text.split("\n")[0]).toBe(BASELINE_HEADER);
    expect(parseBaseline(text)).toEqual({ rows: [rows[1], rows[0]], refusals: [] });
  });

  it("refuses a row without a task, with a task of another shape, or with no count", () => {
    const text = [
      BASELINE_HEADER,
      `a.ts\t${BORDERS}\t1\t`,
      `b.ts\t${BORDERS}\t1\tSome Day`,
      `c.ts\t${BORDERS}\t0\tengine`,
    ];
    const { refusals } = parseBaseline(text.join("\n") + "\n");
    expect(refusals).toHaveLength(3);
    expect(refusals[0]).toMatch(/a\.ts .*the task "" is empty/);
    expect(refusals[1]).toMatch(/b\.ts .*the task "Some Day"/);
    expect(refusals[2]).toMatch(/c\.ts .*the count "0"/);
  });

  it("refuses a file without its header, a row written twice and rows out of order", () => {
    expect(parseBaseline("a.ts\tprettier\t1\tkit\n").refusals[0]).toMatch(/first line/);
    const twice = [BASELINE_HEADER, "a.ts\tprettier\t1\tkit", "a.ts\tprettier\t1\tkit"].join("\n");
    expect(parseBaseline(twice).refusals.join("\n")).toMatch(/stands twice/);
    const unsorted = [BASELINE_HEADER, "b.ts\tprettier\t1\tkit", "a.ts\tprettier\t1\tkit"].join("\n");
    expect(parseBaseline(unsorted).refusals.join("\n")).toMatch(/not sorted/);
  });
});

describe("the baseline against the tree", () => {
  const rows = [row("a.ts", BORDERS, 2, "engine")];

  it("passes when the tree has exactly what the rows say", () => {
    expect(compareWithTree(rows, [finding("a.ts", BORDERS), finding("a.ts", BORDERS, 9)])).toEqual([]);
  });

  it("refuses a violation beyond its row, and names where it is", () => {
    const three = [finding("a.ts", BORDERS, 3), finding("a.ts", BORDERS, 5), finding("a.ts", BORDERS, 8)];
    const [refusal] = compareWithTree(rows, three);
    expect(refusal).toMatch(/a\.ts has 3, the baseline allows 2/);
    expect(refusal).toContain("a.ts:8");
  });

  it("refuses a violation in a file that has no row", () => {
    const refusals = compareWithTree(rows, [
      finding("a.ts", BORDERS),
      finding("a.ts", BORDERS),
      finding("new.ts", "prettier"),
    ]);
    expect(refusals).toEqual([expect.stringMatching(/prettier: new\.ts has 1, the baseline allows 0/)]);
  });

  it("refuses a row the tree no longer needs: the fix carries its row's change", () => {
    expect(compareWithTree(rows, [finding("a.ts", BORDERS)])).toEqual([
      expect.stringMatching(/^stale: a\.ts .* reads 1, its row says 2/),
    ]);
    expect(compareWithTree(rows, [])).toEqual([expect.stringMatching(/^stale: .* reads 0/)]);
  });
});

describe("a border row per package reached", () => {
  const rows = [row("a.ts", `${BORDERS}:db`, 2, "mail-io")];
  const reach = (to: string, line = 1) => ({ ...finding("a.ts", BORDERS, line), reach: to });

  it("passes the crossings its rows name", () => {
    expect(compareWithTree(rows, [reach("db"), reach("db", 4)])).toEqual([]);
  });

  it("refuses another crossing where one of the row's own left: the count alone would read the same", () => {
    expect(compareWithTree(rows, [reach("db"), reach("services", 7)])).toEqual([
      expect.stringMatching(
        /^ohmail\/package-borders:services: a\.ts has 1, the baseline allows 0\n +a\.ts:7/,
      ),
      "stale: a.ts ohmail/package-borders:db reads 1, its row says 2; the fix carries its row's change",
    ]);
  });

  it("writes a finding's row under the rule and what it reached", () => {
    expect(rowRule(reach("db"))).toBe("ohmail/package-borders:db");
    expect(rowRule(finding("a.css", "prettier"))).toBe("prettier");
    expect([...countFindings([reach("db"), reach("db"), reach("apps/worker")])]).toEqual([
      ["a.ts\tohmail/package-borders:db", 2],
      ["a.ts\tohmail/package-borders:apps/worker", 1],
    ]);
  });
});

describe("the baseline against its base", () => {
  const base = [row("a.ts", BORDERS, 2, "engine"), row("b.ts", BORDERS, 1, "worker")];

  it("passes when nothing changed, and when a row shrank or left", () => {
    expect(compareWithBase(base, base)).toEqual([]);
    expect(compareWithBase([row("a.ts", BORDERS, 1, "engine")], base)).toEqual([]);
  });

  it("refuses a row that appeared and a count that grew", () => {
    expect(compareWithBase([...base, row("c.ts", BORDERS, 1, "engine")], base)).toEqual([
      expect.stringMatching(/the baseline grew: .*engine gained 1 and lost 0: c\.ts \(0 → 1\)/),
    ]);
    expect(compareWithBase([row("a.ts", BORDERS, 3, "engine"), base[1]], base)).toHaveLength(1);
  });

  it("lets a row move to another path with its task", () => {
    const moved = [row("moved/a.ts", BORDERS, 2, "engine"), base[1]];
    expect(compareWithBase(moved, base)).toEqual([]);
  });

  it("refuses a trade: one task's fix does not pay for another task's new violation", () => {
    const traded = [base[0], row("c.ts", BORDERS, 1, "engine")];
    expect(compareWithBase(traded, base)).toEqual([expect.stringMatching(/engine gained 1 and lost 0/)]);
  });

  it("refuses a new row under another rule, whatever was fixed elsewhere", () => {
    const other = [row("a.ts", "ohmail/platform-name", 1, "engine")];
    expect(compareWithBase(other, base)).toEqual([
      expect.stringMatching(/ohmail\/platform-name .* gained 1/),
    ]);
  });
});

describe("the list of the new tree", () => {
  it("refuses a missing or empty list: the formatter would check nothing", () => {
    expect(() => parseNewTree(null)).toThrow(/missing or empty/);
    expect(() => parseNewTree("\n# only a comment\n")).toThrow(/missing or empty/);
  });

  it("binds a listed folder's files and a listed file, and nothing beside them", () => {
    const entries = parseNewTree("packages/wire\neslint.config.mjs\n");
    expect(inNewTree("packages/wire/src/kinds.ts", entries)).toBe(true);
    expect(inNewTree("eslint.config.mjs", entries)).toBe(true);
    expect(inNewTree("packages/wire-old/src/kinds.ts", entries)).toBe(false);
    expect(inNewTree("packages/core/src/fold.ts", entries)).toBe(false);
  });

  it("writes an ignore file that shuts everything and opens each listed path", () => {
    const lines = renderPrettierIgnore(["packages/wire", "apps/paired-page", "tools"]).split("\n");
    expect(lines.slice(1)).toEqual([
      "/*",
      "!/packages",
      "/packages/*",
      "!/packages/wire",
      "!/apps",
      "/apps/*",
      "!/apps/paired-page",
      "!/tools",
      "/tools/plant",
      "",
    ]);
  });
});
