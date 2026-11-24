import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  SNAPSHOT_REFUSAL_HOLD_BASE_MS,
  SNAPSHOT_REFUSAL_HOLD_CAP_MS,
  SnapshotCursorRefusedError,
  encodeSeqCursor,
  type EngineAdapter,
  type SyncResponse,
} from "../src/index.js";

/**
 * A DOOR THAT REFUSES THE CURSOR ITS OWN SNAPSHOT ISSUED IS ANSWERED ONCE, NOT ON EVERY DRAIN.
 *
 * A 410 is answered by one wipe and one snapshot. A 410 on the pull right after that snapshot is
 * the door's defect: another snapshot would be refused the same way, and the Windows rig paid one
 * per drain for eleven hours. So the engine keeps the snapshot's rows, surfaces the refusal by
 * name, and takes no snapshot read until a doubling hold ends. An accepted pull ends the hold.
 */

const t0 = Date.parse("2026-09-25T10:00:00.000Z");
const AS_OF = 900;

function msg(id: string, at: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" }, to: [], cc: [],
    date: at, folder: "INBOX", snippet: "snippet", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  };
}

interface Door {
  adapter: EngineAdapter;
  /** Snapshot pages served, and `/sync` pulls asked. */
  snapshots: number;
  pulls: number;
  /** Whether the door takes a non-zero cursor right now. */
  accepts: boolean;
}

/** A door that states a snapshot and refuses (or takes) every cursor but "0". */
function door(clock: { t: number }): Door {
  const d: Door = { snapshots: 0, pulls: 0, accepts: false, adapter: undefined as unknown as EngineAdapter };
  const at = (): string => new Date(clock.t).toISOString();
  d.adapter = {
    sync: async (p: { since: string }): Promise<SyncResponse> => {
      d.pulls += 1;
      if (p.since !== "0" && !d.accepts) throw new CursorExpiredError();
      return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: p.since, hasMore: false, serverTime: at() };
    },
    snapshot: async (): Promise<SyncSnapshotPage> => {
      d.snapshots += 1;
      return {
        asOfSeq: AS_OF,
        changes: [{ type: "message", op: "create", id: "m1", seq: AS_OF, updatedAt: at(), entity: msg("m1", at()) }],
        nextCursor: null,
        window: { days: 30, minRows: 500 },
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return d;
}

async function engineOver(d: Door, clock: { t: number }): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore }> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: d.adapter, store, now: () => new Date(clock.t), storePolicy: { mode: "full" } });
  return { engine, store };
}

async function drain(engine: OhmailEngine): Promise<string> {
  try { await engine.syncOnce(); return "ok"; } catch (err) { return (err as Error).name; }
}

describe("a door that refuses the cursor its own snapshot issued", () => {
  /** WATCHED RED at base and under `if (false && snapshotIssued)`: one snapshot per drain. */
  it("takes ONE snapshot, then holds: no wipe and no snapshot read on the drains inside the hold", async () => {
    const clock = { t: t0 };
    const d = door(clock);
    const { engine, store } = await engineOver(d, clock);

    const first = await drain(engine);
    expect(d.snapshots, "the cold start is one snapshot, and its refused cursor is not a second").toBe(1);
    expect(first).toBe("SnapshotCursorRefusedError");
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.t += 10_000;
      outcomes.push(await drain(engine));
    }
    expect(d.snapshots, "a drain inside the hold re-snapshotted").toBe(1);
    expect(d.pulls, "each held drain asks once, so an accepting door is noticed").toBe(6);
    expect(outcomes).toEqual(Array(5).fill("SnapshotCursorRefusedError"));
    // The snapshot's rows stay: stale is better than an empty list re-downloaded every drain.
    expect(store.entries<EngineMessage>("message").map((e) => e.id)).toEqual(["m1"]);
  });

  it("re-snapshots once when the hold ends, and doubles the hold on a second refusal", async () => {
    const clock = { t: t0 };
    const d = door(clock);
    const { engine } = await engineOver(d, clock);
    await drain(engine);

    clock.t += SNAPSHOT_REFUSAL_HOLD_BASE_MS;
    expect(await drain(engine)).toBe("SnapshotCursorRefusedError");
    expect(d.snapshots, "the hold ended, so one 410 is answered by one snapshot again").toBe(2);

    // The second refusal holds twice as long: still held just before 2 x base.
    clock.t += 2 * SNAPSHOT_REFUSAL_HOLD_BASE_MS - 1;
    await drain(engine);
    expect(d.snapshots).toBe(2);
    clock.t += 1;
    await drain(engine);
    expect(d.snapshots).toBe(3);
  });

  it("caps the hold", async () => {
    const clock = { t: t0 };
    const d = door(clock);
    const { engine } = await engineOver(d, clock);
    await drain(engine);
    for (let i = 0; i < 12; i++) {
      clock.t += SNAPSHOT_REFUSAL_HOLD_CAP_MS;
      await drain(engine);
    }
    const before = d.snapshots;
    expect(before, "every drain past a capped hold is one snapshot").toBe(13);
    clock.t += SNAPSHOT_REFUSAL_HOLD_CAP_MS - 1;
    await drain(engine);
    expect(d.snapshots, "held past the cap").toBe(before);
    clock.t += 1;
    await drain(engine);
    expect(d.snapshots).toBe(before + 1);
  });

  it("ends the hold on an accepted pull, so the next refusal starts from the first figure", async () => {
    const clock = { t: t0 };
    const d = door(clock);
    const { engine, store } = await engineOver(d, clock);
    await drain(engine);
    d.accepts = true;
    clock.t += 1_000;
    expect(await drain(engine), "a held drain whose pull is accepted completes").toBe("ok");
    expect(store.getMeta<string>(LAST_DRAIN_AT_META)).toBe(new Date(clock.t).toISOString());

    // A later ordinary 410 is answered by one snapshot at once, and its own refusal holds the BASE.
    d.accepts = false;
    clock.t += 1_000;
    expect(await drain(engine)).toBe("SnapshotCursorRefusedError");
    expect(d.snapshots).toBe(2);
    clock.t += SNAPSHOT_REFUSAL_HOLD_BASE_MS;
    await drain(engine);
    expect(d.snapshots, "the refusal after an accepted pull held longer than the first figure").toBe(3);
  });

  /** The ordinary path, unchanged: an expired cursor, one snapshot, an accepted pull, no error. */
  it("still answers an ordinary 410 with one snapshot the door then accepts", async () => {
    const clock = { t: t0 };
    const d = door(clock);
    const { engine, store } = await engineOver(d, clock);
    store.forceCursor("stale");
    await store.setMeta(LAST_DRAIN_AT_META, new Date(clock.t).toISOString());
    let first = true;
    const sync = d.adapter.sync.bind(d.adapter);
    d.adapter.sync = async (p) => {
      if (first) { first = false; d.pulls += 1; throw new CursorExpiredError(); }
      d.accepts = true;
      return sync(p);
    };
    expect(await drain(engine)).toBe("ok");
    expect(d.snapshots).toBe(1);
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });

  it("names the refusal as a cursor expiry too, for readers that ask only that", () => {
    const err = new SnapshotCursorRefusedError();
    expect(err).toBeInstanceOf(CursorExpiredError);
    expect(err.name).toBe("SnapshotCursorRefusedError");
  });
});
