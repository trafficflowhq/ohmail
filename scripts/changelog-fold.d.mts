/**
 * The types for `scripts/changelog-fold.mjs`, so the changelog tests can drive it without adding a TS7016 to
 * the root test directory's count.
 */
export interface Problem { file: string; line: number; reason: string }
export interface Fragment { file: string; headline: string; headingLine: number; bodyLine: number; body: string }

export declare const FRAGMENT_DIR: string;
export declare const README: string;
export declare const SLUG_RE: RegExp;
export declare const SLUG_MAX: number;
export declare const FRAGMENT_MAX_BYTES: number;
export declare const CHANGELOG_FILE: string;
export declare const METAINFO_FILE: string;
export declare const PLACEHOLDER_WORDS: readonly string[];

export declare class FoldRefusal extends Error {
  problems: Problem[];
  constructor(problems: Problem[]);
}

export declare function isDatedHeading(line: string): boolean;
export declare function placeholdersByBlock(text: string): Array<{ heading: string; line: number; found: string }>;
export declare function parseFragment(file: string, raw: string): { fragment: Fragment | null; problems: Problem[] };
export declare function readFragments(root: string): { fragments: Fragment[]; problems: Problem[] };
export declare function checkChangelog(text: string): Problem[];
export declare function fold(text: string, fragments: Fragment[], version: string, date: string): string;
export declare function preview(fragments: Fragment[]): string;
export declare function readChangelogText(root: string): string;
/** Re-exported from appstream-releases.mjs. */
export declare function releasesFrom(changelog: string): Array<{ version: string; date: string; items: string[] }>;
export declare function withChangelogReleases(metainfo: string, changelog: string): string;
