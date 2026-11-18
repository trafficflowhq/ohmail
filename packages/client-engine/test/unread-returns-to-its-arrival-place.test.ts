import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  ohboxRows,
  ohboxView,
  type EngineAdapter,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * MARK UNREAD PUTS A ROW BACK WHERE IT ARRIVED. The engine half, driven the
 * way a Cloud-paired desktop runs it: a windowed mirror, a write the relay answers with no rows, and
 * the server's echo arriving on the next drain. Open, read, move on (top of Earlier), re-open, mark
 * unread: New is the server's arrival order before the echo and after it, and the rows the phone draws
 * (`ohboxRows`, which `liveOhbox` reshapes) say the same. The surface half — the
 * session order `OhboxView` keeps — is `apps/webapp/test/ohbox-unread-returns-to-its-place.test.tsx`.
 */

const NOW = new Date("2026-10-09T10:00:00.000Z");
const ARRIVALS = Array.from({ length: 11 }, (_, i) => ({
  id: `m${String(i + 1).padStart(2, "0")}`,
  at: new Date(Date.UTC(2026, 7, 2 - i * 2, 9)).toISOString(),
}));
const ARRIVAL_ORDER = ARRIVALS.map((a) => a.id);

function row(id: string, at: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: `t-${id}`, messageIdHeader: `${id}@x.test`,
    subject: `Subject ${id}`, from: { name: id, address: `${id}@x.test` }, to: [], cc: [],
    date: at, sortAt: at, folder: "INBOX", snippet: "s", unread: true, lastReadAt: null, openReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  } as EngineMessage;
}

/** The server: `PATCH /messages` as `message-service.ts` writes it, its changes served by `/sync`. */
function pairedServer() {
  const rows = new Map(ARRIVALS.map((a) => [a.id, row(a.id, a.at)]));
  let seq = 0;
  let served = 0;
  const log: SyncChange[] = [...rows.values()].map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  }));
  let clock = NOW.getTime();
  /** While set, `/sync` serves nothing new: the engine reads its own overlay, never the echo. */
  const echo = { held: false };
  const adapter: EngineAdapter = {
    async sync() {
      if (echo.held) {
        const none = { creates: [], updates: [], moves: [], deletes: [] };
        return { changes: none, cursor: `c${served}`, hasMore: false, serverTime: NOW.toISOString() };
      }
      const creates = log.slice(served).filter((c) => c.op === "create");
      const updates = log.slice(served).filter((c) => c.op === "update");
      served = log.length;
      return { changes: { creates, updates, moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    async mutate(m: EngineMutation) {
      if (m.kind !== "mark_seen") return { changes: [], seq: null };
      const at = new Date((clock += 1000)).toISOString();
      for (const id of m.messageIds) {
        const prev = rows.get(id);
        if (!prev) continue;
        const openRead = (m as { openRead?: boolean }).openRead === true;
        const next: EngineMessage = {
          ...prev, unread: m.unread, lastReadAt: m.unread ? null : at, updatedAt: at,
          openReadAt: m.unread ? null : openRead && prev.unread ? at : prev.openReadAt ?? null,
        };
        rows.set(id, next);
        log.push({ type: "message", op: "update", id, seq: ++seq, updatedAt: at, entity: next });
      }
      // The relay answers the write and carries no rows: the echo is the next drain's.
      return { changes: [], seq: null };
    },
    fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false }),
  } as unknown as EngineAdapter;
  return { adapter, echo };
}

async function pairedDesktop() {
  const { adapter, echo } = pairedServer();
  const engine = new OhmailEngine({
    adapter, store: new MemoryMirrorStore(), now: () => NOW,
    storePolicy: { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 },
  });
  await engine.start();
  await engine.syncOnce();
  return { e: engine, echo };
}

const ids = (list: readonly EngineMessage[]) => list.map((m) => m.id);
const box = (e: OhmailEngine) => ohboxView(e.read(), e.openRowHeld());
const phoneNew = (e: OhmailEngine) => ohboxRows(e.read(), e.openRowHeld()).new.map((r) => r.members[0]!.id);

/** Open `id` out of New, read it while open, move on: the open read lifts it to the top of Earlier. */
async function openReadMoveOn(e: OhmailEngine, id: string) {
  expect(e.holdOpenRow(id)).toBe(true);
  expect((await e.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" })).status).toBe("confirmed");
  e.releaseOpenRow(id);
  await e.syncOnce();
}

describe("the paired desktop's engine: Mark unread returns the row to its arrival place in New", () => {
  it("the tester's steps: 2nd row read, moved on, re-opened, marked unread — New is arrival before and after the echo", async () => {
    const { e, echo } = await pairedDesktop();
    expect(ids(box(e).newForYou), "the premise: New in arrival order").toEqual(ARRIVAL_ORDER);

    await openReadMoveOn(e, "m02");
    expect(ids(box(e).previouslySeen), "CONTROL: a read row goes to the top of Earlier").toEqual(["m02"]);
    expect(e.read().get<EngineMessage>("message", "m02")?.openReadAt, "the premise: the row is lifted").toBeTruthy();
    expect(ids(box(e).newForYou)).toEqual(ARRIVAL_ORDER.filter((x) => x !== "m02"));

    expect(e.holdOpenRow("m02"), "re-opening a read row holds nothing").toBe(false);
    echo.held = true;
    expect((await e.mutate({ kind: "mark_seen", messageIds: ["m02"], unread: true })).status).toBe("confirmed");
    expect(ids(box(e).newForYou), "the overlay").toEqual(ARRIVAL_ORDER);
    expect(phoneNew(e), "the phone's rows, the overlay").toEqual(ARRIVAL_ORDER);
    // A lifted placement never survives an unread, in the overlay as on the server.
    expect(e.read().get<EngineMessage>("message", "m02")?.openReadAt ?? null, "the overlay clears the lift").toBeNull();

    echo.held = false;
    await e.syncOnce();
    await e.syncOnce();
    expect(ids(box(e).newForYou), "the echo").toEqual(ARRIVAL_ORDER);
    expect(phoneNew(e), "the phone's rows, the echo").toEqual(ARRIVAL_ORDER);
    expect(ids(box(e).previouslySeen)).toEqual([]);
    expect(e.read().get<EngineMessage>("message", "m02")?.openReadAt ?? null, "the echo clears it").toBeNull();
  });

  it("the reproduction's row (5th) and a never-opened row: both keep their arrival places", async () => {
    const { e } = await pairedDesktop();
    await openReadMoveOn(e, "m05");
    await e.mutate({ kind: "mark_seen", messageIds: ["m05"], unread: true });
    await e.syncOnce();
    expect(ids(box(e).newForYou)).toEqual(ARRIVAL_ORDER);
    expect(ids(box(e).newForYou).indexOf("m07"), "CONTROL: a never-opened row keeps its arrival place").toBe(6);
  });
});
