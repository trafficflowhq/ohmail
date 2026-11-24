/** What a pull request's ci.yml run tests; the rules are stated in `ci-select.mjs`. */

export const ROOT: string;
export const TARGET_S: number;
export const WHOLE_SHARE: number;
export const UNMEASURED_MS: number;
export const MAX_SHARDS: number;
export const MAX_SQLITE: number;
/** A capped run into a direct base: CAP_JOBS jobs' worth (CAP_S s) of measured main-suite time, SQLITE_CAP_S s of the second store's. */
export const CAP_JOBS: number;
export const CAP_S: number;
export const SQLITE_CAP_S: number;
export const COSTS: string;
export const PATH_OK: RegExp;
export const TREE_PATH_OK: RegExp;
export const DIRECT_BASES: string[];

export interface Ctx { event_name: string; actor: string; triggering_actor: string; repository: string; event: Record<string, any> }
export interface Change { s: string; p: string }
/** One side of a pull request, as the harness admission reads it: a path's text or null, whether it holds a folder, and
 *  whether a file of it names a text (a side without this answer, or that cannot answer, names it). */
export interface Tree { read(p: string): string | null; exists?(p: string): boolean; names?(text: string): boolean }
/** A harness path a pull request into a direct base defers: the trigger it met, and what its change added. */
export interface Harness { p: string; what: string; shape: string }
/** A reason a pull request into a direct base is capped for: the path and the trigger it met. */
export interface Capped { p: string; what: string }
export interface Scope { scope: "whole" | "selected" | "build-only"; why: string; changes?: Change[]; sqliteWhole?: boolean; dovecotAll?: boolean; harness?: Harness[]; capped?: Capped[] }
export interface Reader { paths: string[]; loads: string[]; git: boolean; bundle: boolean; sweep: boolean }
/** `rootsRelated`: the test files the graph relates to `roots` alone, asked for with them; null when that reading failed. */
export interface Graph { related: string[]; all: string[]; reached?: string[]; rootsRelated?: string[] | null }
export interface GraphOptions { config?: string | false; overrides?: Record<string, unknown>; defaultTriggers?: boolean; entries?: string[]; list?: boolean; roots?: string[] }
export interface Costs { measuredAt?: string; suite?: Record<string, number>; sqlite?: Record<string, number> }
export interface Deferred { file: string; rule: string }
export interface Plan {
  scope: "whole" | "selected"; why: string;
  shards: { shard: number; files: string; dovecot: "yes" | "no" }[];
  alone: string[];
  sqlite: { shard: number; files: string }[] | null;
  /** A plan into a direct base alone carries these three (FAST is "direct"), and its summary the base, the deferred
   *  count and seconds, the merge's base, the floor, the never-cut and filled counts and the measured seconds. */
  mode?: "direct" | "capped";
  deferred?: Deferred[];
  sqliteDeferred?: string[];
  /** A capped plan's reasons (none when the cost alone capped it) and what the cap left, by name (rule "cap"). */
  capped?: Capped[];
  left?: Deferred[];
  sqliteLeft?: string[];
  /** …and this, with its summary's paths, when its diff holds harness paths that only add a package's lines. */
  harness?: Harness[];
  summary?: {
    changed: number; rules: Record<string, number>; main: number; alone: number; sqlite: number | "whole"; share: number; costsMeasuredAt: string;
    base?: string; deferred?: number; deferredS?: number; harness?: string[];
    baseSha?: string; floor?: number; neverCut?: number; filled?: number; measuredS?: number; overCapS?: number; left?: number; leftS?: number; reason?: string;
  };
}
export interface Outputs {
  scope: Scope["scope"]; why: string;
  shards: { shard: number; files?: string; dovecot?: string }[]; alone: string[]; sqlite: { shard: number; files?: string }[];
  summary: Plan["summary"] | null;
  /** A capped plan's, for its summary. */
  mode?: "capped";
}

export function stripComments(src: string): string;
export function ciContext(env?: Record<string, string | undefined>): Ctx;
export function eventWhole(ctx: Ctx): string | null;
export function directBase(ctx: Ctx): string | null;
export function parseNameStatus(text: string): Change[];
export function readDiff(root: string, ctx: Ctx): Change[];
export function setupClosure(root: string): string[];
/** The judge: a path whose change runs whole into every base. */
export function isJudge(root: string, p: string, admitted?: boolean): boolean;
export const BUNDLERS: string[];
export const bundlerClosure: (root: string) => string[];
export const inTestDir: (p: string) => boolean;
export function versionOnly(before: string, after: string): boolean;
export function tsconfigAdditions(p: string, before: string, after: string): { references: { path: string; to: string }[]; paths: string[]; include: string[] } | null;
export function admittedTsconfig(p: string, before: string | null, after: string, sets?: { newAreas?: Set<string> }): string | null;
/** `workspaces`: the base lockfile's linked workspaces, name → folder; `names`: whether the base names a text. */
export function admittedVitestAlias(before: string, after: string, sets?: { newNames?: Map<string, string>; workspaces?: Map<string, string>; names?: (text: string) => boolean }): string | null;
export function admittedShardMap(before: string, after: string, sets?: { deleted?: Set<string>; added?: Set<string> }): string | null;
export function admittedManifest(p: string, before: string | null, after: string, sets?: { newAreas?: Set<string>; newNames?: Map<string, string>; links?: Set<string>; depended?: Set<string> | null }): string | null;
export function admittedLock(before: string, after: string, sets?: { newAreas?: Set<string>; newNames?: Map<string, string> }): string | null;
export function pathTriggers(root: string, changes: Change[], sides?: { direct?: boolean; base?: Tree; head?: Tree }): { whole: string[]; sqliteWhole: boolean; dovecotAll: boolean; deferred?: Harness[]; capped?: Capped[] };
export function decideScope(args: { root?: string; ctx: Ctx; changes?: Change[] | null; base?: Tree | null; head?: Tree | null }): Scope;
export const areaOf: (p: string) => string;
export function namedPaths(root: string, holder: string, src: string, tops: Set<string>, deleted?: string[]): Set<string>;
export function readersOf(root: string, files: string[], helpers: { code: (src: string) => string; relativeImports: (src: string, rel: string, root: string) => string[]; deleted?: string[]; includeRoot?: boolean }): Map<string, Reader>;
export function sourceEntries(readers: Map<string, Reader>): string[];
export function relatedInputs(root: string, paths: string[]): string[];
export function readerHits(root: string, changes: Change[], readers: Map<string, Reader>, reached?: Iterable<string>): Map<string, string>;
/** The test files that import a deleted path by a static relative import. */
export function importersOfDeleted(root: string, files: string[], deleted: string[]): string[];
export function vitestGraph(root: string, related: string[], options?: GraphOptions): Promise<Graph>;
export function packFiles(files: string[], costOf: (f: string) => number, max: number, groupOf?: (f: string) => string | null): string[][];
export function readCosts(root: string): Costs;
export function planProblems(plan: Plan, sets: { files: string[]; alone: Set<string>; desktop: Set<string>; sqliteAll?: string[] }): string[];
/** `rootReach`: the test files the graph relates to the changed root modules alone, or null for their whole reach. */
export function border(related: string[], rootReach?: string[] | null): (file: string) => boolean;
export function directSet(sets: {
  picked: string[]; rule: Map<string, string>; hits: Map<string, string>; rootHits: Map<string, string>;
  graphRelated: string[]; related: string[]; dovecot?: Set<string>; rootReach?: string[] | null;
}): { direct: string[]; deferred: Deferred[] };
export function select(args?: { root?: string; ctx: Ctx; changes?: Change[] | null; graph?: (root: string, related: string[], options: GraphOptions) => Promise<Graph>; costs?: Costs | null; base?: Tree | null; head?: Tree | null }): Promise<Plan | { scope: "whole" | "build-only"; why: string }>;
export function composeOutputs(args: { indexes: number[]; sqliteIndexes: number[]; alone: string[]; scope?: string; scopeWhy?: string; selectOutcome?: string; plan?: Plan | null }): Outputs;
export function summaryText(out: Outputs): string;
export function deferredLog(plan: Plan | { scope: "whole" | "build-only"; why: string }, ctx?: Partial<Ctx>): string;
