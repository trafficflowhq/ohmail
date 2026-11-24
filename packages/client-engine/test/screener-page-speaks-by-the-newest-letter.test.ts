import type { EngineMessage, EngineMutation, MutationOutcome, ScreenerWaitingWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  screenerSegments,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * THE QUEUE PAGE SPEAKS FOR A SENDER BY THEIR NEWEST HELD LETTER, header else arrival — the
 * representative the server pages by (`heldSortKey`), never letter by letter. Read per letter by
 * its `Date:` header alone, one sender was a waiting row and an Ohbox row at once, and an undated
 * letter on a whole-queue page was in no list (gap row SCREENER-PAGE-COVERAGE-READS-THE-HEADER-
 * PER-LETTER). Harness: `screener-waiting-store.test.ts`'s.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const item = (id: string) => ({
  messageId: id, address: `${id}@example.test`, name: null, receivedAt: NOW.toISOString(),
  subject: `s ${id}`, snippet: "s", mailboxId: "mb",
});
const page = (ids: string[], over: Partial<ScreenerWaitingWire> = {}): ScreenerWaitingWire => (
  { items: ids.map(item), nextCursor: null, total: ids.length, inFlight: [], ...over });

function msg(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` },
    to: [], cc: [], date: NOW.toISOString(), folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(), ...over,
  };
}

function rig(answer: (p: { cursor?: string }) => ScreenerWaitingWire | Promise<ScreenerWaitingWire>) {
  const pages: SyncChange[][] = [];
  const sent: EngineMutation[] = [];
  const asks: Array<{ cursor?: string }> = [];
  let seq = 0;
  let refuse = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (m: EngineMutation): Promise<MutationOutcome> => {
      sent.push(m);
      if (refuse) throw Object.assign(new Error("refused"), { status: 409, code: "conflict" });
      return { changes: [], seq: null } as unknown as MutationOutcome;
    },
    fetchBody: async () => null,
    screenerWaiting: async (p?: { cursor?: string }) => { asks.push(p ?? {}); return answer(p ?? {}); },
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  const push = (...ms: EngineMessage[]) => pages.push(ms.map((m) => (
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })));
  return { engine, sent, asks, push, refuseNext: () => { refuse = true; } };
}

const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const held = (id: string, from: string, over: Partial<EngineMessage> = {}) =>
  msg(id, { folder: "ohmail/Screener", from: { name: null, address: from }, ...over });

async function world(answer: ScreenerWaitingWire, ...ms: EngineMessage[]) {
  const r = rig(() => answer);
  r.push(...ms);
  await r.engine.start();
  await r.engine.refreshScreenerWaiting();
  const read = r.engine.read();
  const waiting = screenerSegments(read, NOW).waiting.map((w) => w.from.address);
  const place = consentPartition(read, { now: NOW }).placeOf;
  return { waiting, place };
}

describe("the page speaks for a sender by their newest held letter", () => {
  it("two letters straddling the page's last row: one sender, spoken for, in one list", async () => {
    // The page lists `a` up to `a`'s instant (now − 2 h) and goes on; `z` is unlisted.
    const answer = page(["a"], { nextCursor: "n", total: 9 });
    answer.items[0]!.receivedAt = at(-2);
    const { waiting, place } = await world(answer,
      held("a", "a@example.test", { date: at(-2) }),
      held("z-old", "z@example.test", { date: at(-5) }),
      held("z-new", "z@example.test", { date: at(-1) }));
    expect(waiting, "the newer half was spoken for and the older half still waits").not.toContain("z@example.test");
    expect(place.get("z-old"), "one sender in two lists").toBe(place.get("z-new"));
  });

  it("an undated letter on a whole-queue page is in a list: dated by its arrival", async () => {
    const { waiting, place } = await world(page(["a"]),
      held("a", "a@example.test"),
      held("u", "u@example.test", { date: null, arrivedAt: at(-1) }));
    expect(waiting).not.toContain("u@example.test");
    expect(place.get("u"), "the letter is in no list").toBe("INBOX");
  });

  it("CONTROL: a sender whose newest held letter is older than the page's last row still waits", async () => {
    const answer = page(["a"], { nextCursor: "n", total: 9 });
    answer.items[0]!.receivedAt = at(-2);
    const { waiting, place } = await world(answer,
      held("a", "a@example.test", { date: at(-2) }),
      held("z-old", "z@example.test", { date: at(-6) }),
      held("z-new", "z@example.test", { date: at(-4) }));
    expect(waiting).toContain("z@example.test");
    expect(place.get("z-old")).toBe(place.get("z-new"));
  });
});
