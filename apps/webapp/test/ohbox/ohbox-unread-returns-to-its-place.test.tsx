/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
} from "@ohmail/client-engine";
import { mountSeat, settleSeat, unmountSeat } from "../_ohbox-1-seat.js";

/**
 * MARK UNREAD PUTS A ROW BACK WHERE IT ARRIVED, ON THE SURFACE THAT PRESSED IT. The
 * paired desktop listed the row FIRST in New while the web, which only received the change, listed it
 * at its arrival place — for minutes. Measured: the engine's New is arrival order on both
 * (`packages/client-engine/test/unread-returns-to-its-arrival-place.test.ts`); the pressing surface's
 * `OhboxView` led its session order with every explicit unread. Driven here through a real engine
 * the way a paired desktop runs it (a relay answering with no rows, the echo on the next drain), the
 * view's own `u`, and the props the shell derives from `ohboxView`.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): from today's Ohbox view handed `ohboxView`'s lists
 * (`./_today.js`, which leaves with today's shell) to the Ohbox's own seat over the same real engine
 * (`../_ohbox-1-seat.tsx`, in the demo's world: an engine with no consent behind it, its mail not partitioned): the
 * seat derives its lists from the engine itself, the letter a step names is the seat's address, and `u` is the seat's
 * own key. Expectations untouched.
 */


function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

const NOW = new Date("2026-10-09T10:00:00.000Z");
const ARRIVALS = Array.from({ length: 6 }, (_, i) => ({
  id: `m${i + 1}`,
  at: new Date(Date.UTC(2026, 7, 2 - i * 2, 9)).toISOString(),
}));
const ARRIVAL_ORDER = ARRIVALS.map((a) => a.id);

function row(id: string, at: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: `t-${id}`, messageIdHeader: `${id}@x.test`,
    subject: id, from: { name: id, address: `${id}@x.test` }, to: [], cc: [],
    date: at, sortAt: at, folder: "INBOX", snippet: "s", unread: true, lastReadAt: null, openReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  } as EngineMessage;
}

/** While set, `/sync` serves nothing new: the surface reads the engine's overlay, never the echo. */
const echo = { held: false };

/** `PATCH /messages` as the server writes it; the relay answers with no rows and `/sync` echoes. */
function pairedAdapter(): EngineAdapter {
  const rows = new Map(ARRIVALS.map((a) => [a.id, row(a.id, a.at)]));
  let seq = 0;
  let served = 0;
  let clock = NOW.getTime();
  const log: SyncChange[] = [...rows.values()].map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  }));
  return {
    async sync() {
      if (echo.held) {
        const none = { creates: [], updates: [], moves: [], deletes: [] };
        return { changes: none, cursor: `c${served}`, hasMore: false, serverTime: NOW.toISOString() };
      }
      const fresh = log.slice(served);
      served = log.length;
      return {
        changes: { creates: fresh.filter((c) => c.op === "create"), updates: fresh.filter((c) => c.op === "update"), moves: [], deletes: [] },
        cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    async mutate(m: EngineMutation) {
      if (m.kind !== "mark_seen") return { changes: [], seq: null };
      const at = new Date((clock += 1000)).toISOString();
      for (const id of m.messageIds) {
        const prev = rows.get(id);
        if (!prev) continue;
        const openRead = (m as { openRead?: boolean }).openRead === true;
        const next = {
          ...prev, unread: m.unread, lastReadAt: m.unread ? null : at, updatedAt: at,
          openReadAt: m.unread ? null : openRead && prev.unread ? at : prev.openReadAt ?? null,
        } as EngineMessage;
        rows.set(id, next);
        log.push({ type: "message", op: "update", id, seq: ++seq, updatedAt: at, entity: next });
      }
      return { changes: [], seq: null };
    },
    fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false }),
  } as unknown as EngineAdapter;
}

let host: HTMLElement | null = null;
/** The seat's address, once it stands. */
let visit: ((next: string) => void) | null = null;

/**
 * The surface over the engine as it is NOW, with `selectedId` the letter open (the seat's address names it) or none.
 * The first call stands the seat; a later one only moves its address, and the seat re-reads the engine itself.
 */
async function render(engine: OhmailEngine, selectedId: string | null): Promise<void> {
  if (host === null) {
    const seated = mountSeat(engine, { demo: true, first: selectedId === null ? "#/ohbox" : `#/ohbox/m/${selectedId}` });
    host = seated.container;
    visit = seated.address.visit;
  } else {
    await act(async () => { visit!(selectedId === null ? "#/ohbox" : `#/ohbox/m/${selectedId}`); });
  }
  await settleSeat();
  await settleSeat();
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });

afterEach(() => {
  unmountSeat();
  host = null; visit = null; echo.held = false;
});

/** The tester's steps on `id`: open it out of New, read it while open, move on, re-open it. */
async function readMoveOnReopen(engine: OhmailEngine, id: string): Promise<void> {
  await render(engine, null);
  expect(engine.holdOpenRow(id)).toBe(true);
  await engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" });
  await render(engine, id);
  engine.releaseOpenRow(id);
  await engine.syncOnce();
  await render(engine, null);
  await settle();
  await render(engine, null);
  expect(idsInGroup("Earlier"), "CONTROL: a read row goes to the top of Earlier").toEqual([id]);
  expect(engine.holdOpenRow(id)).toBe(false);
  await render(engine, id);
}

async function pairedDesktop(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({
    adapter: pairedAdapter(), store: new MemoryMirrorStore(), now: () => NOW,
    storePolicy: { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 },
  });
  await engine.start();
  await engine.syncOnce();
  return engine;
}

describe("Mark unread on the surface that pressed it: the row is at its arrival place in New", () => {
  for (const id of ["m2", "m5"]) {
    it(`${id}: read, moved on, re-opened, u — New is the engine's arrival order, at once and after the echo`, async () => {
      setViewport();
      const engine = await pairedDesktop();
      await render(engine, null);
      expect(idsInGroup("New"), "the premise").toEqual(ARRIVAL_ORDER);

      await readMoveOnReopen(engine, id);
      expect(idsInGroup("New"), "CONTROL: a never-opened row keeps its arrival place")
        .toEqual(ARRIVAL_ORDER.filter((x) => x !== id));

      echo.held = true;
      await press("u");
      await settleSeat();               // the seat's write through the engine (today's harness awaited its promise)
      await render(engine, id);
      expect(idsInGroup("New"), "at once, on the overlay").toEqual(ARRIVAL_ORDER);

      echo.held = false;
      await engine.syncOnce();
      await render(engine, id);
      await settle();
      await render(engine, null);
      expect(idsInGroup("New"), "after the echo, and it stays").toEqual(ARRIVAL_ORDER);
      expect(idsInGroup("Earlier")).toEqual([]);
    });
  }
});
