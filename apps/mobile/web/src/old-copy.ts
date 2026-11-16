/**
 * THE PHONE'S OLD COPY, TAKEN ONCE, before the engine starts. Native reads the mailbox's old mirror in pages; the page
 * fills only the keys its own copy lacks, so a start that died half-way and runs again adds no row twice. The cursor
 * and the meta are taken only while the page's own cursor is still the first ("0"), and the cursor last of all, so a
 * copy cut short never claims a place in the feed it does not hold. The queue's rows and the letters being written go
 * to the native keeper first (the keeper's store). The old routing journal (the held presses' rows, under the phone's
 * `local` key space) is written into the page's own families under the scope, through the native keeper and then the
 * page's storage. Then native is told, and removes the old copy.
 */
import type { Requests } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { ROUTING_JOURNAL_TYPE, type MirrorRecord } from "./engine-package";
import type { KeptIdbStore } from "./kept-store";
import { isKept } from "../../src/shell/kept-families";

/** What the copy is written into: the page's store, opened and loaded, which persists natively first. */
export type CopyTarget = Pick<KeptIdbStore, "get" | "getCursor" | "adopt">;

interface StorageLike {
  setItem(key: string, value: string): void;
}

/** The phone's own key space suffix, and the scope's in its place. A key outside the kept families is not taken. */
function rescoped(key: string, scope: string): string | null {
  if (!key.endsWith(".local")) return null;
  const next = `${key.slice(0, -".local".length)}.${scope}`;
  return isKept(next) ? next : null;
}

function parsed(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

export async function takeOldCopy(bridge: Bridge, scope: string, store: CopyTarget, storage: StorageLike): Promise<{ rows: number; words: number }> {
  const first = store.getCursor() === "0";
  let after: string | null = null;
  let cursor: string | null = null;
  let meta: [string, unknown][] = [];
  let rows = 0;
  const journal: { key: string; value: string }[] = [];
  do {
    const page: Requests["oldCopy.page"]["answer"] = await bridge.request("oldCopy.page", { scope, after });
    const lacking: MirrorRecord[] = [];
    for (const row of page.entities) {
      const rec = parsed(row.json) as (MirrorRecord & { entity?: { value?: unknown } }) | undefined;
      if (rec === undefined || rec.type !== row.type || rec.id !== row.id) continue;
      if (row.type === ROUTING_JOURNAL_TYPE) {
        const key = rescoped(row.id, scope);
        if (key !== null && typeof rec.entity?.value === "string") journal.push({ key, value: rec.entity.value });
        continue;
      }
      if (store.get(row.type, row.id) !== undefined) continue;
      lacking.push(rec);
    }
    if (after === null && first) {
      for (const [key, value] of page.meta) {
        const read = parsed(value);
        if (key === "cursor") cursor = typeof read === "string" ? read : null;
        else meta.push([key, read]);
      }
    }
    if (lacking.length > 0) await store.adopt(lacking, null, []);
    rows += lacking.length;
    after = page.next;
  } while (after !== null);
  if (first && (cursor !== null || meta.length > 0)) await store.adopt([], cursor, meta);
  meta = [];
  for (const { key, value } of journal) {
    const { kept } = await bridge.request("keep", { key, value });
    if (!kept) throw new Error("the native keeper refused a held press of the old copy");
    storage.setItem(key, value);
  }
  await bridge.request("oldCopy.done", { scope });
  return { rows, words: journal.length };
}
