/** The types for `scripts/migration-numbers.mjs`, for `test/migration-number-census.test.ts`. */
export declare const JOURNALS: readonly { dir: string; sequence: "mail" | "cloud" }[];
export declare function numberOf(file: string): string | null;
export declare function journalCollisions(root: string): { dir: string; number: string; files: string[] }[];
export declare function nextFree(
  root: string,
  prs: readonly { number: number; files: readonly string[] }[],
): Record<"mail" | "cloud", { next: string; clashes: { number: string; holders: string[] }[] }>;
