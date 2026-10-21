/**
 * The types for `scripts/lane-db.mjs`, so `test/lane-db.test.ts` can drive its decisions without
 * adding a TS7016 to the root test directory's pinned count.
 */
export declare const LANE_DB_PREFIX: string;
export declare const LANE_DB_ENV_FILE: string;
export declare const LANE_DB_NAME_RE: RegExp;
export declare const WORKER_DB_NAME_RE: RegExp;

export declare function laneDbName(worktreePath: string): string;
export declare function assertLaneDbName(name: string): string;
export declare function assertWorkerDbName(name: string, logicals?: string[]): string;
export declare function workerDbsOf(names: string[], keys: string[], logicals?: string[]): string[];
export declare function isolatedKeyOf(name: string, named: Set<string>): string | null;
export declare function isolatedLogicalsIn(sources: string[]): string[];
export declare function withDatabase(url: string, database: string): string;
export declare function databaseOf(url: string): string;
export declare function parseLaneEnv(text: string): string | null;
export declare function baseUrlFrom(env: Record<string, string | undefined>): string;
export declare function doorOfDb(name: string): "lane-db" | "worker" | "other";

export interface LaneDbMaximum { name: string; tree: number; db: number }
export interface LaneDbVerdict {
  action: "create" | "reuse" | "recreate" | "refuse";
  reason: string;
}
export declare function decide(state: {
  exists: boolean;
  drift: string | null;
  maxima: LaneDbMaximum[];
}): LaneDbVerdict;

export declare const LANE_ROLE_PREFIX: string;
export declare const LANE_ROLE_RE: RegExp;
export declare const BOX_ROLE: string;
export declare const BOX_PORT: string;
export declare const THROWAWAY_PORT_ENV: string;
export declare const BOX_ROLE_DEADLINES_RC: number;
export declare function laneRoleOf(dbName: string): string;
export declare function assertLaneRoleName(role: string): string;
export declare function laneRoleHostVerdict(url: string, env?: Record<string, string | undefined>): { ok: boolean; say: string };
export declare function laneUrl(baseUrl: string, dbName: string, password: string): string;
export declare function keptPassword(envText: string | null, role: string): string | null;
export declare function deadlineKeysOf(
  rows: Array<{ setdatabase: number; datname: string | null; setconfig: string[] | null }>,
): Array<{ key: string; db: string | null }>;
export declare function laneRoleDropPlan(state: { dbName: string; role: string; owned: string[] }): {
  handOver: string[];
  blocking: string[];
  dropRole: boolean;
};
export declare function boxRoleCheckVerdict(
  childRc: number | null,
  line: string | null,
  word?: "BOX_ROLE_DEADLINES" | "LANE_ROLE_DEADLINES",
): { rc: number; verdict: "OK" | "BOX_ROLE_DEADLINES" | "LANE_ROLE_DEADLINES" | "UNREADABLE"; say: string };
export interface RoleSettingRow { rolname: string; setdatabase: number; datname: string | null; setconfig: string[] | null }
export declare function roleDeadlinesVerdict(state: { role: string; anchor: number; rows: RoleSettingRow[] }): { rc: 0 | 2 | 3; line: string };
export declare function readRoleDeadlines(sql: import("postgres").Sql, role: string): Promise<{ rc: 0 | 2 | 3; line: string }>;
export declare function maintenanceUrlFor(envUrl: string, baseUrl: string): string;
export declare function laneRoleVerdict(state: { role: string | undefined; roleExists: boolean; login: string }): {
  rc: number;
  verdict: "LEGACY_ROLE" | "REFUSED" | "ROLE_ABSENT" | "ROLE" | "LOGIN_REFUSED" | "UNREADABLE";
  say: string;
};
export declare function envRoleOf(envText: string | null): { role: string; where: string; db: string } | null;
export declare function classifyEnv(envText: string): {
  kind: "legacy" | "lane-role" | "other" | "unreadable";
  role?: string;
  where?: string;
  db?: string;
};
