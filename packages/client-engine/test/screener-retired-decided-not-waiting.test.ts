import { describe, expect, it } from "vitest";
import {
  consentPartition,
  MemoryMirrorStore,
  OhmailEngine,
  presentationReader,
  screenerSegments,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type RuleDTO,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ARCH-R902 RISK 4 — A DECIDED SENDER'S GATE BACKLOG IS AT THE GATE AND IS NOT A WAITING ROW.
 *
 * With `heldAtGate` gone, a retired sender with an admitting rule keeps their unmoved gate mail at
 * the gate. The store's page lists the real stranger only; the decided sender must not surface as a
 * waiting row it does not list — not through the page's join, and not as mail "past the page"
 * when the queue goes on. Standing decides waiting, never placement.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const OWN = "me@home.test";
const KNOWN = "known@friends.test";
const STRANGER = "new@stranger.test";
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function msg(id: string, from: string, date: string, unread: boolean): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [], date,
    folder: "ohmail/Screener", snippet: "s", unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as EngineMessage;
}

const RULE: RuleDTO = {
  id: "r-known", kind: "sender", match: KNOWN, destination: "INBOX", priority: 0, provenance: "promoted",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: ago(24 * 400), updatedAt: ago(24 * 400), subjectContains: null, bodyContains: null,
};
// Retired: old and read, a year before the window; the stranger's letter is today's.
const MAIL = [msg("known-old", KNOWN, ago(24 * 365), false), msg("stranger-new", STRANGER, ago(2), true)];

function page(nextCursor: string | null): ScreenerWaitingWire {
  return {
    items: [{ messageId: "stranger-new", address: STRANGER, name: null, receivedAt: ago(2), subject: "Subject stranger-new", snippet: "s", mailboxId: "mb" }],
    nextCursor, total: nextCursor === null ? 1 : 2, inFlight: [],
  };
}

async function engineWith(answer: ScreenerWaitingWire | null): Promise<OhmailEngine> {
  let sent = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = sent ? [] : [
        { type: "mailbox", op: "create", id: "mb", seq: 1, updatedAt: NOW.toISOString(), entity: { id: "mb", address: OWN } },
        { type: "rule", op: "create", id: RULE.id, seq: 2, updatedAt: RULE.updatedAt, entity: RULE },
        ...MAIL.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 3, updatedAt: m.updatedAt, entity: m })),
      ];
      sent = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    ...(answer === null ? {} : { screenerWaiting: async () => answer }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.syncOnce();
  await engine.refreshScreenerWaiting();
  return engine;
}

function queueOf(engine: OhmailEngine) {
  const raw = engine.read();
  const part = consentPartition(raw, { now: NOW, ownAddresses: [OWN] });
  return { part, waiting: screenerSegments(presentationReader(raw, part), NOW, "en", "UTC", [OWN]).waiting };
}

describe("a retired decided sender's gate mail stays at the gate and is not asked about", () => {
  for (const [name, answer] of [
    ["the store's whole page", page(null)],
    ["a page the queue goes on past", page("c2")],
    ["no page at all (the mirror's own queue)", null],
  ] as const) {
    it(name, async () => {
      const { part, waiting } = queueOf(await engineWith(answer));
      expect(part.placeOf.get("known-old")).toBe("ohmail/Screener");
      expect(part.retiredDecided.has(KNOWN)).toBe(true);
      expect(waiting.map((w) => w.from.address)).toEqual([STRANGER]);
    });
  }
});
