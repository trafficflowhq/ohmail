import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, consentPartition, ohboxView, presentationReader, screenerSegments, senderKey,
  type EngineAdapter,
  type MessageBodyRecord,
  type ScreenerWaitingWire,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ONE RECEIPT TAKES A WHOLE MAILBOX OUT OF THE MIRROR.
 *
 * The server emits a single `mailbox` delete when a mailbox's mail is taken off the store — the
 * standalone install's removal and the hosted account's erasure both write it (`change-log.ts`,
 * the `"mailbox"` member of `EntityType`). Before it existed a removal deleted the rows on the
 * server and told no client: the window went on rendering the removed mailbox's messages, their
 * cached bodies and its unsent draft after the removal had reported success.
 *
 * What is under test here is the CASCADE, at the store, where it has to be atomic with the page.
 * The end-to-end walk — a real sidecar, two mailboxes, the window's own engine — is
 * `apps/sidecar/test/multi-mailbox.test.ts`, "REMOVING #2 TAKES IT OUT OF THE WINDOW'S MIRROR".
 *
 * MUTATION-WATCH (edit the source, watch, restore):
 *  · drop the `cascadeMailboxRemoval` call from `applyResponse` (`store.ts`) → the first case
 *    goes red with the removed mailbox's two messages and its draft still live.
 *  · make the second pass skip `message_body` → "the body of a removed mailbox's message" goes
 *    red with the cached text still readable.
 *  · key the first pass on the record TYPE rather than on `mailboxId` → "the mailbox that stays"
 *    goes red, because every mailbox's rows would go.
 */

const KEPT = "mb-kept";
const GONE = "mb-gone";

const iso = (): string => new Date("2026-09-13T00:00:00.000Z").toISOString();

function change(type: string, id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) } as SyncChange;
}

function message(id: string, mailboxId: string): SyncChange {
  return change("message", id, "create", seqOf(id), {
    id, accountId: "acct", mailboxId, threadId: "th-1", messageIdHeader: `<${id}@t>`,
    subject: id, from: { name: null, address: "a@b.test" }, to: [], cc: [],
    date: iso(), folder: "INBOX", snippet: "", unread: true,
  });
}

/** Stable, distinct seqs from the fixture ids, so a case never has to count. */
const SEQS: Record<string, number> = { "m-gone-1": 1, "m-gone-2": 2, "m-kept-1": 3 };
const seqOf = (id: string): number => SEQS[id] ?? 1;

/** A mirror holding two mailboxes: two messages and a draft each, plus one shared thread. */
async function seeded(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyResponse({
    changes: {
      creates: [
        change("thread", "th-1", "create", 4, { id: "th-1", subject: "both", participants: [] }),
        message("m-gone-1", GONE),
        message("m-gone-2", GONE),
        message("m-kept-1", KEPT),
        change("draft", "d-gone", "create", 5, { id: "d-gone", mailboxId: GONE, subject: "later", body: "" }),
        change("draft", "d-kept", "create", 6, { id: "d-kept", mailboxId: KEPT, subject: "later", body: "" }),
        change("folder", "f-gone", "create", 7, { id: "f-gone", name: "Acme", mailboxId: GONE, mailbox: "gone@t" }),
        change("folder", "f-kept", "create", 8, { id: "f-kept", name: "Acme", mailboxId: KEPT, mailbox: "kept@t" }),
        /* ACCOUNT-SCOPED ROWS, here to be left alone — see the case that reads them back. */
        change("rule", "r-1", "create", 9, { id: "r-1", match: "a@b.test", destination: "INBOX" }),
        change("tag", "t-1", "create", 10, { id: "t-1", name: "Later", hue: "amber" }),
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: "8", hasMore: false, serverTime: iso(),
  });
  /* The cached bodies, written the way an open writes them: client-local records at seq 0. */
  for (const id of ["m-gone-1", "m-gone-2", "m-kept-1"]) {
    await store.putLocal("message_body", id, { messageId: id, state: "ready", text: `text of ${id}` });
  }
  return store;
}

/** The receipt, as `SyncService` puts it on the wire: a delete with no entity. */
const receipt = (seq = 9): SyncChange => change("mailbox", GONE, "delete", seq);

const idsOf = (store: MemoryMirrorStore, type: string): string[] =>
  store.entries<{ id?: string }>(type).map((e) => e.id).sort();

describe("a mailbox removal receipt cascades through the mirror", () => {
  it("takes every row keyed by that mailbox, and its cached bodies with them", async () => {
    const store = await seeded();
    await store.applyResponse({
      changes: { creates: [], updates: [], moves: [], deletes: [receipt()] },
      cursor: "9", hasMore: false, serverTime: iso(),
    });

    expect(idsOf(store, "message"), "the window still renders the removed mailbox's mail")
      .toEqual(["m-kept-1"]);
    expect(idsOf(store, "draft"), "the removed mailbox's unsent draft is still here")
      .toEqual(["d-kept"]);
    expect(idsOf(store, "folder"), "the rail still sections a mailbox that is gone")
      .toEqual(["f-kept"]);
    expect(
      store.get<MessageBodyRecord>("message_body", "m-gone-1"),
      "the body of a removed mailbox's message is still readable in the mirror",
    ).toBeUndefined();
    expect(
      store.get<MessageBodyRecord>("message_body", "m-kept-1")?.text,
      "the cascade shed a body belonging to the mailbox that stays",
    ).toBe("text of m-kept-1");
    /* THE THREAD STAYS. Threads are account-scoped and one conversation can hold a sibling
       mailbox's messages, which is why the server's wipe keeps a shared one — and the receipt
       names no thread, so this cascade cannot tell a shared thread from an exclusive one. */
    expect(idsOf(store, "thread"), "the cascade took an account-scoped thread").toEqual(["th-1"]);
    /* AND THE MAILBOX ROW ITSELF is a tombstone, which is `applyToRecords`' own doing. */
    expect(store.get("mailbox", GONE)).toBeUndefined();
  });

  it("leaves every row the server's own wipe leaves — rules and tags are account-scoped", async () => {
    /*
     * STRUCTURAL IS NOT INDISCRIMINATE, and this is the assertion that says so. The cascade keys
     * on a top-level `mailboxId`, which today is carried by exactly the three entities the
     * server's wipe empties — message, draft, folder. Rules and tags are the account's, kept by
     * `wipeLocalMirror` on purpose (its own list says so), so a mirror that dropped them would
     * disagree with the store it mirrors until a re-bootstrap.
     *
     * It is also the case that reddens if a future DTO gains a `mailboxId` the server's wipe does
     * not honour: the rule and the tag are the nearest rows to that mistake.
     */
    const store = await seeded();
    await store.applyResponse({
      changes: { creates: [], updates: [], moves: [], deletes: [receipt()] },
      cursor: "11", hasMore: false, serverTime: iso(),
    });
    expect(idsOf(store, "rule"), "the cascade took an account-scoped rule").toEqual(["r-1"]);
    expect(idsOf(store, "tag"), "the cascade took an account-scoped tag").toEqual(["t-1"]);
  });

  it("is idempotent: the same receipt twice leaves the same mirror", async () => {
    const once = await seeded();
    const twice = await seeded();
    const page = {
      changes: { creates: [], updates: [], moves: [], deletes: [receipt()] },
      cursor: "9", hasMore: false, serverTime: iso(),
    };
    await once.applyResponse(page);
    await twice.applyResponse(page);
    await twice.applyResponse(page);
    const shape = (s: MemoryMirrorStore): string =>
      JSON.stringify([...s.snapshot().entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(shape(twice)).toBe(shape(once));
  });

  it("a receipt for a mailbox this mirror does not hold takes nothing", async () => {
    const store = await seeded();
    const before = store.entries("message").length + store.entries("draft").length;
    await store.applyResponse({
      changes: { creates: [], updates: [], moves: [], deletes: [change("mailbox", "mb-stranger", "delete", 9)] },
      cursor: "9", hasMore: false, serverTime: iso(),
    });
    expect(store.entries("message").length + store.entries("draft").length).toBe(before);
  });

  it("a REPLAYED page whose receipt was already applied cascades nothing a second time", async () => {
    /* The seq guard is what decides, and the cascade reads `applyToRecords`' accepted set rather
       than the raw page: a replay is refused there, so it must cascade nothing. The observable is
       a page applied BETWEEN the receipt and its replay — a cascade reading the raw page would
       run again over a mirror that has moved on. */
    const store = await seeded();
    const page = {
      changes: { creates: [], updates: [], moves: [], deletes: [receipt()] },
      cursor: "9", hasMore: false, serverTime: iso(),
    };
    await store.applyResponse(page);
    await store.applyResponse({
      changes: { creates: [message("m-kept-2", KEPT)], updates: [], moves: [], deletes: [] },
      cursor: "10", hasMore: false, serverTime: iso(),
    });
    await store.applyResponse(page); // the replay
    expect(idsOf(store, "message"), "the replayed receipt took a row it never named")
      .toEqual(["m-kept-1", "m-kept-2"]);
  });
});

describe("a draft the removal keeps is announced after its receipt, and survives it", () => {
  /* The standalone removal keeps unsent drafts and re-sends each as a `draft` update
     AFTER the receipt. Mutation: drop the `rec.seq > seq` guard in `cascadeMailboxRemoval` and the
     same-page case reads []. */
  const keptDraft = (seq: number): SyncChange =>
    change("draft", "d-gone", "update", seq, { id: "d-gone", mailboxId: GONE, subject: "later", body: "kept words" });

  it("a draft re-sent at receipt+1 in the SAME page survives the cascade", async () => {
    const store = await seeded();
    await store.applyResponse({
      changes: { creates: [], updates: [keptDraft(21)], moves: [], deletes: [receipt(20)] },
      cursor: "21", hasMore: false, serverTime: iso(),
    });
    expect(idsOf(store, "draft"), "the kept draft was taken by the receipt it follows").toEqual(["d-gone", "d-kept"]);
    expect(idsOf(store, "message"), "the receipt took nothing else").toEqual(["m-kept-1"]);
  });

  it("…and in the NEXT page it comes back over the receipt's tombstone", async () => {
    const store = await seeded();
    await store.applyResponse({
      changes: { creates: [], updates: [], moves: [], deletes: [receipt(20)] },
      cursor: "20", hasMore: true, serverTime: iso(),
    });
    expect(idsOf(store, "draft")).toEqual(["d-kept"]);
    await store.applyResponse({
      changes: { creates: [], updates: [keptDraft(21)], moves: [], deletes: [] },
      cursor: "21", hasMore: false, serverTime: iso(),
    });
    expect(idsOf(store, "draft")).toEqual(["d-gone", "d-kept"]);
  });

  it("CONTROL: a draft written at or below the receipt's seq in the same page still goes", async () => {
    const store = await seeded();
    await store.applyResponse({
      changes: { creates: [], updates: [keptDraft(19)], moves: [], deletes: [receipt(20)] },
      cursor: "20", hasMore: false, serverTime: iso(),
    });
    expect(idsOf(store, "draft")).toEqual(["d-kept"]);
  });
});

describe("removing a mailbox leaves the other mailbox's Screener as it was before it was added", () => {
  const NOW = new Date("2026-09-26T08:00:00.000Z");
  const RECENT = "2026-09-25T09:00:00.000Z";
  /** A letter held at the gate of one mailbox: a sender nobody decided. */
  const heldAt = (id: string, mailboxId: string, from: string, seq: number): SyncChange => change("message", id, "create", seq, {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: `<${id}@t>`, subject: id,
    from: { name: null, address: from }, to: [], cc: [], date: RECENT, folder: "ohmail/Screener", snippet: "",
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: RECENT,
  });
  const ownMail: SyncChange[] = [
    heldAt("k-1", KEPT, "ada@stranger.test", 1), heldAt("k-2", KEPT, "ada@stranger.test", 2),
    heldAt("k-3", KEPT, "bo@stranger.test", 3), heldAt("k-4", KEPT, "both@stranger.test", 4),
  ];
  // The added mailbox's own strangers, and one sender who wrote to both.
  const addedMail: SyncChange[] = [
    heldAt("g-1", GONE, "cy@stranger.test", 5), heldAt("g-2", GONE, "both@stranger.test", 6),
    heldAt("g-3", GONE, "dee@stranger.test", 7),
  ];

  /** An engine and its server: `arrives(page)` is what the next drain brings, `queue` the store's own Screener page. */
  async function windowOver(queue?: () => ScreenerWaitingWire) {
    let next: SyncChange[] = [];
    let cursor = 0;
    const adapter = {
      ...(queue ? { screenerWaiting: async () => queue() } : {}),
      sync: async () => {
        const page = next;
        next = [];
        cursor = page.reduce((n, c) => Math.max(n, c.seq), cursor);
        return {
          changes: {
            creates: page.filter((c) => c.op === "create"), updates: [], moves: [],
            deletes: page.filter((c) => c.op === "delete"),
          },
          cursor: String(cursor), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
    await engine.start();
    return { engine, arrives: async (page: SyncChange[]) => { next = page; await engine.syncOnce(); } };
  }
  /** The Screener as the window shows it: each waiting sender and the letters held under the row. */
  const screener = (engine: OhmailEngine) => {
    const raw = engine.read();
    const pres = presentationReader(raw, consentPartition(raw, { now: NOW, ownAddresses: [] }));
    const seg = screenerSegments(pres, NOW, "en", "UTC", []);
    const held = raw.list<{ id: string; mailboxId: string; folder: string; from: { address: string } }>("message")
      .filter((m) => m.folder === "ohmail/Screener");
    const box = ohboxView(pres);
    return {
      total: seg.waitingTotal,
      waiting: seg.waiting.map((row) => senderKey(row.from.address)).sort(),
      held: held.map((m) => m.id).sort(),
      ohbox: [...box.resurfaced, ...box.newForYou, ...box.previouslySeen].map((m) => m.id).sort(),
    };
  };

  it("the count and the rows are the kept mailbox's own again, and the removed one's are gone", async () => {
    const { engine, arrives } = await windowOver();
    await arrives(ownMail);
    const before = screener(engine);
    expect(before.waiting, "the kept mailbox's strangers are not waiting").toEqual(["ada@stranger.test", "bo@stranger.test", "both@stranger.test"]);

    await arrives(addedMail);
    expect(screener(engine).total, "the added mailbox's strangers never reached the Screener").toBe(5);

    await arrives([change("mailbox", GONE, "delete", 8)]);
    expect(screener(engine), "the removal changed the Screener of the mailbox that stays").toEqual(before);
  });

  it("removed with its copy kept: the store's page leaves it out, and its strangers are neither waiting nor let in", async () => {
    // The store's queue, as it answers once the mailbox is removed: the kept mailbox's senders, the whole
    // queue, and the name of the mailbox it left out. The removed mailbox's letters stay in the mirror.
    const waitingAt = (id: string, address: string) =>
      ({ messageId: id, address, name: null, receivedAt: RECENT, subject: id, snippet: "", mailboxId: KEPT });
    let removed = false;
    const queue = (): ScreenerWaitingWire => ({
      items: [waitingAt("k-2", "ada@stranger.test"), waitingAt("k-3", "bo@stranger.test"), waitingAt("k-4", "both@stranger.test")],
      nextCursor: null, total: 3, inFlight: [], ...(removed ? { gone: [GONE] } : {}),
    });
    const { engine, arrives } = await windowOver(queue);
    await arrives(ownMail);
    await engine.refreshScreenerWaiting();
    const before = screener(engine);
    expect({ total: before.total, waiting: before.waiting, ohbox: before.ohbox })
      .toEqual({ total: 3, waiting: ["ada@stranger.test", "bo@stranger.test", "both@stranger.test"], ohbox: [] });

    await arrives(addedMail);
    removed = true;
    await engine.refreshScreenerWaiting();
    const after = screener(engine);
    expect({ total: after.total, waiting: after.waiting }, "the removal changed the Screener of the mailbox that stays")
      .toEqual({ total: before.total, waiting: before.waiting });
    expect(after.ohbox, "a removed mailbox's stranger was read as let in").toEqual([]);
  });
});
