import { describe, expect, it } from "vitest";
import {
  MIRROR_ENTITY_TYPES,
  MemoryMirrorStore,
  type KnownMirrorEntityType,
  type SyncChange,
} from "../src/index.js";

/**
 * WHAT A MAILBOX RECEIPT TAKES FROM A MIRROR, TYPE BY TYPE (the census half).
 * EXCLUSIVE: the row belongs to one mailbox — keyed by it, or by one of its messages — so the
 * receipt takes the removed mailbox's and keeps the other's. SHARED: the row is the account's,
 * or leaves by its own door, so the receipt keeps it. Total over {@link MIRROR_ENTITY_TYPES} (a
 * `Record`, so `tsc` refuses a type nobody classified) and driven through a real store over each
 * type's real shape. Watched red: the cascade's second pass keyed on the row id alone
 * (`store.ts#cascadeMailboxRemoval`) leaves four message-keyed types behind.
 */

type Seat =
  | { seat: "exclusive"; key: "mailboxId" | "messageId" | "id-is-the-message"; why: string }
  | { seat: "shared"; why: string; notInStore?: true };

const CENSUS: Record<KnownMirrorEntityType, Seat> = {
  message: { seat: "exclusive", key: "mailboxId", why: "the mailbox's own mail" },
  draft: { seat: "exclusive", key: "mailboxId", why: "written from this mailbox; a sibling's reply keeps its text" },
  folder: { seat: "exclusive", key: "mailboxId", why: "the mailbox's own folders" },
  mailbox_profile: { seat: "exclusive", key: "mailboxId", why: "the organizer's rules for this one read mailbox" },
  screener_waiting: {
    seat: "exclusive", key: "mailboxId",
    why: "a waiting sender's row names the mailbox its held mail is in; the next refresh replaces the page",
  },
  screener_sender: { seat: "exclusive", key: "mailboxId", why: "the demo's sender rows, per mailbox" },
  message_body: { seat: "exclusive", key: "id-is-the-message", why: "the cached text of one message" },
  message_state: { seat: "exclusive", key: "messageId", why: "a park on one message" },
  routing_decision: { seat: "exclusive", key: "messageId", why: "a decision about one message" },
  approval: { seat: "exclusive", key: "messageId", why: "a question about one message" },
  screener_suggestion: {
    seat: "exclusive", key: "messageId",
    why: "advice bought about one message; a sender still waiting elsewhere keeps its row, not this chip",
  },
  thread: {
    seat: "shared",
    why: "one conversation can hold several mailboxes' mail; the door announces each exclusive one",
  },
  rule: { seat: "shared", why: "the account's decision about a sender, for every mailbox" },
  tag: { seat: "shared", why: "the account's tag, for every mailbox" },
  mailbox: { seat: "shared", why: "the other mailbox's own row; the removed one's IS the receipt" },
  triage_item: { seat: "shared", why: "the demo's entries with no message behind them" },
  view_meta: { seat: "shared", why: "one row per reading stream, not per mailbox" },
  held_release_group: { seat: "shared", why: "a server derivation per rule, replaced by its own refresh" },
  unscreened_sender_group: { seat: "shared", why: "a server derivation per sender, replaced by its own refresh" },
  outbox_entry: { seat: "shared", why: "a verb this device issued; it leaves on its own outcome" },
  outbox_abandoned: { seat: "shared", why: "a refusal a person has not answered; retired by a newer verb" },
  store_page: {
    seat: "shared", notInStore: true,
    why: "History's pages, in the engine's memory; every visit re-reads the store, and a row the mirror records gone renders nothing",
  },
  calendar_connection: {
    seat: "shared",
    why: "a connection only names the mailbox whose sign-in it rides (`grantMailboxId`); it leaves by its own tombstone",
  },
  calendar: { seat: "shared", why: "a calendar hangs on its connection, never on a mailbox" },
  calendar_event: { seat: "shared", why: "an event hangs on its calendar, never on a mailbox" },
  calendar_suggestion: { seat: "exclusive", key: "mailboxId", why: "an event one letter of this mailbox seems to propose" },
};

const GONE = "mb-gone";
const KEPT = "mb-kept";
const at = "2026-09-26T08:00:00.000Z";

/**
 * EACH TYPE'S ROW AS THE WIRE OR THE ENGINE WRITES IT, for one mailbox — its real key fields,
 * written apart from the seat, so the drive can refute a classification rather than echo it.
 * `null`: never in the store. `local`: written client-side at seq 0, as the engine writes it.
 */
const SHAPE: Record<KnownMirrorEntityType, (mb: string) => { id: string; entity: object; local?: true } | null> = {
  message: (mb) => ({ id: `m-${mb}`, entity: { id: `m-${mb}`, mailboxId: mb, folder: "INBOX", from: { name: null, address: "x@y.test" } } }),
  draft: (mb) => ({ id: `d-${mb}`, entity: { id: `d-${mb}`, mailboxId: mb, subject: "later", body: "" } }),
  folder: (mb) => ({ id: `f-${mb}`, entity: { id: `f-${mb}`, name: "Acme", mailboxId: mb, mailbox: `${mb}@t` } }),
  mailbox_profile: (mb) => ({
    id: mb, entity: { mailboxId: mb, rules: [], asOf: at, from: { kind: null, name: null, since: null }, updatedAt: at },
  }),
  screener_waiting: (mb) => ({
    id: `sender:${mb}@y.test`, local: true,
    entity: {
      id: `sender:${mb}@y.test`, kind: "sender", order: 0, messageId: `m-${mb}`, address: `${mb}@y.test`, name: null,
      receivedAt: at, subject: "s", snippet: "s", mailboxId: mb, total: 1,
    },
  }),
  screener_sender: (mb) => ({ id: `ss-${mb}`, entity: { id: `ss-${mb}`, mailboxId: mb, from: { name: null, address: "x@y.test" } }, local: true }),
  message_body: (mb) => ({ id: `m-${mb}`, entity: { messageId: `m-${mb}`, state: "ready", text: "t" }, local: true }),
  message_state: (mb) => ({ id: `st-${mb}`, entity: { messageId: `m-${mb}`, park: "later" } }),
  routing_decision: (mb) => ({ id: `rd-${mb}`, entity: { id: `rd-${mb}`, messageId: `m-${mb}`, status: "applied" } }),
  approval: (mb) => ({ id: `ap-${mb}`, entity: { id: `ap-${mb}`, messageId: `m-${mb}`, status: "pending" } }),
  screener_suggestion: (mb) => ({ id: `sg-${mb}`, entity: { id: `sg-${mb}`, messageId: `m-${mb}`, senderKey: "x@y.test" } }),
  thread: (mb) => ({ id: `th-${mb}`, entity: { id: `th-${mb}`, subject: "s", messageIds: [`m-${mb}`], participants: [] } }),
  rule: (mb) => ({ id: `r-${mb}`, entity: { id: `r-${mb}`, match: "x@y.test", destination: "INBOX" } }),
  tag: (mb) => ({ id: `t-${mb}`, entity: { id: `t-${mb}`, name: "Later", hue: "amber" } }),
  mailbox: (mb) => ({ id: `other-${mb}`, entity: { id: `other-${mb}`, address: `other-${mb}@t` } }),
  triage_item: (mb) => ({ id: `ti-${mb}`, entity: { id: `ti-${mb}`, title: "t" }, local: true }),
  view_meta: (mb) => ({ id: `vm-${mb}`, entity: { id: `vm-${mb}`, waterline: at }, local: true }),
  held_release_group: (mb) => ({ id: `hr-${mb}`, entity: { id: `hr-${mb}`, count: 3, total: 3 }, local: true }),
  unscreened_sender_group: (mb) => ({ id: `u-${mb}`, entity: { id: `u-${mb}`, count: 2, total: 2 }, local: true }),
  outbox_entry: (mb) => ({
    id: `ob-${mb}`, local: true,
    entity: { v: 1, id: `ob-${mb}`, key: "k", n: 1, at: 1, mutation: { kind: "archive", messageId: `m-${mb}` } },
  }),
  outbox_abandoned: (mb) => ({ id: `oa-${mb}`, entity: { id: `oa-${mb}`, mutation: { kind: "archive", messageId: `m-${mb}` } }, local: true }),
  store_page: () => null,
  calendar_connection: (mb) => ({ id: `cc-${mb}`, entity: { id: `cc-${mb}`, provider: "google", grantMailboxId: mb, updatedAt: at } }),
  calendar: (mb) => ({ id: `cal-${mb}`, entity: { id: `cal-${mb}`, connectionId: `cc-${mb}`, updatedAt: at } }),
  calendar_event: (mb) => ({ id: `ev-${mb}`, entity: { id: `ev-${mb}`, calendarId: `cal-${mb}`, startsAt: at, updatedAt: at } }),
  calendar_suggestion: (mb) => ({
    id: `cs-${mb}`, entity: { id: `cs-${mb}`, messageId: `m-${mb}`, mailboxId: mb, createdAt: at, updatedAt: at },
  }),
};

/** A mirror holding both mailboxes and, for each, one row of every type in its real shape. */
async function everyType(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const changes: SyncChange[] = [];
  for (const mb of [GONE, KEPT]) {
    changes.push({ type: "mailbox", op: "create", id: mb, seq: ++seq, updatedAt: at, entity: { id: mb } });
    for (const [type, shape] of Object.entries(SHAPE)) {
      const row = shape(mb);
      if (row === null) continue;
      if (row.local) await store.putLocal(type, row.id, row.entity);
      else changes.push({ type, op: "create", id: row.id, seq: ++seq, updatedAt: at, entity: row.entity });
    }
  }
  await store.applyChanges(changes);
  return store;
}

/** Apply the removed mailbox's receipt and answer what `census` got wrong about it. */
async function misread(census: Partial<Record<KnownMirrorEntityType, Seat>>): Promise<string[]> {
  const store = await everyType();
  await store.applyChanges([{ type: "mailbox", op: "delete", id: GONE, seq: 10_000, updatedAt: at }]);
  const wrong: string[] = [];
  for (const [type, c] of Object.entries(census) as Array<[KnownMirrorEntityType, Seat]>) {
    const gone = SHAPE[type](GONE);
    const kept = SHAPE[type](KEPT);
    if (gone === null || kept === null) continue;
    if (store.get(type, kept.id) === undefined) wrong.push(`${type}: the other mailbox's row was taken`);
    const taken = store.get(type, gone.id) === undefined;
    if (c.seat === "exclusive" && !taken) wrong.push(`${type}: the removed mailbox's row stayed`);
    if (c.seat === "shared" && taken) wrong.push(`${type}: a shared row was taken`);
  }
  return wrong;
}

describe("what a mailbox receipt takes from a mirror", () => {
  it("classifies every type the mirror holds, and nothing else", () => {
    expect(Object.keys(CENSUS).sort()).toEqual([...MIRROR_ENTITY_TYPES].sort());
    for (const [type, c] of Object.entries(CENSUS)) expect(c.why.length, `${type} has no reason`).toBeGreaterThan(15);
  });

  it("takes the removed mailbox's EXCLUSIVE rows, keeps the other's, and keeps every SHARED row", async () => {
    expect(await misread(CENSUS)).toEqual([]);
  });

  it("names a misclassified type in either direction — the census's own positive control", async () => {
    expect(await misread({ draft: { seat: "shared", why: "planted: keyed by the mailbox" } }))
      .toEqual(["draft: a shared row was taken"]);
    expect(await misread({ rule: { seat: "exclusive", key: "mailboxId", why: "planted: the account's rule" } }))
      .toEqual(["rule: the removed mailbox's row stayed"]);
  });
});
