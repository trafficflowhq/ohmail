import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  type MessageBodyRecord,
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
