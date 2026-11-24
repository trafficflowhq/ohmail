import type { ArchiveLock, Registry } from "./registry.d.mts";

/** The shards a run needs: the canary, and each registered screen with a subjects file. */
export function wanted(lock: ArchiveLock, registry: Pick<Registry, "screens">, subjectFiles: string[], all?: boolean): string[];
/** Fetches one shard, checks it against the lock and unpacks it into `<into>/<id>/`. */
export function fetchShard(shard: ArchiveLock["shards"][number], into: string, from: string | undefined): Promise<"fetched" | "kept">;
/** Fetches the shards `ids`; with no `from` and no address in the lock, one line and code 1. */
export function fetchAll(lock: Pick<ArchiveLock, "shards">, ids: string[], into: string, from?: string): Promise<{ code: 0 | 1; out: string[]; err: string[] }>;
/** Which of the shards a comparison run reads are not in `into`, the one line to say about it, and whether the run fails on it. */
export function referenceIn(into: string, ids: string[], required: boolean): { missing: string[]; line: string; fail: boolean };
