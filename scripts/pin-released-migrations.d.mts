/** The types for `scripts/pin-released-migrations.mjs`, for `test/pin-released-migrations.test.ts`. */
export interface Lock {
  release: string;
  tag: string;
  note: string;
  files: Record<string, string>;
}
export type Journal = "mail" | "cloud" | "device";
export declare const LOCK_PATH: string;
export declare const JOURNALS: readonly { journal: Journal; dir: string }[];
export declare function journalSqlOf(paths: readonly string[]): { journal: Journal; path: string }[];
export declare function lockFor(release: string, tag: string, entries: readonly { path: string; sha: string }[]): Lock;
export declare function diffLocks(a: Pick<Lock, "release" | "tag" | "files"> | null, b: Lock): string[];
export declare function lockAt(root: string, release: string, commit: string): { lock: Lock; counts: Record<Journal, number> };
export declare function main(argv: readonly string[]): number;
