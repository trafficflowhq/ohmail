import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkTable, HEADER, TABLE, VERDICTS } from "./support/invariant-table.mjs";

/* docs/INVARIANTS.tsv reads clean, and the reader refuses each way a row can lie (docs/INVARIANTS.md).
 * Mutation: drop the bitten-needs-a-verdict check in invariant-table.mjs and two refusal cases go red. */
const ROOT = resolve(__dirname, "..");
const trees: string[] = [];
afterAll(() => { for (const t of trees) rmSync(t, { recursive: true, force: true }); });

const WHOLE = {
  id: "1", base: "a".repeat(40), recorded: "2026-10-22", command: "npx vitest run test/a.test.ts", tests: ["test/a.test.ts"],
  arms: [{ file: "src/gate.ts", line: "x > 0", to: "x >= 0", failed: 1 }], green: { failed: 0, passed: 1 },
};
function fixture(o: { status?: string; tests?: string; verdict?: object | null; extra?: string } = {}): string {
  const t = mkdtempSync(join(tmpdir(), "invariant-table-")); trees.push(t);
  mkdirSync(join(t, "test"), { recursive: true }); mkdirSync(join(t, "src")); mkdirSync(join(t, VERDICTS), { recursive: true });
  writeFileSync(join(t, "test/a.test.ts"), "it('x', () => {});\n");
  writeFileSync(join(t, "src/gate.ts"), "export const open = (x: number) => x > 0;\n");
  const rows = [HEADER.join("\t")];
  for (let n = 1; n <= 11; n++) {
    rows.push(n === 1
      ? ["1", "c", o.status ?? "bitten", o.tests ?? "test/a.test.ts", `${VERDICTS}/1.json`, "-"].join("\t")
      : [String(n), "c", "no test", "-", `${VERDICTS}/${n}.json`, "-"].join("\t"));
  }
  writeFileSync(join(t, TABLE), rows.join("\n") + "\n");
  const v = o.verdict === undefined ? WHOLE : o.verdict;
  if (v) writeFileSync(join(t, VERDICTS, "1.json"), JSON.stringify(v));
  if (o.extra) writeFileSync(join(t, VERDICTS, o.extra), "{}");
  return t;
}

describe("the invariant table", () => {
  it("reads clean in this checkout", () => { expect(checkTable(ROOT)).toEqual([]); });
  it("control: a bitten row with a whole verdict reads clean", () => { expect(checkTable(fixture())).toEqual([]); });
  it("refuses a bitten row without its verdict", () => {
    expect(checkTable(fixture({ verdict: null }))).toContain("1: bitten without a verdict file");
  });
  it("refuses a verdict whose deciding line has changed", () => {
    const v = { ...WHOLE, arms: [{ ...WHOLE.arms[0], line: "x >= 1" }] };
    expect(checkTable(fixture({ verdict: v })).join("\n")).toMatch(/1: the deciding line no longer reads once in src\/gate.ts/);
  });
  it("refuses a verdict that shows no red, or mutates the test itself", () => {
    const v = { ...WHOLE, arms: [{ ...WHOLE.arms[0], failed: 0 }, { file: "test/a.test.ts", line: "x", to: "y", failed: 1 }] };
    expect(checkTable(fixture({ verdict: v }))).toEqual(expect.arrayContaining(["1: an arm shows no red", "1: an arm mutates the test itself"]));
  });
  it("refuses a named test the suite does not run", () => {
    expect(checkTable(fixture({ status: "not yet run", tests: "test/gone.test.ts", verdict: null })).join("\n"))
      .toMatch(/1: test\/gone.test.ts is not a test the suite runs/);
  });
  it("refuses a verdict file no bitten row names", () => {
    expect(checkTable(fixture({ status: "not yet run", extra: "2.json" })))
      .toEqual(expect.arrayContaining(["1: not yet run with a verdict file", `${VERDICTS}/2.json: no bitten row names it`]));
  });
});

/* Rows checked against what ships. Each file below is the one that goes red when the row's deciding
 * code breaks (redactForModel for 1e; the no_ai arm of automaticAiAdmits for 1c); the row's other
 * files stay green under that mutation. */
const rows = new Map(readFileSync(join(ROOT, TABLE), "utf8").split("\n").slice(1).filter(Boolean)
  .map((l) => l.split("\t")).map((f) => [f[0], { claim: f[1], tests: f[3].split(" ") }]));
const HOLDS: Record<string, string[]> = {
  "1c": ["packages/services/test/screener-ai.test.ts", "packages/db/test/automatic-ai-one-predicate.test.ts",
    "apps/worker/test/screener-auto-suggest.pg.test.ts"],
  "1e": ["packages/core/test/ai-open.test.ts", "packages/core/test/sensitive.test.ts",
    "packages/services/test/screener-ai.test.ts", "apps/worker/test/screener-auto-suggest.pg.test.ts"],
};

describe("the table against what ships", () => {
  for (const [id, files] of Object.entries(HOLDS)) {
    it(`${id} names the tests that hold its deciding code`, () => {
      expect(rows.get(id)?.tests).toEqual(expect.arrayContaining(files));
    });
  }
  it("1e does not say an automatic pass refuses: the automatic Screener pass strips and sends", () => {
    expect(rows.get("1e")?.claim).not.toMatch(/an automatic pass refuses/i);
  });
  it("4d does not say every mutation is keyed: the census pins spending routes that are not", () => {
    expect(rows.get("4d")?.claim).not.toMatch(/every mutation takes an idempotency-key/i);
  });
});
