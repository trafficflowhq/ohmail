export interface Control {
  id: string;
  rule?: string | string[];
  plant: string;
  expect?: "refused" | "passes";
  source?: (string | { repeat: string; count: number })[];
}
export interface ControlRecord {
  id: string;
  rule: string;
  plant: string;
  outcome: "refused" | "passed";
  line?: number;
  message?: string;
}
export function fixtureText(control: Control): string;
export function plant(copy: string, controls: Control[]): void;
export function judgeControls(
  controls: Control[],
  findings: { path: string; rule: string; line?: number; message?: string }[],
  activeRules: string[],
): { records: ControlRecord[]; refusals: string[] };
export function ruleSlug(rule: string): string;
export function verdictOf(
  rule: string,
  records: ControlRecord[],
  about: { base: string; recorded: string },
): {
  id: string;
  base: string;
  recorded: string;
  command: string;
  arms: { control: string; file: string; line?: number; refused?: string }[];
  green: { control: string; file: string }[];
};
