import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbMirrorStore, clearAllMirrors, mirrorDbName } from "@ohmail/client-engine";

/**
 * THE WIPE ENDS. A blocked `deleteDatabase` stays queued until the connection holding the mirror
 * closes, and a second delete of the same name waits behind it without firing any event at all.
 * So a second Sign out, pressed while a tab that does not yield (a frozen background tab, a tab
 * from an older build) still holds the mirror, awaited `clearAllMirrors` for ever and the pane
 * said "Signing out…" for good. A delete that has not answered within its budget is a database
 * still on disk, reported as such; it is never awaited without end.
 */

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  } as Storage;
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A raw connection with no `onversionchange`: a tab that does not yield the mirror. */
function squat(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Settles `p` against a wall-clock budget: the answer, or `"HUNG"`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "HUNG"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"HUNG">((resolve) => { timer = setTimeout(() => resolve("HUNG"), ms); });
  try {
    return await Promise.race([p, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("clearAllMirrors settles even when a delete never answers", () => {
  it("the second press behind a blocked delete ends, and names the mirror that is still there", async () => {
    const factory = new IDBFactory();
    const name = mirrorDbName("acct-H");
    const store = new IndexedDbMirrorStore({ owner: "acct-H", factory });
    await store.load();
    store.close();
    const holder = await squat(factory, name);

    // The first press: blocked, answered, and left queued in the browser.
    const first = await clearAllMirrors("acct-H", factory);
    expect(first.remaining).toContain(name);

    // The second press, the other tab still holding the mirror: no event will ever fire for it.
    const second = await within(clearAllMirrors("acct-H", factory), 20_000);
    expect(second, "the wipe awaited a delete that never answered — the sign-out never ends").not.toBe("HUNG");
    expect((second as { remaining: string[] }).remaining, "a delete that did not happen was reported done")
      .toContain(name);

    holder.close();
  }, 30_000);

  it("THE CONTROL — once the holder goes, the next press deletes it and answers an empty list", async () => {
    const factory = new IDBFactory();
    const name = mirrorDbName("acct-J");
    const store = new IndexedDbMirrorStore({ owner: "acct-J", factory });
    await store.load();
    store.close();
    const holder = await squat(factory, name);
    expect((await clearAllMirrors("acct-J", factory)).remaining).toContain(name);
    holder.close();
    const again = await within(clearAllMirrors("acct-J", factory), 20_000);
    expect(again).not.toBe("HUNG");
    expect((again as { remaining: string[] }).remaining).toEqual([]);
  }, 30_000);
});
