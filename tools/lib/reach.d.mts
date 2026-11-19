export function isUiPart(rel: string): boolean;
export function hostEntries(files: string[]): string[];
export function importsOf(text: string): string[];
export function makeResolver(
  present: Set<string>,
  manifests: Record<string, { name?: string; exports?: unknown; main?: string }>,
): (spec: string, importer: string) => string | null;
export function makeGraph(
  resolve: (spec: string, importer: string) => string | null,
  textOf: (rel: string) => string | null,
): { edgesOf: (rel: string) => string[]; closure: (starts: Iterable<string>) => Set<string> };
export function checkHostShellImports(
  tree: {
    files: string[];
    textOf: (rel: string) => string | null;
    manifests: Record<string, { name?: string; exports?: unknown; main?: string }>;
  },
  retained: string[],
  before?: string[],
): string[];
