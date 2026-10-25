/**
 * A VERB QUEUED BY A CLOSED TAB IS DELIVERED BY A LIVE ONE, ONCE (QUEUED-SEND-FROM-A-CLOSED-TAB-WAITS-
 * FOR-THE-NEXT-LOAD). Every tab over one account shares the IndexedDB mirror, and each restored the
 * outbox once, at its own boot: a verb queued by a tab that then closed sat on disk until some tab
 * loaded again. Each engine now holds a Web Lock for its life and stamps its entries with the lock's
 * name; a drive adopts the entries whose owner's lock is gone, by a compare-and-set inside one
 * write transaction, and replays them.
 *
 * Left alone, on purpose: a live owner's entry, an entry with no owner (an older build's), and every
 * entry when this engine has no locks to ask (a webview without them, the phone's own store).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import {
  CursorExpiredError,
  DEMO_NOW,
  FixturesAdapter,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  type EngineAdapter,
  type EngineDraft,
  type EngineLocks,
  type EngineMutation,
} from "@ohmail/client-engine";

const RETRYABLE = () => new MutationRejectedError("network failure: connection reset", { code: "network", retryable: true });
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/** A lock registry shared by every engine of one "browser"; `close(name)` is a tab going away. */
function locks() {
  const held = new Set<string>();
  const api: EngineLocks = {
    async request(name, _opts, cb) { held.add(name); return cb({ name }); },
    async query() { return { held: [...held].map((name) => ({ name })) }; },
  };
  return { api, held, close: (name: string) => { held.delete(name); } };
}

function wire(inner: FixturesAdapter, fail = false) {
  const sent: Array<{ kind: string; key: string }> = [];
  let failing = fail;
  const adapter: EngineAdapter = {
    fetchBody: () => inner.fetchBody(),
    sync: (p: Parameters<EngineAdapter["sync"]>[0]) => inner.sync(p),
    async mutate(m: EngineMutation, o: { idempotencyKey: string }) {
      if (failing) throw RETRYABLE();
      sent.push({ kind: m.kind, key: o.idempotencyKey });
      const out = await inner.mutate(m, o);
      return { changes: [], seq: out.seq };
    },
  } as unknown as EngineAdapter;
  return { adapter, sent, heal: () => { failing = false; } };
}

const MARK: EngineMutation = { kind: "mark_seen", messageIds: ["giulia"], unread: false };
const CREATE: EngineMutation = {
  kind: "draft_save", draftId: null, mailboxId: "mb-milabrunner", inReplyToMessageId: null,
  subject: "draft", body: "adopted words", to: [], cc: [], bcc: [],
};

async function tab(factory: IDBFactory, owner: string, l: EngineLocks | null, w: ReturnType<typeof wire>) {
  const store = new IndexedDbMirrorStore({ owner, factory });
  const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW, locks: l } as never);
  await engine.start();
  return { store, engine };
}

const ownersOnDisk = (store: IndexedDbMirrorStore) =>
  store.entries<{ owner?: string }>(OUTBOX_TYPE).map((e) => e.entity.owner ?? null);

describe("a verb queued by a closed tab is delivered by a live one, once", () => {
  // The key range is a browser global the store reads; fake-indexeddb ships it without installing it.
  beforeAll(() => {
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange;
  });

  it("the dead owner's verb is adopted and delivered, once", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    const wA = wire(new FixturesAdapter(), true);
    const A = await tab(factory, "acct-orphan-1", reg.api, wA);
    const queued = await A.engine.mutate(MARK);
    expect(queued.status).toBe("queued");
    const aName = ownersOnDisk(A.store)[0];
    expect(aName, "the queued entry names no owner, so nothing can tell it was A's").toBeTruthy();
    A.store.close();
    reg.close(aName!);

    const wB = wire(new FixturesAdapter());
    const B = await tab(factory, "acct-orphan-1", reg.api, wB);
    await B.engine.syncOnce();
    await tick();
    expect(wB.sent.filter((s) => s.key === queued.key), "the closed tab's verb was not delivered once").toHaveLength(1);
    B.store.close();
  });

  it("a live owner's verb is left to its owner", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    // B loads first, so its own boot restore cannot see the verb: only adoption could take it.
    const wB = wire(new FixturesAdapter());
    const B = await tab(factory, "acct-orphan-2", reg.api, wB);
    const A = await tab(factory, "acct-orphan-2", reg.api, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(MARK);
    await B.engine.syncOnce();
    await B.engine.syncOnce();
    await tick();
    expect(wB.sent.filter((s) => s.key === queued.key), "a live tab's verb was taken from it").toHaveLength(0);
    A.store.close();
    B.store.close();
  });

  it("an entry that names no owner (an older build's) is left alone", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    // B loads first, so its boot restore cannot see the verb; A writes it with no owner at all.
    const wB = wire(new FixturesAdapter());
    const B = await tab(factory, "acct-orphan-3", reg.api, wB);
    const A = await tab(factory, "acct-orphan-3", null, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(MARK);
    expect(ownersOnDisk(A.store)).toEqual([null]);
    A.store.close();
    await B.engine.syncOnce();
    await B.engine.syncOnce();
    expect(wB.sent.filter((s) => s.key === queued.key), "an owner-less verb was adopted").toHaveLength(0);
    B.store.close();
  });

  it("an engine with NO LOCKS INJECTED adopts nothing — the default branch, where the host has none", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    // B loads BEFORE A queues, so its boot restore cannot see the verb.
    const wB = wire(new FixturesAdapter());
    const Bstore = new IndexedDbMirrorStore({ owner: "acct-orphan-4", factory });
    // No `locks` option at all: the default reads the host's Web Locks, and node has none.
    expect((globalThis as { navigator?: { locks?: unknown } }).navigator?.locks, "this host has Web Locks").toBeUndefined();
    const B = new OhmailEngine({ adapter: wB.adapter, store: Bstore, now: () => DEMO_NOW } as never);
    await B.start();
    const A = await tab(factory, "acct-orphan-4", reg.api, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(MARK);
    const aName = ownersOnDisk(A.store)[0]!;
    A.store.close();
    reg.close(aName);
    await B.syncOnce();
    await B.syncOnce();
    await tick();
    expect(wB.sent.filter((s) => s.key === queued.key), "an engine that cannot ask about owners took a verb").toHaveLength(0);
    Bstore.close();
  });

  it("two live tabs adopt one dead owner's verb: exactly one of them sends it", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    const wB = wire(new FixturesAdapter());
    const wC = wire(new FixturesAdapter());
    const B = await tab(factory, "acct-orphan-5", reg.api, wB);
    const C = await tab(factory, "acct-orphan-5", reg.api, wC);
    const A = await tab(factory, "acct-orphan-5", reg.api, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(MARK);
    const aName = ownersOnDisk(A.store)[0]!;
    A.store.close();
    reg.close(aName);
    await Promise.all([B.engine.syncOnce(), C.engine.syncOnce()]);
    await tick();
    const sends = [...wB.sent, ...wC.sent].filter((s) => s.key === queued.key);
    expect(sends, "the orphan was sent by both tabs, or by neither").toHaveLength(1);
    B.store.close();
    C.store.close();
  });

  it("the 410 shape: the tab that wipes delivers the closed tab's verb", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    const inner = new FixturesAdapter();
    const wB = wire(inner);
    let expire = false;
    const adapterB: EngineAdapter = {
      ...wB.adapter,
      async sync(p) { if (expire) { expire = false; throw new CursorExpiredError(); } return inner.sync(p); },
    } as EngineAdapter;
    const Bstore = new IndexedDbMirrorStore({ owner: "acct-orphan-6", factory });
    const B = new OhmailEngine({ adapter: adapterB, store: Bstore, now: () => DEMO_NOW, locks: reg.api } as never);
    await B.start();
    const A = await tab(factory, "acct-orphan-6", reg.api, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(MARK);
    const aName = ownersOnDisk(A.store)[0]!;
    A.store.close();
    reg.close(aName);
    expire = true;
    await B.syncOnce();
    await B.syncOnce();
    await tick();
    expect(wB.sent.filter((s) => s.key === queued.key), "the wiping tab did not deliver the closed tab's verb").toHaveLength(1);
    Bstore.close();
  });

  it("an adopted create's row carries its key, so a door binds the create and never its local id", async () => {
    const factory = new IDBFactory();
    const reg = locks();
    const A = await tab(factory, "acct-orphan-7", reg.api, wire(new FixturesAdapter(), true));
    const queued = await A.engine.mutate(CREATE);
    expect(queued.status).toBe("queued");
    const aName = ownersOnDisk(A.store)[0]!;
    A.store.close();
    reg.close(aName);
    const B = await tab(factory, "acct-orphan-7", reg.api, wire(new FixturesAdapter(), true));
    await B.engine.syncOnce();
    await tick();
    const row = B.engine.read().list<EngineDraft>("draft").find((d) => d.body === "adopted words");
    expect(row?.pendingCreate, "the adopted create's row carries no key").toBe(queued.key);
    expect(B.engine.pendingCreateOf(row!.id)).toBe(queued.key);
    B.store.close();
  });
});
