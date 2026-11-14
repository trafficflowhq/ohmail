import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  LEGACY_MIRROR_DB,
  MIRROR_DB_PREFIX,
  clearAllMirrors,
  mirrorDbName,
  purgeLegacyMirror,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
// From the source, not the barrel: the registry key is internal to the mirror and has no
// product consumer, so widening the package's public surface for one assertion would be the
// wrong trade — and `index.ts` belongs to another slice right now.
import { MIRROR_REGISTRY_PREFIX } from "../src/idb.js";

/**
 * A `localStorage`, because this module is browser-only and the suite runs on node.
 *
 * The mirror registry (`rememberMirror`) is a synchronous durable store — it has to be readable
 * on a browser that will NOT enumerate its databases, which is the whole case it exists for —
 * and `localStorage` is the only thing on the platform that is. Injecting it would mean widening
 * `clearAllMirrors`'s signature for a value the real caller never passes; standing one up here
 * is the same move the file already makes for `IDBFactory`.
 *
 * Without it the registry silently records nothing and the case below reports the earlier
 * account's mirror surviving — which is exactly what it should do, and is how this stub was
 * found to be necessary rather than assumed.
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
Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true });

/** What the mirror registry currently names — one key per name, so this is a scan by prefix. */
function registryNames(): string[] {
  const ls = globalThis.localStorage;
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (!k?.startsWith(MIRROR_REGISTRY_PREFIX)) continue;
    const name = k.slice(MIRROR_REGISTRY_PREFIX.length);
    // `__since` shares the prefix and is not a mirror name — it is the completeness anchor.
    if (name.startsWith("__")) continue;
    out.push(name);
  }
  return out;
}

/** The anchor is written by a fire-and-forget async probe; give it a bounded chance to land. */
async function settled(want: boolean): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const has = registryKeys().some((k) => k.endsWith("__since"));
    if (has === want) return has;
    await new Promise((r) => setTimeout(r, 1));
  }
  return registryKeys().some((k) => k.endsWith("__since"));
}

/** Everything under the registry prefix, anchor included — for clearing between cases. */
function registryKeys(): string[] {
  const ls = globalThis.localStorage;
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k?.startsWith(MIRROR_REGISTRY_PREFIX)) out.push(k);
  }
  return out;
}

/**
 * ONE BROWSER, TWO ACCOUNTS — the leak this store used to have, asserted.
 *
 * `idb.ts` defaulted to a single database name, `ohmail-mirror`, for everyone. Its own
 * option doc said "one mirror per account should use a distinct name" and the web app
 * constructed `new IndexedDbMirrorStore()` with no name at all, so every account that
 * signed in on a given browser opened the SAME database: the same `/sync` cursor and the
 * same persisted records. `/sync` is account-filtered but it only MERGES pages — nothing
 * in the protocol removes a record that belongs to somebody else — so the second account
 * to sign in hydrated the first one's mail out of local storage and rendered it, and then
 * resumed from a cursor that was not theirs.
 *
 * The first test below is that exact sequence. It fails on the old code.
 */

const seeded = () => new FixturesAdapter().sync({ since: "0", limit: 2000 });

/** Every live entity key in a store, as a comparable string. */
const keysOf = (s: IndexedDbMirrorStore): string[] => [...s.snapshot().keys()].sort();

/** Does a database with this name exist and hold anything? */
async function entityCount(factory: IDBFactory, name: string): Promise<number> {
  const store = new IndexedDbMirrorStore({ dbName: name, factory });
  await store.load();
  const n = store.snapshot().size;
  store.close();
  return n;
}

describe("the mirror belongs to an account", () => {
  it("THE REGRESSION: account B never sees account A's mail or cursor", async () => {
    const factory = new IDBFactory();
    const page = await seeded();

    // Account A signs in on this browser and syncs a mailbox.
    const a = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await a.load();
    await a.applyResponse(page);
    expect(a.snapshot().size).toBeGreaterThan(0);
    const aKeys = keysOf(a);
    const aCursor = a.getCursor();
    a.close();

    // Account B signs in on the same browser, with no sync of their own yet.
    const b = new IndexedDbMirrorStore({ owner: "acct-B", factory });
    await b.load();

    expect(b.snapshot().size, "B hydrated A's records").toBe(0);
    expect(keysOf(b)).toEqual([]);
    expect(b.getCursor(), "B resumed from A's cursor and would skip their own history").toBe("0");
    expect(b.maxSeq()).toBe(0);
    expect(aCursor).not.toBe("0"); //  the fixture really did advance A's cursor
    b.close();

    // …and A's mail is still A's when they come back.
    const again = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await again.load();
    expect(keysOf(again)).toEqual(aKeys);
    expect(again.getCursor()).toBe(aCursor);
    again.close();
  });

  it("THE CONTROL: the same sequence against the OLD single name does leak", async () => {
    // Without this, the test above proves only that two empty databases are empty. Here
    // both accounts open `ohmail-mirror` — the name every build before this repair used —
    // and every assertion the regression test makes is inverted. This is the bug, running.
    const factory = new IDBFactory();
    const page = await seeded();

    const a = new IndexedDbMirrorStore({ dbName: LEGACY_MIRROR_DB, factory });
    await a.load();
    await a.applyResponse(page);
    const aKeys = keysOf(a);
    const aCursor = a.getCursor();
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: LEGACY_MIRROR_DB, factory });
    await b.load();
    expect(b.snapshot().size).toBeGreaterThan(0);
    expect(keysOf(b)).toEqual(aKeys); //   B is holding A's mail
    expect(b.getCursor()).toBe(aCursor); // …and resuming from A's cursor
    b.close();
  });

  it("the two accounts are in two DIFFERENT databases, named for them", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    for (const owner of ["acct-A", "acct-B"]) {
      const s = new IndexedDbMirrorStore({ owner, factory });
      await s.load();
      if (owner === "acct-A") await s.applyResponse(page);
      s.close();
    }
    const names = (await factory.databases()).map((d) => d.name).sort();
    expect(names).toEqual([mirrorDbName("acct-A"), mirrorDbName("acct-B")]);
    expect(await entityCount(factory, mirrorDbName("acct-B"))).toBe(0);
    expect(await entityCount(factory, mirrorDbName("acct-A"))).toBeGreaterThan(0);
  });

  it("an UNOWNED store cannot be constructed — there is no default any more", () => {
    // The default (`dbName ?? "ohmail-mirror"`) IS the bug. Removing it has to be a
    // refusal rather than a fallback, or the next caller re-introduces it by omission.
    expect(() => new IndexedDbMirrorStore({ factory: new IDBFactory() })).toThrow(/owner/i);
    expect(() => new IndexedDbMirrorStore({ owner: "  ", factory: new IDBFactory() })).toThrow(/owner/i);
  });

  it("a database stamped with somebody else is WIPED, not read", async () => {
    // Unreachable through the name — which is exactly why it is handled. A restored
    // profile, a changed naming scheme, or a database opened by hand all land here.
    const factory = new IDBFactory();
    const page = await seeded();
    const name = mirrorDbName("acct-A");

    const a = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await a.load();
    await a.applyResponse(page);
    a.close();

    // Same bytes on disk, different claimant.
    const impostor = new IndexedDbMirrorStore({ owner: "acct-B", dbName: name, factory });
    await impostor.load();
    expect(impostor.snapshot().size).toBe(0);
    expect(impostor.getCursor()).toBe("0");
    impostor.close();

    // …and the wipe is durable: A's records are gone from that database for good, rather
    // than merely hidden from the instance that refused them.
    expect(await entityCount(factory, name)).toBe(0);
  });

  it("the ownership stamp is never handed back as application meta", async () => {
    const factory = new IDBFactory();
    const s = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await s.load();
    await s.setMeta("theme", "dark");
    s.close();

    const again = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await again.load();
    expect(again.getMeta("theme")).toBe("dark");
    expect(again.getMeta("__owner")).toBeUndefined();
    again.close();
  });

  it("a re-bootstrap wipe leaves the database OWNED, not empty and claimable", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const s = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await s.load();
    await s.applyResponse(page);
    await s.resetForBootstrap(); //   the 410 cursor-expired path
    s.close();

    // If the stamp had been cleared with everything else, B could take this database over
    // silently. It must still refuse — and prove it by wiping rather than reading.
    const b = new IndexedDbMirrorStore({ owner: "acct-B", dbName: mirrorDbName("acct-A"), factory });
    await b.load();
    expect(b.snapshot().size).toBe(0);
    b.close();

    const a2 = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await a2.load();
    await a2.applyResponse(page);
    expect(a2.snapshot().size).toBeGreaterThan(0);
    a2.close();
  });

  it("the mail a re-bootstrap writes after its wipe is still the account's: another claimant reads none of it", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const s = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await s.load();
    await s.applyResponse(page);
    await s.resetForBootstrap(); //   the 410 cursor-expired path
    await s.applyResponse(page); //   …and the bootstrap that follows it, on the same open store
    expect(s.snapshot().size).toBeGreaterThan(0);
    s.close();

    // The same bytes, another claimant: a database left unowned by the wipe would be claimed and read.
    const b = new IndexedDbMirrorStore({ owner: "acct-B", dbName: mirrorDbName("acct-A"), factory });
    await b.load();
    expect(b.snapshot().size, "B read the mail A synced after its re-bootstrap").toBe(0);
    expect(b.getCursor()).toBe("0");
    b.close();
  });
});

describe("what is left behind on the origin", () => {
  it("the pre-repair database is DELETED, not inherited", async () => {
    // Renaming forward is not enough on its own: whatever the last account to use this
    // browser left in `ohmail-mirror` is still on disk and still readable by anything on
    // this origin — the same material the rename exists to prevent.
    const factory = new IDBFactory();
    const page = await seeded();
    const legacy = new IndexedDbMirrorStore({ dbName: LEGACY_MIRROR_DB, factory });
    await legacy.load();
    await legacy.applyResponse(page);
    legacy.close();
    expect((await factory.databases()).map((d) => d.name)).toContain(LEGACY_MIRROR_DB);

    await purgeLegacyMirror(factory);

    expect((await factory.databases()).map((d) => d.name)).not.toContain(LEGACY_MIRROR_DB);
    expect(LEGACY_MIRROR_DB).toBe("ohmail-mirror"); //   the name every old build used
  });

  it("signing out clears every mirror on the origin", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    for (const owner of ["acct-A", "acct-B"]) {
      const s = new IndexedDbMirrorStore({ owner, factory });
      await s.load();
      await s.applyResponse(page);
      s.close();
    }
    const legacy = new IndexedDbMirrorStore({ dbName: LEGACY_MIRROR_DB, factory });
    await legacy.load();
    await legacy.applyResponse(page);
    legacy.close();

    await clearAllMirrors("acct-A", factory);

    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX))).toEqual([]);
  });

  it("clearAllMirrors still deletes the caller's own mirror without databases()", async () => {
    // Firefox shipped `databases()` late and some privacy modes stub it away. A sign-out
    // knows who is signing out, so the case that matters survives the enumeration failing.
    const factory = new IDBFactory();
    const page = await seeded();
    const s = new IndexedDbMirrorStore({ owner: "acct-A", factory });
    await s.load();
    await s.applyResponse(page);
    s.close();

    const blind = Object.create(factory) as IDBFactory;
    Object.defineProperty(blind, "databases", { value: undefined });
    await clearAllMirrors("acct-A", blind);

    expect((await factory.databases()).map((d) => d.name)).not.toContain(mirrorDbName("acct-A"));
  });
});

/**
 * THE WIPE MUST WORK WHILE THE PAGE IS STILL HOLDING THE MIRROR OPEN.
 *
 * Every test above calls `close()` before `clearAllMirrors`, and that is why the real
 * failure survived them: `deleteDatabase` is BLOCKED by any open connection and resolves on
 * `onblocked` by design (hygiene must not hang), so a connection that ignores
 * `versionchange` makes the wipe a silent no-op. The connection that blocks it is normally
 * our own — both the sign-out path and the account-erasure screen run inside the page whose
 * engine holds the mirror.
 *
 * Found by erasing a real account through the product's own screen on ohmail.app and then
 * asking the browser what it still had: the mirror was still on disk, and opening it hung
 * behind the pending delete.
 */
describe("clearAllMirrors with the store still open", () => {
  it("deletes the mirror even though the engine never closed it", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const store = new IndexedDbMirrorStore({ owner: "acct-Z", factory });
    await store.load();
    await store.applyResponse(page);
    expect(store.snapshot().size).toBeGreaterThan(0);

    // NO `store.close()` — that is the whole point. This is the state a browser is in at the
    // moment somebody presses "erase my account".
    await clearAllMirrors("acct-Z", factory);

    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)),
      "the mail is still on this machine").toEqual([]);
  });

  it("and the store knows its handle is gone, so a later read reopens rather than throws", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-Y", factory });
    await store.load();
    await clearAllMirrors("acct-Y", factory);
    // A page that lingers after the wipe (ours shows a confirmation before navigating) must
    // not throw `InvalidStateError` on a closed connection.
    await expect(store.load()).resolves.not.toThrow();
    expect(store.snapshot().size).toBe(0);
    store.close();
  });
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A TAKE-BACK THAT DID NOT HAPPEN MUST NOT REPORT THAT IT DID
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The case above covered OUR OWN page holding the mirror: the store's
 * `onversionchange` yields and the delete proceeds. The half it left open is the one nobody
 * can fix from inside this page — ANOTHER connection that does not yield. A tab opened before
 * this build shipped has no `onversionchange` handler at all; a suspended or busy background
 * tab does not run one in time. `deleteDatabase` then fires `onblocked`, the database stays on
 * disk with the mail in it, and `clearAllMirrors` used to resolve exactly as it does on
 * success — so `signOut` told somebody on a borrowed computer that their mail was gone.
 *
 * `clearAllMirrors` now answers the names that are STILL THERE plus whether the browser could be
 * asked at all, and an empty list from a COMPLETE inventory is the only thing that means "this
 * browser holds no mirror".
 *
 * WATCHED RED, and the honest version of that sentence: the fix has TWO independent halves —
 * `deleteDatabase` reporting `blocked`, and the `databases()` read-back after the deletes — and
 * removing EITHER one alone leaves the first case green, because the other still catches it.
 * Restoring BOTH (`onblocked → "deleted"` plus no read-back), which is the pre-fix code
 * verbatim, is what turns it red: a clean wipe reported over a database the test then reads the
 * mail out of. Belt and braces, said as belt and braces rather than as one guard.
 */
describe("the wipe reports what it could not delete", () => {
  it("a connection that does not yield BLOCKS the delete, and the name comes back as remaining", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const store = new IndexedDbMirrorStore({ owner: "acct-T", factory });
    await store.load();
    await store.applyResponse(page);
    const seededCount = store.snapshot().size;
    expect(seededCount).toBeGreaterThan(0);
    store.close();

    // THE OTHER TAB. A raw connection with no `onversionchange` — the shape a tab from an
    // older build has, and the one this page cannot talk out of holding the database.
    const name = mirrorDbName("acct-T");
    const squatter = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const wipe = await clearAllMirrors("acct-T", factory);
    expect(wipe.remaining).toContain(name);
    // The browser CAN be asked here, so the verdict is complete — the survivor is a fact, not
    // an admission of ignorance. The two are different states and read differently on screen.
    expect(wipe.inventory).toBe("complete");

    // And it is not pessimism: the mail really is still there, read through the connection
    // that is doing the blocking. (A FRESH `open()` cannot be used to check — it would queue
    // behind the pending delete and hang, which is the same fact from the other side.)
    expect((await factory.databases()).map((d) => d.name)).toContain(name);
    const stillHolds = await new Promise<number>((resolve, reject) => {
      const req = squatter.transaction("entities", "readonly").objectStore("entities").count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(stillHolds).toBe(seededCount);

    // Close the other tab and press again — the remedy the copy names, and it works. The
    // blocked delete above completes the moment the connection goes, so this is the state a
    // second press meets.
    squatter.close();
    expect((await clearAllMirrors("acct-T", factory)).remaining).toEqual([]);
    expect((await factory.databases()).map((d) => d.name)).not.toContain(name);
  });

  it("an ordinary wipe answers an EMPTY list — the honest report is not a permanent alarm", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const store = new IndexedDbMirrorStore({ owner: "acct-U", factory });
    await store.load();
    await store.applyResponse(page);
    // Left open on purpose: our own handle yields, which is the property, and it must not
    // now be reported as a survival by the stricter answer.
    expect((await clearAllMirrors("acct-U", factory)).remaining).toEqual([]);
  });

  it("enumeration may only ADD a survivor: a stale listing cannot clear a known `blocked`", async () => {
    // The read-back used to DELETE a name the second enumeration did not list, which made
    // `databases()` outrank a direct `onblocked` — and it is the weaker witness of the two. It
    // is specified to answer databases "in this origin", implementations have shipped it stale
    // or partial, and a name missing from it is not evidence the database is gone; `onblocked`
    // IS evidence the delete did not happen. Trusting the weaker one handed `signOut` a clean
    // `cleared: true` over a mirror another tab was still holding — the defect this function
    // was changed to close, reintroduced by its own verification.
    const factory = new IDBFactory();
    const page = await seeded();
    const store = new IndexedDbMirrorStore({ owner: "acct-W", factory });
    await store.load();
    await store.applyResponse(page);
    store.close();

    const name = mirrorDbName("acct-W");
    const squatter = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // A browser whose enumeration answers EMPTY while the database is demonstrably there —
    // stale, partial, or simply a different reading of "in this origin".
    const lying = Object.create(factory) as IDBFactory;
    Object.defineProperty(lying, "databases", { value: async () => [] });

    expect((await clearAllMirrors("acct-W", lying)).remaining,
      "a stale listing must not erase a blocked delete from the verdict").toContain(name);
    squatter.close();
  });

  it("without databases(), an EARLIER account's mirror is still deleted, not just reported gone", async () => {
    // The delete set was the legacy name plus the caller's own mirror, and on an engine with no
    // `databases()` that was the whole of it — while the function answered `[]`, i.e. "this
    // browser holds no mail", over a database it had never even named. `sign-out.ts` promises
    // this browser forgets "including whatever an earlier account left behind"; there, it did
    // not, and said it had.
    const factory = new IDBFactory();
    const page = await seeded();

    // Account A signs in and out on this browser at some point in the past…
    const a = new IndexedDbMirrorStore({ owner: "acct-OLD", factory });
    await a.load();
    await a.applyResponse(page);
    a.close();
    // …then account B signs in on the same browser.
    const b = new IndexedDbMirrorStore({ owner: "acct-NEW", factory });
    await b.load();
    b.close();

    const blind = Object.create(factory) as IDBFactory;
    Object.defineProperty(blind, "databases", { value: undefined });
    const wipe = await clearAllMirrors("acct-NEW", blind);
    expect(wipe.remaining).toEqual([]);
    // The registry IS readable here, so the empty list is evidence rather than ignorance.
    expect(wipe.inventory).toBe("complete");

    // The claim is now true: A's database is GONE, not merely unmentioned.
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)),
      "an earlier account's mail is still on this machine").toEqual([]);
    // …and the registry is swept with them, so it cannot grow without bound.
    expect(registryNames()).toEqual([]);
  });

  it("without databases() the delete's own outcome stands — an unavailable read-back is not a survival", async () => {
    // Firefox shipped `databases()` late and some privacy modes stub it away. A browser that
    // cannot be asked what it holds must not have every sign-out reported as blocked.
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-V", factory });
    await store.load();
    store.close();
    const blind = Object.create(factory) as IDBFactory;
    Object.defineProperty(blind, "databases", { value: undefined });
    expect((await clearAllMirrors("acct-V", blind)).remaining).toEqual([]);
  });

  it("a name the SECOND listing reveals is reported, even though this call never tried it", async () => {
    // The read-back was scoped to the names this call attempted, which assumed the delete set
    // was the whole inventory — the assumption a partial first enumeration has already broken.
    // A listing that is partial on the first call and complete on the second surfaces a mirror
    // older than the registry, and it would have been reported absent because it was never
    // attempted. A name the browser says is there is there, whoever asked for it.
    const factory = new IDBFactory();
    const page = await seeded();
    const stranger = new IndexedDbMirrorStore({ owner: "acct-STRANGER", factory });
    await stranger.load();
    await stranger.applyResponse(page);
    stranger.close();
    // Forget it the way an install that predates the registry would have.
    for (const k of registryKeys()) globalThis.localStorage.removeItem(k);

    const mine = new IndexedDbMirrorStore({ owner: "acct-ME", factory });
    await mine.load();
    mine.close();

    let call = 0;
    const partialFirst = Object.create(factory) as IDBFactory;
    Object.defineProperty(partialFirst, "databases", {
      // First listing hides the stranger (partial); the read-back sees everything.
      value: async () => {
        call += 1;
        const all = await factory.databases();
        return call === 1 ? all.filter((d) => d.name !== mirrorDbName("acct-STRANGER")) : all;
      },
    });

    const wipe = await clearAllMirrors("acct-ME", partialFirst);
    expect(wipe.remaining, "a late discovery must block the clean verdict")
      .toContain(mirrorDbName("acct-STRANGER"));
  });

  it("two tabs first-opening different mirrors cannot erase each other's name", async () => {
    // The registry was ONE JSON array, read-modify-written on first open. localStorage is shared
    // across every tab and offers no atomic update, so two tabs opening different mirrors at once
    // both read the same list and the second write erased the first's name — ordinary multi-tab
    // use, defeating the registry's one purpose on exactly the browsers it exists for.
    const factory = new IDBFactory();
    for (const k of registryKeys()) globalThis.localStorage.removeItem(k);

    // INTERLEAVED, the way two tabs actually are: both read, then both write.
    const a = new IndexedDbMirrorStore({ owner: "acct-TAB-A", factory });
    const b = new IndexedDbMirrorStore({ owner: "acct-TAB-B", factory });
    await Promise.all([a.load(), b.load()]);
    a.close();
    b.close();

    expect(registryNames().sort())
      .toEqual([mirrorDbName("acct-TAB-A"), mirrorDbName("acct-TAB-B")].sort());

    // …and the consequence that made it a finding: on a browser with no `databases()`, signing
    // out of B must still take A's database with it.
    const blind = Object.create(factory) as IDBFactory;
    Object.defineProperty(blind, "databases", { value: undefined });
    expect((await clearAllMirrors("acct-TAB-B", blind)).remaining).toEqual([]);
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX))).toEqual([]);
  });

  it("a registry whose WRITES are refused cannot certify a clean browser", async () => {
    // The registry is best-effort by design (a private mode refuses storage), so an EMPTY one is
    // indistinguishable from one that was never writable — and on a browser with no
    // `databases()` that emptiness was being read as "there is nothing else here". The probe in
    // `registryReadable` is what tells the two apart, and this is the case it exists for.
    const factory = new IDBFactory();
    const held = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { length: 0, key: () => null, getItem: () => null,
        setItem: () => { throw new Error("quota"); }, removeItem: () => undefined, clear: () => undefined },
    });
    try {
      const store = new IndexedDbMirrorStore({ owner: "acct-Q", factory });
      await store.load(); // `rememberMirror` refuses, silently, exactly as designed
      store.close();
      const blind = Object.create(factory) as IDBFactory;
      Object.defineProperty(blind, "databases", { value: undefined });
      expect((await clearAllMirrors("acct-Q", blind)).inventory).toBe("partial");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: held, configurable: true });
    }
  });

  it("an origin that already held a mirror never earns a COMPLETE verdict", async () => {
    // Enumeration is trusted for what it SHOWS and not for what it OMITS, so a `databases()`
    // call that resolves cannot prove there is nothing else — and the database it would omit is
    // exactly the one created before this build: an earlier account's. Completeness therefore
    // rests on the registry, and the registry is only authoritative on an origin it has named
    // every mirror of since before the first one existed.
    const factory = new IDBFactory();
    for (const k of registryKeys()) globalThis.localStorage.removeItem(k);

    // A PRE-REGISTRY mirror: created without the registry ever hearing about it.
    const old = new IndexedDbMirrorStore({ owner: "acct-BEFORE", factory });
    await old.load();
    old.close();
    for (const k of registryKeys()) globalThis.localStorage.removeItem(k);

    // The new account opens on the same origin. The anchor must NOT be set — the browser can
    // see another mirror already there.
    const mine = new IndexedDbMirrorStore({ owner: "acct-AFTER", factory });
    await mine.load();
    mine.close();
    expect(await settled(false),
      "an origin with a pre-registry mirror may not be anchored").toBe(false);

    const wipe = await clearAllMirrors("acct-AFTER", factory);
    expect(wipe.inventory, "no anchor, no completeness claim").toBe("partial");
  });

  it("an origin whose FIRST mirror is registry-named earns it, and keeps it", async () => {
    const factory = new IDBFactory();
    for (const k of registryKeys()) globalThis.localStorage.removeItem(k);

    const first = new IndexedDbMirrorStore({ owner: "acct-FIRST", factory });
    await first.load();
    first.close();
    expect(await settled(true),
      "an origin the browser reports as otherwise empty is anchored").toBe(true);

    const wipe = await clearAllMirrors("acct-FIRST", factory);
    expect(wipe.remaining).toEqual([]);
    expect(wipe.inventory).toBe("complete");

    // …and the anchor SURVIVES the wipe, because it is a fact about the ORIGIN's history and
    // not about what is on it right now. It was not surviving: `registry()` read `__since` as a
    // mirror name, so the sweep removed it and no origin could ever reach a second complete
    // verdict. `__`-prefixed members are the registry's own bookkeeping now.
    expect(registryKeys().some((k) => k.endsWith("__since"))).toBe(true);
    expect((await clearAllMirrors("acct-FIRST", factory)).inventory,
      "and a second wipe is complete too").toBe("complete");
  });

  it("a tab whose FIRST open lands after the wipe is fenced too", async () => {
    // `versionchange` reaches CONNECTIONS. A store that exists but has not opened yet gets
    // nothing: tab B constructs its engine, tab A signs out and deletes everything it can see,
    // and then tab B's first `open()` — after the final read-back — CREATES the database again
    // and starts writing, while tab A has already been told the browser is clean. Ordinary
    // second-tab timing, and no care inside the delete can see it, because at delete time there
    // is nothing to send an event to.
    const factory = new IDBFactory();
    const page = await seeded();

    // Tab B's store EXISTS before the sign-out and has never opened.
    const late = new IndexedDbMirrorStore({ owner: "acct-LATE", factory });

    // Tab A signs out. It cannot even name acct-LATE — no database, no registry entry.
    const wipe = await clearAllMirrors("acct-LATE", factory);
    expect(wipe.remaining).toEqual([]);

    // Tab B now boots. It must not create the database.
    await expect(late.load()).resolves.not.toThrow(); // a fenced store reads as empty
    expect(late.snapshot().size).toBe(0);
    await expect(late.applyResponse(page)).rejects.toThrow(/removed by a sign-out/);
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)),
      "a late first open refilled the browser after a clean verdict").toEqual([]);

    // …and a store built AFTER the wipe is not fenced — that is a fresh sign-in, not a ghost.
    const fresh = new IndexedDbMirrorStore({ owner: "acct-LATE", factory });
    await fresh.load();
    await expect(fresh.applyResponse(page)).resolves.not.toThrow();
    fresh.close();
  });

  it("a browser that can be asked NEITHER way admits its inventory is partial", async () => {
    // No databases(), no usable storage for the registry: the delete set is the legacy name plus
    // the caller's own mirror, so an empty list means "the two names I knew are gone", not "this
    // browser holds no mail". Reporting that as a clean wipe is the shape this all exists to stop.
    const factory = new IDBFactory();
    const blind = Object.create(factory) as IDBFactory;
    Object.defineProperty(blind, "databases", { value: undefined });

    const held = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined },
      configurable: true,
    });
    try {
      const wipe = await clearAllMirrors("acct-BLIND", blind);
      expect(wipe.remaining).toEqual([]);
      expect(wipe.inventory, "an empty list from a browser that cannot be asked is not a clean browser")
        .toBe("partial");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: held, configurable: true });
    }
  });

  it("a deleted mirror cannot be RECREATED by another live tab", async () => {
    // Every modern tab of this app runs the same `onversionchange` handler and yields, so the
    // ordinary two-tab sign-out does not even produce a `blocked`: both close, the delete
    // succeeds, the verdict is clean — and then the other tab's next drain calls `open()`,
    // recreates the database and writes mail back into it. The person was told this browser
    // holds nothing while a live tab was re-filling it.
    const factory = new IDBFactory();
    const page = await seeded();
    const other = new IndexedDbMirrorStore({ owner: "acct-TAB", factory });
    await other.load();
    await other.applyResponse(page);
    expect(other.snapshot().size).toBeGreaterThan(0);

    // Tab A signs out. Tab B's store is left LIVE, exactly as it would be.
    expect((await clearAllMirrors("acct-TAB", factory)).remaining).toEqual([]);

    // Tab B keeps working. The write REFUSES — loudly, because a write that vanished quietly
    // would be the same lie one layer down — and the database is not recreated.
    await expect(other.applyResponse(page)).rejects.toThrow(/removed by a sign-out/);
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)),
      "a live tab recreated the mirror a sign-out had just removed").toEqual([]);

    // …and a lingering page still reads, as empty, rather than throwing (the property).
    await expect(other.load()).resolves.not.toThrow();
    expect(other.snapshot().size).toBe(0);
    other.close();
  });

  it("the erased-account door takes ONE account's mirror: another account's stores keep writing", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const erased = new IndexedDbMirrorStore({ owner: "acct-ERASED", factory });
    await erased.load();
    await erased.applyResponse(page);
    erased.close();
    // Another account on this browser: one store live, one built and not opened yet.
    const live = new IndexedDbMirrorStore({ owner: "acct-STAYS", factory });
    await live.load();
    await live.applyResponse(page);
    const kept = live.snapshot().size;
    const late = new IndexedDbMirrorStore({ owner: "acct-STAYS", factory });

    const wipe = await clearAllMirrors("acct-ERASED", factory, { only: true });

    expect(wipe, "one account's erasure answered for the whole browser").toEqual({ remaining: [], inventory: "complete" });
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)), "the erasure took a mirror that was not its own")
      .toEqual([mirrorDbName("acct-STAYS")]);
    // No fence fell on the other account: its live store writes, and one that opens only now reads its mail.
    await expect(live.applyResponse(page)).resolves.not.toThrow();
    await late.load();
    expect(late.snapshot().size, "the other account's first open after the erasure read an empty mirror").toBe(kept);
    await expect(late.applyResponse(page)).resolves.not.toThrow();
    live.close();
    late.close();
  });

  it("…and the erased account's own store, left live in another tab, cannot write the mirror back", async () => {
    const factory = new IDBFactory();
    const page = await seeded();
    const other = new IndexedDbMirrorStore({ owner: "acct-ERASED", factory });
    await other.load();
    await other.applyResponse(page);

    expect((await clearAllMirrors("acct-ERASED", factory, { only: true })).remaining).toEqual([]);

    await expect(other.applyResponse(page)).rejects.toThrow(/removed by a sign-out/);
    const left = (await factory.databases()).map((d) => d.name ?? "");
    expect(left.filter((n) => n.startsWith(MIRROR_DB_PREFIX)), "a live tab recreated the erased account's mirror").toEqual([]);
    other.close();
  });
});
