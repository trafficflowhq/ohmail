/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  MutationRejectedError,
  consentPartition,
  mutationEffects,
  presentationReader,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { screenerIntentsKey } from "../app/shell/screener-intents";
import { INTENT_ASK_MS } from "../app/shell/intent-windows";

/**
 * A card decision replayed after a restart moves only the INBOX letters that are still the card's:
 * the journal names them at the press, and the replay reads each one again. A letter moved by hand
 * in between, or one whose place was decided since, stays where it is.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-10T09:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];

function msg(id: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "s@letters.example" }, to: [], cc: [],
    date: "2026-10-10T08:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-10T08:00:00.000Z", senderCheck: null,
  };
}

async function put(store: MirrorStore, ms: EngineMessage[]): Promise<void> {
  await store.applyChanges(ms.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
}

/**
 * `server`: where the server itself holds each letter, where a case asks — it applies a conditional
 * move only while the letter is still there and refuses it `stale_press` otherwise, as production does.
 */
function engineOver(store: MirrorStore, server?: Map<string, string>): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        if (server && m.kind === "move") {
          if (m.from !== undefined && server.get(m.messageId) !== m.from) {
            throw new MutationRejectedError("stale", { status: 409, code: "stale_press", retryable: false });
          }
          server.set(m.messageId, m.folder);
        }
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; held: Array<{ id: string }> }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountState(engine: OhmailEngine): Promise<{ get: () => StateLike; bump: () => Promise<void> }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: StateLike | null = null;
  let force: (() => void) | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const raw = engine.read();
    latest = useScreenerState(
      engine, v, (() => {}) as never, undefined, presentationReader(raw, consentPartition(raw, { now: NOW })),
    ) as unknown as StateLike;
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  await settleFirstPaint();
  return {
    get: () => latest!,
    bump: async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(INTENT_ASK_MS + 10); });
      await act(async () => { force?.(); });
    },
  };
}

/** The tab dies inside the undo window: nothing was sent, the journal is on disk. */
async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllTimers();
  vi.setSystemTime(NOW);
}

/** Press the card, kill the tab, let `between` change the mirror, restart. */
async function replayAfter(between: (store: MirrorStore) => Promise<void>): Promise<string[]> {
  const store = new MemoryMirrorStore();
  await store.load();
  await put(store, [msg("h1", "ohmail/Screener"), msg("i1", "INBOX")]);
  const first = await mountState(engineOver(store));
  expect(first.get().waiting[0]?.held.map((x) => x.id).sort()).toEqual(["h1", "i1"]);
  await act(async () => { first.get().decide(first.get().waiting[0], "reads", { read: false, scope: "sender" }); });
  const rows = JSON.parse(window.localStorage.getItem(screenerIntentsKey())!) as Array<{ inboxIds?: string[] }>;
  expect(rows[0]!.inboxIds).toEqual(["i1"]);
  await killTab();
  expect(sent).toEqual([]);
  await between(store);
  const second = await mountState(engineOver(store));
  await second.bump();
  await act(async () => { await Promise.resolve(); });
  expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(1);
  return sent.flatMap((m) => (m.kind === "move" ? [`${m.messageId}>${m.folder}`] : []));
}

const update = (store: MirrorStore, m: EngineMessage) =>
  store.applyChanges([{ type: "message", op: "update", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m }]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  window.localStorage.clear();
});

afterEach(async () => {
  await killTab();
  vi.useRealTimers();
});

describe("a replayed card decision reads its letters again", () => {
  it("CONTROL: a letter still in the INBOX is moved by the replay", async () => {
    expect(await replayAfter(async () => {})).toEqual(["i1>ohmail/News"]);
  });

  it("a letter whose place was decided since the press stays where it is", async () => {
    expect(await replayAfter((s) => update(s, { ...msg("i1", "INBOX"), placeDecided: true }))).toEqual([]);
  });

  it("filed elsewhere while the app was closed, before the mirror caught up: the server leaves it there", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await put(store, [msg("h1", "ohmail/Screener"), msg("i1", "INBOX")]);
    const first = await mountState(engineOver(store));
    await act(async () => { first.get().decide(first.get().waiting[0], "reads", { read: false, scope: "sender" }); });
    await killTab();
    // The person files the letter in another mail app; this copy has not synced since.
    const server = new Map<string, string>([["h1", "ohmail/Screener"], ["i1", "ohmail/Receipts"]]);
    const second = await mountState(engineOver(store, server));
    await second.bump();
    await act(async () => { await Promise.resolve(); });
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "i1", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
    expect(server.get("i1")).toBe("ohmail/Receipts");
  });

  it("a letter moved by hand since the press stays where it was put", async () => {
    expect(await replayAfter((s) => update(s, msg("i1", "ohmail/Receipts")))).toEqual([]);
  });
});
