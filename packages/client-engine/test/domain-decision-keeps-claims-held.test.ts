import type { EngineMessage, EngineMutation, MutationOutcome, ScreenerWaitingWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  screenerSegments,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * A whole-domain decision's overlay moves exactly what the server's press moves. The
 * server leaves another address's company claim at the gate and keeps that sender waiting; the
 * overlay hid both claims from every list until the next queue page (about 22 s), and left a plain
 * letter of the same domain where the server moved it.
 */

const NOW = new Date("2026-10-09T10:17:00.000Z");
const DOMAIN = "fixture-sender.example";
const CLAIM = { reason: "impersonation" as const, brand: "Swisscom", domainShared: false };

function held(id: string, local: string, senderCheck: EngineMessage["senderCheck"]): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${local}@${DOMAIN}` },
    to: [], cc: [], date: NOW.toISOString(), folder: "ohmail/Screener", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(), senderCheck,
  };
}

const LETTERS = [
  held("m1", "b14s1", null),
  held("m2", "b14s2", CLAIM),
  held("m3", "b14s3", CLAIM),
  held("m5", "b14s5", null),
];

/** `storeOnly`: page rows whose letters this mirror does not hold, listed by the page alone. */
function page(storeOnly: EngineMessage[] = []): ScreenerWaitingWire {
  const rows = [...LETTERS, ...storeOnly];
  return {
    items: rows.map((m) => ({
      messageId: m.id, address: m.from.address, name: null, receivedAt: NOW.toISOString(),
      subject: m.subject, snippet: "s", mailboxId: "mb", ...(m.senderCheck ? { marked: true as const } : {}),
    })),
    nextCursor: null, total: rows.length, inFlight: [],
  };
}

async function pressed(storeOnly: EngineMessage[] = []): Promise<OhmailEngine> {
  const pages: SyncChange[][] = [LETTERS.map((m, i) => (
    { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: NOW.toISOString(), entity: m }))];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: NOW.toISOString(),
    }),
    // The decide stays in flight: what the person sees is the overlay alone.
    mutate: (_m: EngineMutation): Promise<MutationOutcome> => new Promise(() => {}),
    fetchBody: async () => null,
    screenerWaiting: async () => page(storeOnly),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.refreshScreenerWaiting();
  void engine.mutate({ kind: "screener_decide", senderId: "m1", decision: "yes", dest: "ohbox", scope: "domain" });
  await new Promise((r) => setTimeout(r, 0));
  return engine;
}

describe("a whole-domain decision's overlay", () => {
  it("keeps the domain's company claims listed as held", async () => {
    const engine = await pressed();
    const waiting = screenerSegments(engine.read(), NOW).waiting.map((w) => w.from.address).sort();
    expect(waiting).toEqual([`b14s2@${DOMAIN}`, `b14s3@${DOMAIN}`]);
  });

  it("moves the plain letters the server moves, the pressed address's and another's", async () => {
    const engine = await pressed();
    const at = (id: string) => engine.read().get<EngineMessage>("message", id)?.folder;
    expect([at("m1"), at("m5"), at("m2"), at("m3")]).toEqual(["INBOX", "INBOX", "ohmail/Screener", "ohmail/Screener"]);
  });

  it("keeps a claim the mirror holds no letter of, by the page's own mark", async () => {
    const engine = await pressed([held("m9", "b14s9", CLAIM)]);
    const waiting = screenerSegments(engine.read(), NOW).waiting.map((w) => w.from.address);
    expect(waiting).toContain(`b14s9@${DOMAIN}`);
    expect(waiting).not.toContain(`b14s5@${DOMAIN}`);
  });

  it("a press on a claim's own address moves that claim (control)", async () => {
    const pages: SyncChange[][] = [LETTERS.map((m, i) => (
      { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: NOW.toISOString(), entity: m }))];
    const adapter = {
      sync: async (): Promise<SyncResponse> => ({
        changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
        cursor: "c1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: (): Promise<MutationOutcome> => new Promise(() => {}),
      fetchBody: async () => null,
      screenerWaiting: async () => page(),
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
    await engine.start();
    await engine.refreshScreenerWaiting();
    void engine.mutate({ kind: "screener_decide", senderId: "m2", decision: "yes", dest: "ohbox", scope: "sender" });
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.read().get<EngineMessage>("message", "m2")?.folder).toBe("INBOX");
    const waiting = screenerSegments(engine.read(), NOW).waiting.map((w) => w.from.address);
    expect(waiting).not.toContain(`b14s2@${DOMAIN}`);
    expect(waiting).toContain(`b14s3@${DOMAIN}`);
  });
});
