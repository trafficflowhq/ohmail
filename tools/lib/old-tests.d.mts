export interface OldTestRow {
  file: string;
  class: string;
  holder: string;
  share: string;
  state: string;
}
export interface NeverRedRow {
  test: string;
  act: string;
  place: string;
  holder: string;
  states: string;
}
export const OLD_TESTS_HEADER: string;
export const NEVER_RED_HEADER: string;
export const CLASSES: string[];
export const ACTS: string[];
export const SWITCH: string[];
export const MOUNTS: Record<string, string[]>;
export const OWNERS: string[];
export function readHolder(cell: string): { mount: string; said: string | null };
export function readState(cell: string): { word: string; what: string };
export function parseOldTests(text: string): { rows: OldTestRow[]; refusals: string[] };
export function parseNeverRed(text: string): { rows: NeverRedRow[]; refusals: string[] };
export function holderFault(
  cell: string,
  tree: {
    isTest: (rel: string) => boolean;
    casesIn: (rel: string) => Set<string> | null;
    idleIn?: (rel: string) => Map<string, string> | null;
  },
  how?: { needsCase?: boolean },
): string | null;
export function checkOldTests(given: {
  rows: OldTestRow[];
  neverRed: NeverRedRow[];
  scope: Set<string>;
  isTest: (rel: string) => boolean;
  casesIn: (rel: string) => Set<string> | null;
  idleIn?: (rel: string) => Map<string, string> | null;
  targets: Set<string>;
  mounted: Set<string>;
  partOf: (rel: string) => { leaves: string[]; unreached: string[] };
  retired: Map<string, string>;
  isSuiteTest: (rel: string) => boolean;
}): string[];
export function droppedOf(cell: string): { ruling: string; named: boolean; whole: boolean } | null;
export function compareOldTestsWithBase(given: {
  rows: Pick<OldTestRow, "file" | "holder" | "state">[];
  neverRed: Pick<NeverRedRow, "test" | "states">[];
  baseRows: Pick<OldTestRow, "file">[];
  baseNeverRed: Pick<NeverRedRow, "test" | "states">[];
}): string[];
