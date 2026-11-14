/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  ohboxView,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * MARK UNREAD PUTS A ROW BACK WHERE IT ARRIVED, ON THE SURFACE THAT PRESSED IT. The
 * paired desktop listed the row FIRST in New while the web, which only received the change, listed it
 * at its arrival place — for minutes. Measured: the engine's New is arrival order on both
 * (`packages/client-engine/test/unread-returns-to-its-arrival-place.test.ts`); the pressing surface's
 * `OhboxView` led its session order with every explicit unread. Driven here through a real engine
 * the way a paired desktop runs it (a relay answering with no rows, the echo on the next drain), the
 * view's own `u`, and the props the shell derives from `ohboxView`.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const writes: Promise<unknown>[] = [];

async function render(engine: OhmailEngine, selectedId: string | null): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const box = ohboxView(engine.read(), engine.openRowHeld());
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
      owed: false, demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: box.newForYou, previouslySeen: box.previouslySeen,
      tags: [], now: NOW,
      selectedId, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean) => {
        writes.push(engine.mutate({ kind: "mark_seen", messageIds: ids, unread }));
      },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null; writes.length = 0; echo.held = false;
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
      await Promise.all(writes);
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
