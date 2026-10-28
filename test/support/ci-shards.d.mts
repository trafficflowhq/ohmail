/** The suite's shard map and its reader; the rules are stated in `ci-shards.mjs`. */

export const ROOT: string;
export const MAP: string;
export const SHARDS: number;
export const ALONE_MARKER: string;
export const DOVECOT_TEXT: RegExp;
export const DOVECOT_PATH: RegExp;
export const DESKTOP_CONFIG_IMPORT: RegExp;
export const DESKTOP_INSTALL_MARKER: string;
export const SERVICE_GATE_PREFIX: string;

export interface ShardMap { measuredAt: string; shards: string[][]; pins: { dovecot: string[] } }
export interface VitestReport {
  testResults: {
    name: string; startTime: number; endTime: number; status?: string;
    assertionResults?: { ancestorTitles?: string[]; title?: string; fullName?: string; status?: string }[];
  }[];
}

export function testFiles(root?: string): string[];
export function aloneFiles(root?: string, files?: string[]): string[];
export function desktopFiles(root?: string, files?: string[], options?: { configOnly?: boolean }): string[];
export function dovecotPinned(root: string, rel: string): boolean;
export function hashShard(rel: string, shards?: number): number;
export function readMap(root?: string): ShardMap;
export function shardFiles(n: number, root?: string, map?: ShardMap): string[];
export function checkMap(root?: string, map?: ShardMap): string[];
export function measuredCosts(root: string, reports: VitestReport[]): Map<string, number>;
export function treeCosts(root: string, reports: VitestReport[]): Map<string, number>;
export function pack(root: string, cost: Map<string, number>, measuredAt: string): { map: ShardMap; seconds: number[] };
export function verifyReport(n: number | "desktop", report: VitestReport, root?: string, map?: ShardMap): { missing: string[]; extra: string[]; gated: string[] };
export function gatedFiles(report: VitestReport, root?: string): string[];

export const SQLITE_MAP: string;
export const SQLITE_SHARDS: number;
export const SQLITE_BUDGET_S: number;
export interface SqliteShardMap { measuredAt: string; shards: string[][]; seconds?: number[] }
export interface VitestListRow { file: string; projectName?: string }
export function readSqliteMap(root?: string): SqliteShardMap;
export function listedFiles(root: string, list: VitestListRow[]): string[];
export function sqliteShardFiles(n: number, listed: string[], map: SqliteShardMap): string[];
export function checkSqliteMap(root?: string, map?: SqliteShardMap): string[];
export function verifySqliteReport(n: number, listed: string[], report: VitestReport, root?: string, map?: SqliteShardMap): { missing: string[]; extra: string[]; gated: string[] };
export function packSqlite(cost: Map<string, number>, measuredAt: string): { map: SqliteShardMap; seconds: number[] };

export const COSTS: string;
export interface Costs { measuredAt: string; suite: Record<string, number>; sqlite: Record<string, number> }
export function verifyList(want: string[], report: VitestReport, root?: string): { missing: string[]; extra: string[]; gated: string[] };
export function treeFile(name: string, known: Set<string>): string | null;
export function costsFrom(root: string, named: { path: string; report: VitestReport }[], measuredAt: string): Costs;
