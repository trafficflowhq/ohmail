/**
 * WHERE THIS PHONE PUT THE STORAGE NOTICE AWAY — per account, level and cap (`ui/storage-notice.ts`), so
 * unlike the lifecycle strip's per-run dismissal it is kept in the keystore. One row, bounded. A
 * refused or locked keystore keeps the dismissal for this run only: showing the notice again is a
 * smaller failure than never showing it.
 */
import type { SecureKV } from "./servers";

export const STORAGE_NOTICE_KEY = "ohmail.storageNotice";

/** Dismissals a phone keeps; past this the oldest goes. */
export const STORAGE_NOTICES_KEPT = 48;

let held: string[] = [];
let kv: SecureKV | null = null;
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function decode(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Read the row once; every later dismissal is written through `store`. */
export function bindStorageNotices(store: SecureKV): Promise<void> {
  if (loading !== null) return loading;
  kv = store;
  loading = (async () => {
    try {
      const read = decode(await store.get(STORAGE_NOTICE_KEY));
      held = [...read.filter((k) => !held.includes(k)), ...held].slice(-STORAGE_NOTICES_KEPT);
    } catch { /* nothing kept: the notice may show again */ }
    for (const l of [...listeners]) l();
  })();
  return loading;
}

export function storageNoticePutAway(key: string): boolean {
  return held.includes(key);
}

/** The dismissals as one value that changes with them, for a subscription's snapshot. */
export function storageNoticesHeld(): readonly string[] {
  return held;
}

export function putAwayStorageNotice(key: string): void {
  if (held.includes(key)) return;
  held = [...held, key].slice(-STORAGE_NOTICES_KEPT);
  for (const l of [...listeners]) l();
  const store = kv;
  if (store === null) return;
  const row = JSON.stringify(held);
  writes = writes
    .then(() => loading ?? undefined)
    .then(() => store.set(STORAGE_NOTICE_KEY, row))
    .catch(() => { /* kept for this run */ });
}

export function onStorageNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only. */
export function resetStorageNoticesForTests(): void {
  held = [];
  kv = null;
  loading = null;
  writes = Promise.resolve();
}

/** Tests only: resolves once every queued write has landed. */
export function storageNoticeWritesSettled(): Promise<void> {
  return writes;
}
