export const MAIL: string;
export const PLACES_FILE: string;
export const SUPPLIES_FILE: string;
export function idsIn(text: string, name: string): string[] | null;
export function typedLiterals(reading: { code: string }, type: string): number[];
export function readMounted(given: { files: string[]; textOf: (rel: string) => string | null }): {
  targets: Set<string>;
  mounted: Set<string>;
  said: string[];
  refusals: string[];
};
