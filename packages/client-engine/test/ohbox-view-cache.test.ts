import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  ohboxView,
  type EntityReader,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE OHBOX VIEW IS MEMOIZED ON THE READER'S VERSION — the `date-order-cache.test.ts`
 * properties, asked of `ohboxView`. Every uncached call re-filters the whole mirror (measured
 * 2.0 ms at a large mirror on an unchanged version), and before the memo AppShell's `useMemo` was
 * the only shield — any second caller paid the derivation per render. The hit is measured as a
 * COUNT (the second call reads nothing from the mirror and answers the identical object), never
 * as wall time; the stale case is the dangerous direction and gets its own arm.
 */

let seq = 0;

function msg(o: { id: string; date: string; folder?: string; unread?: boolean }): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: (o.folder ?? "INBOX") as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  };
}

const change = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m }) as SyncChange;

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map(change));
  return store;
}

const pile = [
  msg({ id: "a", date: "2026-08-09T09:00:00.000Z", unread: true }),
  msg({ id: "b", date: "2026-08-07T09:00:00.000Z" }),
  msg({ id: "c", date: "2026-08-03T09:00:00.000Z", folder: "ohmail/News" }),
];

describe("ohboxView version memo", () => {
  it("same version ⇒ the identical object, and the hit reads NOTHING from the mirror", async () => {
    const store = await mirrorOf(pile);
    let listCalls = 0;
    /* One reader object (the sibling caches key on it weakly); only `list` is counted. */
    const counted: EntityReader = {
      list: <T,>(type: string) => { listCalls += 1; return store.list<T>(type); },
      get: <T,>(type: string, id: string) => store.get<T>(type, id),
      entries: <T,>(type: string) => store.entries<T>(type),
      version: () => store.version(),
      stampOf: (type: string) => store.stampOf(type),
      stampExcept: (ignore: readonly string[]) => store.stampExcept(ignore),
    };
    const first = ohboxView(counted);
    const paid = listCalls;
    expect(paid, "the first derivation must read the mirror — a zero here is a broken counter")
      .toBeGreaterThan(0);
    const second = ohboxView(counted);
    expect(second, "same reader, same version — the memoized object, not a re-derivation").toBe(first);
    expect(listCalls, "the hit paid a mirror read").toBe(paid);
    expect(first.newForYou.map((m) => m.id)).toEqual(["a"]);
  });

  it("never serves a stale version: a bump re-derives and the new row is present", async () => {
    const store = await mirrorOf(pile);
    const before = ohboxView(store);
    await store.applyChanges([change(msg({ id: "e", date: "2026-08-10T09:00:00.000Z", unread: true }))]);
    const after = ohboxView(store);
    expect(after).not.toBe(before);
    expect(after.newForYou.map((m) => m.id)).toEqual(["e", "a"]);
    // …and the stale copy was not mutated in place (a caller may still hold it).
    expect(before.newForYou.map((m) => m.id)).toEqual(["a"]);
  });
});
