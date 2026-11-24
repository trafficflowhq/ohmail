export function leavesWithTheSwitch(rel: string): boolean;
export interface OldTestsTree {
  scope: Set<string>;
  tests: string[];
  isTest: (rel: string) => boolean;
  casesIn: (rel: string) => Set<string> | null;
  idleIn: (rel: string) => Map<string, string> | null;
  partOf: (rel: string) => { leaves: string[]; unreached: string[] };
  targets: Set<string>;
  mounted: Set<string>;
  said: string[];
  refusals: string[];
}
export function readOldTestsTree(given: {
  files: string[];
  textOf: (rel: string) => string | null;
  manifests: Record<string, { name?: string; exports?: unknown; main?: string }>;
}): OldTestsTree;
