export interface BaselineRow {
  path: string;
  rule: string;
  count: number;
  task: string;
}
export interface Finding {
  path: string;
  rule: string;
  /** A border finding: the package the import reached. */
  reach?: string;
  line?: number;
  message?: string;
}
export const BASELINE_HEADER: string;
export function parseBaseline(text: string): { rows: BaselineRow[]; refusals: string[] };
export function renderBaseline(rows: BaselineRow[]): string;
export function rowRule(finding: Finding): string;
export function countFindings(findings: Finding[]): Map<string, number>;
export function compareWithTree(rows: BaselineRow[], findings: Finding[]): string[];
export function compareWithBase(rows: BaselineRow[], baseRows: BaselineRow[]): string[];
export function totals(rows: BaselineRow[], column: "rule" | "task"): [string, number][];
