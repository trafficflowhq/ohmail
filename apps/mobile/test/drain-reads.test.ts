import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { FACTS_REREAD_MS, MAILBOXES_REREAD_MS, drainReads } from "../src/state/drain-reads";
import { foldersFlag } from "../src/state/folders-flag";

/**
 * THE ENGINE'S QUEUE READS ARE ASKED ONCE PER SESSION, THEN BY THE SETTLE. The shipped drain read
 * (`drain-reads.ts`, what the world's flag machine calls at boot and after every drain) over a real
 * engine and the real flag machine: boot asks the queue page and the offer once; three idle drains
 * ask neither again; a gate arrival makes the engine's settle ask the page once more.
 */

const NOW = new Date("2026-09-29T09:00:00.000Z");
const page = (ids: string[]): ScreenerWaitingWire => ({
  items: ids.map((id) => ({
    messageId: id, address: `${id}@example.test`, name: null, receivedAt: NOW.toISOString(),
    subject: `s ${id}`, snippet: "s", mailboxId: "mb",
  })),
  nextCursor: null, total: ids.length, inFlight: [],
});

function msg(id: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` },
    to: [], cc: [], date: NOW.toISOString(), folder, snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  } as EngineMessage;
}

function rig() {
  const pages: SyncChange[][] = [];
  const asks = { queue: 0, offer: 0, rest: 0, consent: 0 };
  let seq = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    fetchBody: async () => null,
    screenerWaiting: async () => { asks.queue += 1; return page(["a"]); },
    unscreened: async () => { asks.offer += 1; return { groups: [], total: 0, max: 200 }; },
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  const flag = foldersFlag({
    read: drainReads<{ on: boolean }>({
      rest: [() => { asks.rest += 1; }],
      consent: async () => { asks.consent += 1; return { on: false }; },
      engine,
    }),
    write: async (on) => ({ on }),
    apply: () => undefined,
    drain: () => undefined,
  });
  const push = (m: EngineMessage) => pages.push([
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m } as SyncChange,
  ]);
  return { engine, flag, asks, push };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the drain read's cadence", () => {
  it("boot asks once; idle drains ask nothing more; a gate arrival asks the page once", async () => {
    const { engine, flag, asks, push } = rig();
    await engine.start();
    await flag.refresh();
    await flush();
    expect(asks).toMatchObject({ queue: 1, offer: 1, rest: 1, consent: 1 });
    for (let i = 0; i < 3; i++) {
      await engine.syncOnce();
      await flag.refresh();
      await flush();
    }
    expect(asks, "an idle drain re-asked the engine's queue reads").toMatchObject({ queue: 1, offer: 1 });
    expect(asks.rest, "the REST reads keep the drain cadence").toBe(4);
    push(msg("held1", "ohmail/Screener"));
    await engine.syncOnce();
    await flag.refresh();
    await flush();
    expect(asks.queue, "a gate arrival did not re-ask the page").toBe(2);
  });

  it("the mailboxes and the consent answer go when the mirror moved, the app came back or minutes passed", async () => {
    const queues = { refreshScreenerWaiting: async () => undefined, refreshUnscreened: async () => undefined };
    const asks = { rest: 0, facts: 0, consent: 0 };
    let stamp = 1;
    let now = 0;
    let answer: { on: boolean } | null = { on: false };
    const read = drainReads<{ on: boolean }>({
      rest: [() => { asks.rest += 1; }],
      facts: [() => { asks.facts += 1; }],
      consent: async () => { asks.consent += 1; return answer; },
      engine: queues,
      stamp: () => stamp,
      now: () => now,
    });
    const drain = async (): Promise<{ on: boolean } | null> => { const a = await read(); await flush(); return a; };
    expect(await drain()).toEqual({ on: false });
    for (let i = 0; i < 3; i++) { now += 8_000; expect(await drain(), "an idle drain asked the consent").toBeNull(); }
    expect(asks).toEqual({ rest: 4, facts: 1, consent: 1 });
    stamp = 2;
    await drain();
    expect(asks, "a moved mirror did not re-ask").toMatchObject({ facts: 2, consent: 2 });
    read.factsDue();
    await drain();
    expect(asks, "the return to the front did not re-ask").toMatchObject({ facts: 3, consent: 3 });
    now += FACTS_REREAD_MS;
    await drain();
    expect(asks, "minutes passed and nothing was re-asked").toMatchObject({ facts: 4, consent: 4 });
    // A consent read that got no answer is asked again at the next drain.
    stamp = 3;
    answer = null;
    await drain();
    answer = { on: true };
    expect(await drain()).toEqual({ on: true });
    // The mailboxes were answered: the consent's retry does not ask them again.
    expect(asks).toMatchObject({ rest: 9, facts: 5, consent: 6 });
    // The mailboxes stand for less than the consent answer: the Ohbox's "Checked" line reads them.
    now += MAILBOXES_REREAD_MS;
    await drain();
    expect(asks).toMatchObject({ facts: 6, consent: 6 });
  });
});
