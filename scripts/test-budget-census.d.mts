/**
 * The types for `scripts/test-budget-census.mjs`, so `test/test-budget-census.test.ts` can drive it
 * without adding a TS7016 to the root test directory's pinned count.
 */
export type ChainPart = { text: string } | { pattern: string };
export type BudgetSource = "config" | "case" | "describe" | "setConfig";

export interface Case {
  file: string;
  line: number;
  chain: ChainPart[];
  budgetMs: number | null;
  source: BudgetSource;
  expr: string;
  hooks: Array<"beforeEach" | "afterEach">;
  via: string;
  conditional: boolean;
}

export interface Suite {
  file: string;
  line: number;
  chain: ChainPart[];
  budgetMs: number | null;
  source: BudgetSource;
  expr: string;
}

export interface Finding { file: string; line: number; kind: string; detail: string }

export interface Timing {
  file: string;
  project: "default" | "sqlite";
  chain: string[];
  ms: number;
  status: "passed" | "failed";
  timedOut: boolean;
  from: string;
}

export interface Row extends Omit<Case, "source"> {
  source: BudgetSource | null;
  name: string;
  project: string;
  samples: number;
  maxMs: number;
  medianMs: number;
  ratio: number | null;
  matched: "exact" | "pattern" | "describe" | "none";
  timedOut: number;
  failed: number;
  inTree: boolean;
}

export interface ConfigBudget { ms: number | null; expr: string; file: string | null }

export declare const VITEST_DEFAULT_MS: number;
export declare function testFiles(root: string): string[];
export declare function configBudgets(root: string): { default: ConfigBudget; sqlite: ConfigBudget };
export declare function caseBudgets(root: string, files?: string[]): { cases: Case[]; suites: Suite[]; findings: Finding[] };
export declare function readReport(path: string): Timing[];
export declare function readJobLog(path: string): Timing[];
export declare function repoFileOf(path: string, files: Set<string>): string | null;
export declare function joinTimings(
  cases: Case[],
  timings: Timing[],
  opts?: {
    files?: Set<string>;
    suites?: Suite[];
    config?: { default: ConfigBudget; sqlite: ConfigBudget };
    drop?: { from: Set<string>; files: Set<string> };
  },
): Row[];
export declare function verdict(
  rows: Row[],
  opts?: { explicitRatio?: number; warnRatio?: number; minMs?: number; findings?: Finding[] },
): { listA: Row[]; listB: Row[]; unmatched: Row[]; unresolved: Row[]; fail: string[]; warn: string[] };
export declare function main(argv: string[]): number;
