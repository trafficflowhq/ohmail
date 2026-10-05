/**
 * WHICH SENTENCE A `storage` ROW SAYS — one table, by door and detail, so no arm elsewhere re-spells it.
 * The code is written by three different writers: this computer's engine (a store refusing writes, or a
 * write-off run held over a healthy store), the hosted worker (the provider's OVERQUOTA, its own
 * database) and the Cloud mirror (rows it could not apply, with a count). Only the first is "this
 * computer cannot store mail"; the others keep the sentence they had. The sidecar spells the detail
 * as `STORE_REFUSED_DETAIL` in apps/sidecar/src/engine.ts; the census pins both spellings.
 */
export const STORE_REFUSED_DETAIL = "MAILBOX_STORE_REFUSED";

export type RowDoor = "local" | "cloud" | "paired";
/** `count`: desktopStateStorage · `storeRefused`: desktopStateStoreRefused · `code`: the generic error arm. */
export type StorageSentence = "count" | "storeRefused" | "code";

export function storageRowSentence(door: RowDoor, detail: string | null | undefined, hasCount: boolean): StorageSentence {
  if (hasCount) return "count";
  if (door === "local" && detail === STORE_REFUSED_DETAIL) return "storeRefused";
  return "code";
}
