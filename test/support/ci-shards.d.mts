/** The suite's shard map and its reader; the rules are stated in `ci-shards.mjs`. */

export const ROOT: string;
export const MAP: string;
export const SHARDS: number;
export const ALONE_MARKER: string;
export const DOVECOT_TEXT: RegExp;
export const DOVECOT_PATH: RegExp;
export const DESKTOP_CONFIG_IMPORT: RegExp;

export interface ShardMap { measuredAt: string; shards: string[][]; pins: { dovecot: string[] } }
export interface VitestReport { testResults: { name: string; startTime: number; endTime: number; status?: string }[] }

export function testFiles(root?: string): string[];
export function aloneFiles(root?: string, files?: string[]): string[];
export function desktopFiles(root?: string, files?: string[]): string[];
export function dovecotPinned(root: string, rel: string): boolean;
export function hashShard(rel: string, shards?: number): number;
export function readMap(root?: string): ShardMap;
export function shardFiles(n: number, root?: string, map?: ShardMap): string[];
export function checkMap(root?: string, map?: ShardMap): string[];
export function measuredCosts(root: string, reports: VitestReport[]): Map<string, number>;
export function pack(root: string, cost: Map<string, number>, measuredAt: string): { map: ShardMap; seconds: number[] };
export function verifyReport(n: number | "desktop", report: VitestReport, root?: string, map?: ShardMap): { missing: string[]; extra: string[] };

export const SQLITE_MAP: string;
export const SQLITE_SHARDS: number;
export interface SqliteShardMap { measuredAt: string; shards: string[][] }
export interface VitestListRow { file: string; projectName?: string }
export function readSqliteMap(root?: string): SqliteShardMap;
export function listedFiles(root: string, list: VitestListRow[]): string[];
export function sqliteShardFiles(n: number, listed: string[], map: SqliteShardMap): string[];
export function checkSqliteMap(root?: string, map?: SqliteShardMap): string[];
export function verifySqliteReport(n: number, listed: string[], report: VitestReport, root?: string, map?: SqliteShardMap): { missing: string[]; extra: string[] };
export function packSqlite(cost: Map<string, number>, measuredAt: string): { map: SqliteShardMap; seconds: number[] };
