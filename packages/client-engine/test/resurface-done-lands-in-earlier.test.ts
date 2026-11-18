import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  consentPartition,
  isResurfaced,
  ohboxView,
  MemoryMirrorStore,
  SearchIndex,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * WHERE A RESURFACED MESSAGE GOES WHEN IT IS MARKED DONE — measured, because a user could not
 * find one (2026-09-21): a message parked, come back, forwarded and then released with Done was
 * "nowhere". Done is one deliberate `mark_seen` (the pin is spent server-side in the same
 * transaction) and, for a booked row, a `triage_set: none` first; neither moves a folder — the
 * Resurface pile has no IMAP folder of its own, so the message stays where the mailbox had it.
 */

/*
 * So the message is in the Ohbox's "Earlier" — at its ARRIVAL slot (owner ruling 2026-09-18:
 * Earlier is one chronology and a read never moves a row), which for a ten-day-old message is
 * below everything newer. It is NOT in History: History lists mail from senders nobody has
 * screened and the pre-baseline backlog, never a decided sender's mail. Search finds it by
 * subject. The toast the release shows names that slot now ("filed under Earlier at <date>").
 */

const NOW = new Date("2026-09-21T09:30:00.000Z");
const OWN = "me@example.invalid";
const SENDER = "counterparty@example.invalid";

let seq = 0;

function msg(o: {
  id: string; from: string; folder: string; date: string; unread?: boolean; lastReadAt?: string;
}): EngineMessage {
  return {
    id: o.id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: [{ name: null, address: o.from === OWN ? SENDER : OWN }],
    cc: [], date: o.date, arrivedAt: o.date, folder: o.folder as Folder, snippet: `snippet ${o.id}`,
    unread: o.unread ?? false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: o.date,
    ...(o.lastReadAt ? { lastReadAt: o.lastReadAt } : {}),
  } as EngineMessage;
}

const rule = (address: string): RuleDTO => ({
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
  provenance: "seeded-from-sent", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as RuleDTO);

async function mirrorOf(messages: EngineMessage[], rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return store;
}

/**
 * The reported mailbox after the press: the original, ten days old, read by Done a minute ago
 * (`lastReadAt` is the newest stamp in the whole mirror) with its pin spent; three newer read
 * messages from screened senders and one own reply above it.
 */
async function afterDone(): Promise<{ store: MemoryMirrorStore; original: EngineMessage }> {
  const original = msg({
    id: "orig", from: SENDER, folder: "INBOX", date: "2026-09-11T08:00:00.000Z",
    lastReadAt: "2026-09-21T09:29:00.000Z",
  });
  const newer = [
    msg({ id: "n1", from: "a@example.invalid", folder: "INBOX", date: "2026-09-21T09:04:00.000Z" }),
    msg({ id: "own", from: OWN, folder: "Sent", date: "2026-09-21T09:00:00.000Z" }),
    msg({ id: "n2", from: "b@example.invalid", folder: "INBOX", date: "2026-09-20T11:12:00.000Z" }),
    msg({ id: "n3", from: "c@example.invalid", folder: "INBOX", date: "2026-09-19T15:25:00.000Z" }),
  ];
  const store = await mirrorOf(
    [original, ...newer],
    [rule(SENDER), rule("a@example.invalid"), rule("b@example.invalid"), rule("c@example.invalid")],
  );
  return { store, original };
}

describe("a resurfaced message marked Done", () => {
  it("stands under Earlier at its arrival slot — below everything newer, whatever it was read", async () => {
    const { store, original } = await afterDone();
    expect(isResurfaced(original)).toBe(false);
    const view = ohboxView(store);
    expect(view.resurfaced).toEqual([]);
    expect(view.newForYou).toEqual([]);
    // One chronology, newest first; the freshest `lastReadAt` in the mirror moves nothing.
    expect(view.previouslySeen.map((m) => m.id)).toEqual(["n1", "own", "n2", "n3", "orig"]);
  });

  it("is not in History — a decided sender's mail never is — and keeps its folder", async () => {
    const { store } = await afterDone();
    const part = consentPartition(store, { now: NOW, ownAddresses: [OWN] });
    expect(part.history.map((m) => m.id)).not.toContain("orig");
    expect(part.placeOf.get("orig")).toBe("INBOX");
  });

  /**
   * THE THIRD PLACE THE OWNER LOOKED. The local index holds every message the mirror does — a
   * spent pin and a read stamp post nothing and remove nothing — so the released original
   * answers a word of its own subject, and only it.
   */
  it("Search finds it by subject, read and released like any other message", async () => {
    const { store } = await afterDone();
    const idx = new SearchIndex();
    for (const m of store.list<EngineMessage>("message")) idx.add(m);
    const res = idx.search("orig");
    expect(res.tier).toBe("exact");
    expect(res.items.map((h) => h.message.id)).toEqual(["orig"]);
  });

  /**
   * POSITIVE CONTROL for the History arm: the same message from a sender NOBODY decided about,
   * old and read, IS History — so the absence above is the rule and not an empty list.
   */
  it("control: the same old read message from an unscreened sender is History", async () => {
    const original = msg({
      id: "orig", from: "stranger@example.invalid", folder: "INBOX", date: "2026-03-11T08:00:00.000Z",
      lastReadAt: "2026-09-21T09:29:00.000Z",
    });
    const store = await mirrorOf([original], []);
    const part = consentPartition(store, { now: NOW, ownAddresses: [OWN] });
    expect(part.history.map((m) => m.id)).toEqual(["orig"]);
  });
});
