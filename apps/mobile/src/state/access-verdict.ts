/**
 * WHERE THIS PHONE LAST FOUND EACH PAIRED ACCOUNT — `open` or `closed`, written on every fresh
 * access answer and every wall the sink raises. It decides one thing: whether the tabs may paint
 * the mirror at once (`open`) or must ask first (`ui/first-paint.ts`). It never lifts a wall.
 *
 * Keyed by the PAIRING's own id, which names no server and no account: this keystore row outlives
 * a forget, and on iOS a reinstall, so it may say nothing about either. One row for all pairings,
 * bounded, written only when a verdict changes.
 */
import type { SecureKV } from "./servers";

export const ACCESS_VERDICT_KEY = "ohmail.access";

export type StoredVerdict = "open" | "closed";

/** Pairings a phone keeps a verdict for; past this the oldest entry goes. */
export const VERDICTS_KEPT = 16;

let held = new Map<string, StoredVerdict>();
let kv: SecureKV | null = null;
let loading: Promise<void> | null = null;
let ready = false;
let writes: Promise<void> = Promise.resolve();

function decode(raw: string | null): [string, StoredVerdict][] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter((e): e is [string, StoredVerdict] => e[1] === "open" || e[1] === "closed");
  } catch {
    return [];
  }
}

/**
 * Read the row once and persist every later change through `store`. A refused or locked keystore
 * reads as no verdicts at all, so every first paint asks — the answer that costs a wait, never mail.
 */
export function bindAccessVerdicts(store: SecureKV): Promise<void> {
  if (loading !== null) return loading;
  kv = store;
  loading = (async () => {
    try {
      // A verdict recorded while the row was being read is newer than the row.
      for (const [pairing, v] of decode(await store.get(ACCESS_VERDICT_KEY))) {
        if (!held.has(pairing)) held.set(pairing, v);
      }
    } catch { /* no verdicts: the first paint asks */ }
    ready = true;
  })();
  return loading;
}

/** Has the row been read — or is there no row to read? `false` only while the read is in flight. */
export function verdictsReady(): boolean {
  return loading === null || ready;
}

/** Resolves once {@link verdictsReady} holds. Never rejects. */
export function verdictsSettled(): Promise<void> {
  return loading ?? Promise.resolve();
}

export function storedVerdict(pairing: string): StoredVerdict | null {
  return held.get(pairing) ?? null;
}

export function recordVerdict(pairing: string, verdict: StoredVerdict): void {
  if (held.get(pairing) === verdict) return;
  held.delete(pairing);
  held.set(pairing, verdict);
  while (held.size > VERDICTS_KEPT) held.delete(held.keys().next().value as string);
  const store = kv;
  if (store === null) return;
  // After the read, and one at a time: the row is written whole, so order is the whole contract.
  writes = writes
    .then(() => verdictsSettled())
    .then(() => store.set(ACCESS_VERDICT_KEY, JSON.stringify(Object.fromEntries(held))))
    .catch(() => undefined);
}

/** Tests only: forget every verdict and the binding. */
export function resetAccessVerdictsForTests(): void {
  held = new Map();
  kv = null;
  loading = null;
  ready = false;
  writes = Promise.resolve();
}
