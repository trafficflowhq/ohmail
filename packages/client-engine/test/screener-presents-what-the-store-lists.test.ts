import { describe, expect, it } from "vitest";
import {
  consentPartition,
  MemoryMirrorStore,
  ohboxView,
  OhmailEngine,
  presentationReader,
  screenerSegments,
  type EngineAdapter,
  type EngineMessage,
  type EntityReader,
  type MutationOutcome,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * A SENDER THE STORE DOES NOT LIST AS WAITING IS NEVER PRESENTED AT THE GATE.
 *
 * The account wrote to a correspondent before their letter came, so the organizer admitted it and
 * the store keeps it in the INBOX; `GET /screener` lists only the real stranger. The client's
 * partition sees no rule for either and used to present both at the gate. It now reads the
 * store's page: the correspondent's letter presents in the Ohbox, the stranger's in the Screener.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const OWN = "me@home.test";
const PAL = "pal@friends.test";
const STRANGER = "new@stranger.test";
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function msg(id: string, over: Partial<EngineMessage>): EngineMessage {
  const date = over.date ?? ago(2);
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "x@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}

export const CORRESPONDENT_WORLD: EngineMessage[] = [
  msg("sent", { folder: "Sent" as EngineMessage["folder"], from: { name: null, address: OWN }, to: [{ name: null, address: PAL }], date: ago(72), unread: false }),
  msg("pal-letter", { folder: "INBOX", from: { name: "Pal", address: PAL } }),
  msg("stranger-letter", { folder: "ohmail/Screener", from: { name: null, address: STRANGER } }),
];

/** The store's answer for that world: the stranger alone, and the page is the whole queue. */
export const STRANGER_ONLY: ScreenerWaitingWire = {
  items: [{ messageId: "stranger-letter", address: STRANGER, name: null, receivedAt: ago(2), subject: "Subject stranger-letter", snippet: "s", mailboxId: "mb" }],
  nextCursor: null, total: 1, inFlight: [],
};

async function world(answer: ScreenerWaitingWire): Promise<OhmailEngine> {
  let sent = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = sent ? [] : [
        { type: "mailbox", op: "create", id: "mb", seq: 1, updatedAt: NOW.toISOString(), entity: { id: "mb", address: OWN } },
        ...CORRESPONDENT_WORLD.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 2, updatedAt: m.updatedAt, entity: m })),
      ];
      sent = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    screenerWaiting: async () => answer,
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.syncOnce();
  await engine.refreshScreenerWaiting();
  return engine;
}

const presented = (raw: EntityReader): EntityReader =>
  presentationReader(raw, consentPartition(raw, { now: NOW, ownAddresses: [OWN] }));
const ohboxIds = (pres: EntityReader): string[] => {
  const box = ohboxView(pres);
  return [...box.resurfaced, ...box.newForYou, ...box.previouslySeen].map((m) => m.id);
};

describe("the presentation agrees with the store's queue", () => {
  it("the correspondent's letter presents in the Ohbox, the stranger's in the Screener", async () => {
    const pres = presented((await world(STRANGER_ONLY)).read());

    expect(ohboxIds(pres), "the correspondent's letter is presented at the gate").toContain("pal-letter");
    expect(pres.get<EngineMessage>("message", "pal-letter")?.folder).toBe("INBOX");
    expect(screenerSegments(pres, NOW).waiting.map((w) => w.from.address)).toEqual([STRANGER]);
    expect(pres.get<EngineMessage>("message", "stranger-letter")?.folder).toBe("ohmail/Screener");
  });

  it("before the store answers, the device's own derivation stands and says so", async () => {
    const engine = new OhmailEngine({
      adapter: { sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() }) } as unknown as EngineAdapter,
      store: new MemoryMirrorStore(), now: () => NOW,
    });
    await engine.start();
    expect(screenerSegments(engine.read(), NOW).source).toBe("mirror");
  });

  it("gate mail of an unlisted sender stays at the gate past what the page speaks for", async () => {
    // The page is NOT the whole queue and its last row is newer than this held letter, so the
    // sender may be on a later page: the store has not answered for them.
    const partial: ScreenerWaitingWire = { ...STRANGER_ONLY, nextCursor: "more", total: 2 };
    const engine = await world(partial);
    const raw = engine.read();
    const pres = presented(raw);
    expect(pres.get<EngineMessage>("message", "stranger-letter")?.folder).toBe("ohmail/Screener");
    // …while the INBOX letter of a sender the page does not list is never held, page or no page.
    expect(pres.get<EngineMessage>("message", "pal-letter")?.folder).toBe("INBOX");
  });
});
