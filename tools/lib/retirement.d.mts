export interface RetirementRow {
  file: string;
  kind: string;
  holds: string;
  home: string;
  task: string;
  verdict: string;
}
export const RETIREMENT_HEADER: string;
export const KINDS: string[];
export const READS_A_FILE: RegExp;
export function isSuiteTest(rel: string): boolean;
export function readingTests(given: { tests: string[]; textOf: (rel: string) => string | null }): Set<string>;
export function parseRetirement(text: string): { rows: RetirementRow[]; refusals: string[] };
export function renderRetirement(rows: RetirementRow[]): string;
export type Proof =
  | { form: "empty" }
  | { form: "verdict"; path: string }
  | { form: "gone"; path: string; piece?: string }
  | { form: "held"; test: string; title: string }
  | { form: "unknown" };
export function readProof(cell: string): Proof;
export function checkRetirement(given: {
  rows: RetirementRow[];
  reading: Set<string>;
  present: Set<string>;
  deleted: string[];
  verdictExists: (path: string) => boolean;
  tree: (path: string) => string | null;
  base?: (path: string) => string | null;
}): string[];
