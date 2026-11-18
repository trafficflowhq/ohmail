import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, cardReach, type SyncChange } from "../src/index.js";

/**
 * WHAT A WHOLE-DOMAIN CARD PRESS FILES, named before it is made: every waiting sender at the domain
 * and how many of their letters move — INBOX letters by id, held letters as the server's press
 * moves them. A letter whose place is decided is never one, and another address's company claim
 * stays at the gate as the server leaves it.
 */

const AT = "2026-10-10T08:00:00.000Z";
const D = "letters.example";
const CLAIM = { reason: "impersonation" as const, brand: "PayPal", domainShared: false };

function letter(id: string, local: string, folder: EngineMessage["folder"], over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `S ${id}`, from: { name: null, address: `${local}@${D}` }, to: [], cc: [], date: AT, folder,
    snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT, senderCheck: null, ...over,
  };
}

async function reader() {
  const store = new MemoryMirrorStore();
  await store.load();
  const ms = [
    letter("h1", "a", "ohmail/Screener"), letter("a1", "a", "INBOX"),
    letter("b1", "b", "INBOX"), letter("b2", "b", "ohmail/Screener", { senderCheck: CLAIM }),
    letter("c1", "c", "INBOX", { placeDecided: true }),
  ];
  await store.applyChanges(ms.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: AT, entity: m })));
  return store;
}

const ROWS = [
  { address: `a@${D}`, heldIds: ["h1", "a1"] },
  { address: `b@${D}`, heldIds: ["b1", "b2"] },
  { address: `c@${D}`, heldIds: ["c1"] },
  { address: "z@elsewhere.example", heldIds: ["z1"] },
];

describe("a card's reach", () => {
  it("at domain scope names the other senders and moves every INBOX letter in scope", async () => {
    const r = cardReach(await reader(), ROWS, `a@${D}`, "domain");
    expect(r.others).toEqual([{ address: `b@${D}`, count: 1 }]);
    expect(r.inboxIds).toEqual(["a1", "b1"]);
  });

  it("CONTROL: an admitted answer at the domain is never in the set, and another domain is outside it", async () => {
    const r = cardReach(await reader(), ROWS, `a@${D}`, "domain");
    expect(r.inboxIds).not.toContain("c1");
    expect(r.others.map((o) => o.address)).not.toContain(`c@${D}`);
    expect(r.inboxIds).not.toContain("z1");
  });

  it("at sender scope it is the card's own INBOX letters, and names nobody else", async () => {
    const r = cardReach(await reader(), ROWS, `a@${D}`, "sender");
    expect(r).toEqual({ others: [], inboxIds: ["a1"] });
  });
});

describe("a card's reach counts what the server's press moves", () => {
  it("another sender's letter put back at the gate is counted, as the server's domain press moves it", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const ms = [letter("h1", "a", "ohmail/Screener"), letter("p1", "b", "ohmail/Screener", { placeDecided: true })];
    await store.applyChanges(ms.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: AT, entity: m })));
    const r = cardReach(store, [{ address: `a@${D}`, heldIds: ["h1"] }, { address: `b@${D}`, heldIds: ["p1"] }], `a@${D}`, "domain");
    expect(r).toEqual({ others: [{ address: `b@${D}`, count: 1 }], inboxIds: [] });
  });
});
