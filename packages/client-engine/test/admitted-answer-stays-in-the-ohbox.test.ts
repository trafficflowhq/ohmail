import type { EngineMessage, ScreenerWaitingWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  presentationReader,
  screenerSegments,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * An answer the gate admitted (the reply arm) is decided for that letter. When its
 * author writes again and that letter waits, the page lists the author; the partition used to
 * present the answer at the gate too ("2 held") while the server kept it in the INBOX. The answer
 * stays in the Ohbox, and only the new letter waits.
 */

const NOW = new Date("2026-10-10T06:45:00.000Z");

function letter(id: string, from: string, folder: EngineMessage["folder"], over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from },
    to: [], cc: [], date: NOW.toISOString(), arrivedAt: NOW.toISOString(), folder, snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(), senderCheck: null, ...over,
  };
}

const X = "b+r31z@answers.example";
const Y = "c+fresh@stranger.example";
const Z = "d+answered@answers.example";
const LETTERS = [
  letter("r7", X, "INBOX", { placeDecided: true }), // the answer the reply arm admitted
  letter("r8", X, "ohmail/Screener"), // the same address writing again, held
  letter("y1", Y, "INBOX"), // a stranger's INBOX letter nothing decided (control)
  letter("y2", Y, "ohmail/Screener"),
  letter("z1", Z, "INBOX", { placeDecided: true }), // an admitted answer, its author silent since
];

function page(): ScreenerWaitingWire {
  return {
    items: [X, Y].map((a, i) => ({
      messageId: i === 0 ? "r8" : "y2", address: a, name: null, receivedAt: NOW.toISOString(),
      subject: "s", snippet: "s", mailboxId: "mb",
    })),
    nextCursor: null, total: 2, inFlight: [],
  };
}

async function mirror(): Promise<OhmailEngine> {
  const pages: SyncChange[][] = [LETTERS.map((m, i) => (
    { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: NOW.toISOString(), entity: m }))];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    screenerWaiting: async () => page(),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.refreshScreenerWaiting();
  return engine;
}

describe("an answer the gate admitted", () => {
  it("stays in the Ohbox when its author's next letter waits, and only that letter is held", async () => {
    const engine = await mirror();
    const partition = consentPartition(engine.read(), { now: NOW });
    expect(partition.placeOf.get("r7")).toBe("INBOX");
    const waiting = screenerSegments(presentationReader(engine.read(), partition), NOW).waiting;
    const x = waiting.find((w) => w.from.address === X);
    expect(x?.held.map((h) => h.id)).toEqual(["r8"]);
    expect(x?.reached, "the row is not first contact").toBe(1);
  });

  it("CONTROL: a stranger's INBOX letter nothing decided still waits with their held one", async () => {
    const engine = await mirror();
    const partition = consentPartition(engine.read(), { now: NOW });
    expect(partition.placeOf.get("y1")).toBe("ohmail/Screener");
    const waiting = screenerSegments(presentationReader(engine.read(), partition), NOW).waiting;
    const y = waiting.find((w) => w.from.address === Y);
    expect(y?.held.map((h) => h.id).sort()).toEqual(["y1", "y2"]);
    expect(y?.reached).toBeUndefined();
  });

  it("is not counted as a sender owed a decision on its own", async () => {
    const engine = await mirror();
    const counts = consentPartition(engine.read(), { now: NOW }).counts;
    // X waits for r8 and Y for theirs; Z's only letter is an admitted answer and owes nothing.
    expect(counts.activeUndecidedSenders).toBe(2);
  });
});

/** A screen-out of the answer's author: a DENY rule, the later letter already filed to Screened. */
describe("the admitted answer after its author is screened out", () => {
  const RULE_AT = NOW.toISOString();
  async function screenedOut(extra: EngineMessage[] = []): Promise<MemoryMirrorStore> {
    const store = new MemoryMirrorStore();
    await store.load();
    const ms = [letter("r7", X, "INBOX", { placeDecided: true }), letter("r8", X, "ohmail/Screened"), ...extra];
    await store.applyChanges([
      ...ms.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: RULE_AT, entity: m })),
      {
        type: "rule", op: "create", id: "rx", seq: 99, updatedAt: RULE_AT,
        entity: {
          id: "rx", kind: "sender", match: X, destination: "ohmail/Screened", priority: 0, provenance: "manual",
          enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: RULE_AT, updatedAt: RULE_AT,
        },
      },
    ]);
    return store;
  }

  it("stays in the Ohbox and is not on the screened-out shelf", async () => {
    const store = await screenedOut();
    const p = consentPartition(store, { now: NOW });
    expect(p.placeOf.get("r7")).toBe("INBOX");
    const shelf = screenerSegments(presentationReader(store, p), NOW).screenedOut.flatMap((r) => r.held.map((h) => h.id));
    expect(shelf).toEqual(["r8"]);
  });

  it("CONTROL: the author's letter whose place nobody decided still goes to the screened-out shelf", async () => {
    const store = await screenedOut([letter("r9", X, "INBOX")]);
    const p = consentPartition(store, { now: NOW });
    expect(p.placeOf.get("r9")).toBe("ohmail/Screened");
    const shelf = screenerSegments(presentationReader(store, p), NOW).screenedOut.flatMap((r) => r.held.map((h) => h.id)).sort();
    expect(shelf).toEqual(["r8", "r9"]);
  });
});
