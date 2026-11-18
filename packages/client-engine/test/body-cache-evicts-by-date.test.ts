import type { EngineMessage, MessageBodyRecord, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BODY_CACHE_MAX,
  EAGER_BODIES_MAX,
  MemoryMirrorStore,
  OhmailEngine,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE BODY CACHE EVICTS BY MESSAGE DATE, SO THE EAGER PASS SETTLES ═══════════════════════
 *
 * `prefetchRecentBodies` walks the newest {@link EAGER_BODIES_MAX} messages and the trim holds
 * {@link BODY_CACHE_MAX} of them, so the two only agree if they agree about WHICH. While the trim
 * evicted the least recently WRITTEN, they did not: the pass writes newest-first, so one poll of
 * K arrivals dropped the K newest bodies the pass had just fetched, the next pass re-fetched them
 * and the next write dropped the band below — measured at 40 ids and 480 KB on every one of five
 * consecutive do-nothing drains over a large mailbox, with rank 1 among the holes every time. The
 * order is what these cases pin; the sizing is `body-cache-bound.test.ts`.
 */

const NOW = new Date("2026-09-12T10:00:00.000Z");
/** Every message in these cases is older than now; the corpus starts here and counts back. */
const CORPUS_AGE_MIN = 10_000;

function msg(id: string, minutesOld: number): EngineMessage {
  const date = new Date(NOW.getTime() - minutesOld * 60_000).toISOString();
  return {
    id,
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

interface Pass {
  /** Ids the pass asked the wire for. A settled pass asks for none. */
  ids: number;
  /** Mirror version bumps the pass caused — every one re-derives the whole mailbox in the shell. */
  bumps: number;
}

/**
 * A mailbox of `n` messages, newest first (`m0` is the newest), every body available, plus a poll
 * that delivers arrivals NEWER than all of them — the shape the defect needs.
 */
async function rigOver(n: number) {
  let seq = 0;
  let arrivals = 0;
  const wire = { ids: 0 };
  const queue: EngineMessage[] = Array.from({ length: n }, (_, i) => msg(`m${i}`, CORPUS_AGE_MIN + i));
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const slice = queue.splice(0, queue.length);
      const creates: SyncChange[] = slice.map((m) => ({
        type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
      }));
      return {
        changes: { creates, updates: [], moves: [], deletes: [] },
        cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => {
      wire.ids += 1;
      return { text: `FULL ${id}`, html: `<p>${id}</p>`, loadedRemoteContent: false };
    },
    fetchBodies: async (batch: string[]) => {
      wire.ids += batch.length;
      return batch.map((id) => ({ messageId: id, text: `FULL ${id}`, html: `<p>${id}</p>`, loadedRemoteContent: false }));
    },
  } as never;

  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
  let bumps = 0;
  engine.subscribe(() => { bumps += 1; });
  await engine.start();
  await engine.syncOnce();

  /** One settled drain and the kick the scheduler issues after it, counted. */
  const pass = async (): Promise<Pass> => {
    await engine.syncOnce();
    const ids0 = wire.ids;
    const bumps0 = bumps;
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    return { ids: wire.ids - ids0, bumps: bumps - bumps0 };
  };

  /** `k` new messages, each newer than everything already in the mailbox. Returns their ids. */
  const deliver = async (k: number): Promise<string[]> => {
    const made = Array.from({ length: k }, (_, i) => {
      const id = `a${arrivals + i}`;
      return msg(id, CORPUS_AGE_MIN - 1 - (arrivals + i));
    });
    arrivals += k;
    queue.push(...made);
    await engine.syncOnce();
    return made.map((m) => m.id);
  };

  /** The mailbox newest first — the pass's own order. */
  const newest = (): string[] =>
    store.entries<EngineMessage>("message")
      .sort((a, b) => Date.parse(b.entity.date ?? "") - Date.parse(a.entity.date ?? ""))
      .map((e) => e.id);

  const ready = (): Set<string> =>
    new Set(
      store.entries<MessageBodyRecord>("message_body")
        .filter((e) => e.entity?.state === "ready")
        .map((e) => e.id),
    );

  return { engine, store, pass, deliver, newest, ready };
}

/** The ranks (1-based, newest first) inside the eager window that have no body. */
function holes(newest: string[], ready: Set<string>): number[] {
  const out: number[] = [];
  const window = newest.slice(0, Math.min(EAGER_BODIES_MAX, newest.length));
  for (let i = 0; i < window.length; i++) if (!ready.has(window[i]!)) out.push(i + 1);
  return out;
}

describe("the body cache evicts by message date", () => {
  /**
   * CONTROL 1. After a pass over the newest N and a poll of K, the newest N still all have bodies:
   * what gave way is the OLDEST of the window, never the newest. On the write-recency evictor this
   * reads `[1 … K]` — rank 1, the newest message in the mailbox, among the holes.
   */
  it("a poll of arrivals costs the window's OLDEST bodies, never its newest", async () => {
    const rig = await rigOver(EAGER_BODIES_MAX + 200);
    await rig.pass();
    const before = rig.newest();

    const arrived = await rig.deliver(20);
    await rig.pass();

    const ready = rig.ready();
    expect(holes(rig.newest(), ready)).toEqual([]);
    for (const id of arrived) expect(ready.has(id)).toBe(true);
    // And the bound was paid by the ranks that fell OUT of the window, not by its head.
    expect(ready.size).toBe(BODY_CACHE_MAX);
    for (const id of before.slice(EAGER_BODIES_MAX - 20, EAGER_BODIES_MAX)) {
      expect(ready.has(id)).toBe(false);
    }
  });

  /**
   * CONTROL 2 — THE SETTLE. Once the window is full, a drain that delivered nothing must cost
   * nothing: no id on the wire, no version bump. Five in a row, because the defect's signature was
   * a stable per-drain cost that never converged (40 ids and 6 bumps on each of five).
   */
  it("five idle drains after a poll fetch nothing and bump nothing", async () => {
    const rig = await rigOver(EAGER_BODIES_MAX + 200);
    await rig.pass();
    await rig.deliver(20);
    await rig.pass();

    const drains: Pass[] = [];
    for (let i = 0; i < 5; i++) drains.push(await rig.pass());

    expect(drains.map((d) => d.ids)).toEqual([0, 0, 0, 0, 0]);
    expect(drains.map((d) => d.bumps)).toEqual([0, 0, 0, 0, 0]);
    expect(holes(rig.newest(), rig.ready())).toEqual([]);
  });

  /**
   * CONTROL 3 — THE RECENCY PROTECTION. Eviction by date alone would take the body of an OLD
   * message the moment the reader opened it, because old is exactly what it is. The reader's hold
   * outranks the window, and the pass then asks for one rank fewer rather than trading that slot
   * with the trim every drain.
   */
  it("an old message the reader opened keeps its body, and the pass still settles", async () => {
    const rig = await rigOver(EAGER_BODIES_MAX + 200);
    await rig.pass();

    const old = rig.newest()[EAGER_BODIES_MAX + 100]!;
    await rig.engine.hydrateBody(old, { urgent: true });
    expect(rig.ready().has(old)).toBe(true);

    const after = await rig.pass();
    expect(rig.ready().has(old)).toBe(true);
    expect(after.ids).toBe(0);
    expect((await rig.pass()).ids).toBe(0);
    expect(rig.ready().size).toBeLessThanOrEqual(BODY_CACHE_MAX);
  });
});
