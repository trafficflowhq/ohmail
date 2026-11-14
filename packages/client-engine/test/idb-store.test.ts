import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  OhmailEngine,
  flattenResponse,
  messagesByDateDesc,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/** IndexedDB persistence: hydrate-on-load, atomic page+cursor, wipe on re-bootstrap. */

function serialize(store: IndexedDbMirrorStore): string {
  const entries = [...store.snapshot().entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

describe("IndexedDbMirrorStore", () => {
  it("persists entities + cursor + meta across instances (page and cursor land together)", async () => {
    const factory = new IDBFactory();
    const resp = await new FixturesAdapter().sync({ since: "0", limit: 2000 });

    const a = new IndexedDbMirrorStore({ dbName: "mirror-a", factory });
    await a.load();
    expect(a.getCursor()).toBe("0");
    await a.applyResponse(resp);
    await a.setMeta("theme", "dark");
    const stateA = serialize(a);
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: "mirror-a", factory });
    await b.load();
    expect(serialize(b)).toBe(stateA);
    expect(b.getCursor()).toBe(resp.cursor);
    expect(b.maxSeq()).toBe(a.maxSeq());
    expect(b.getMeta("theme")).toBe("dark");
    b.close();
  });

  it("re-applying a persisted page (crash-before-cursor replay) converges", async () => {
    const factory = new IDBFactory();
    const resp = await new FixturesAdapter().sync({ since: "0", limit: 2000 });

    const a = new IndexedDbMirrorStore({ dbName: "mirror-b", factory });
    await a.load();
    await a.applyResponse(resp);
    const once = serialize(a);
    // Crash-replay: the same page arrives again (cursor had not advanced).
    await a.applyChanges(flattenResponse(resp));
    await a.applyResponse(resp);
    expect(serialize(a)).toBe(once);
    a.close();
  });

  it("resetForBootstrap wipes persisted state and resets the cursor to 0", async () => {
    const factory = new IDBFactory();
    const resp = await new FixturesAdapter().sync({ since: "0", limit: 2000 });

    const a = new IndexedDbMirrorStore({ dbName: "mirror-c", factory });
    await a.load();
    await a.applyResponse(resp);
    await a.resetForBootstrap();
    expect(a.snapshot().size).toBe(0);
    expect(a.getCursor()).toBe("0");
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: "mirror-c", factory });
    await b.load();
    expect(b.snapshot().size).toBe(0);
    expect(b.getCursor()).toBe("0");
    b.close();
  });

  it("drives a full engine bootstrap and rehydrates without the adapter", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ dbName: "mirror-d", factory });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, syncLimit: 7 });
    await engine.start(); // multi-page drain (hasMore) into IndexedDB
    const persisted = serialize(store);
    expect(store.snapshot().size).toBeGreaterThan(20);
    store.close();

    // Cold start: hydrate the mirror alone — the offline-first read path.
    const rehydrated = new IndexedDbMirrorStore({ dbName: "mirror-d", factory });
    await rehydrated.load();
    expect(serialize(rehydrated)).toBe(persisted);
    expect(rehydrated.getCursor()).toBe(store.getCursor());
    rehydrated.close();
  });

  it("hydration stamps the types — a warm mirror is visible to stamp-keyed derivations (INCIDENT-021)", async () => {
    const factory = new IDBFactory();
    const resp = await new FixturesAdapter().sync({ since: "0", limit: 2000 });

    const a = new IndexedDbMirrorStore({ dbName: "mirror-stamp", factory });
    await a.load();
    await a.applyResponse(resp);
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: "mirror-stamp", factory });
    // The shell renders before load() resolves: this read seeds the date-order cache at stamp
    // 0, exactly as a live tab does on open.
    expect(messagesByDateDesc(b)).toHaveLength(0);
    await b.load();
    const held = b.list<unknown>("message").length;
    expect(held).toBeGreaterThan(0);
    // The incident's split: the bucket read sees the rows while a stamp-keyed cache would keep
    // serving the pre-hydration seed. Hydration must move the stamps with the records.
    expect(b.stampOf("message")).toBeGreaterThan(0);
    expect(messagesByDateDesc(b)).toHaveLength(held);
    b.close();
  });
});
