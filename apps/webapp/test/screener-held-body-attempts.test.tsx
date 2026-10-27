/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type Folder,
  type MessageBodyWire,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { BODY_STALL_MS } from "../app/shell/message-chrome.js";
import { settleFirstPaint } from "./_first-paint.js";
import { withBodyDoor } from "./_body-door.js";

/**
 * THE SCREENER'S HELD PREVIEW ASKS AS AN OPEN MESSAGE ASKS.
 *
 * A person is reading the selected sender's held mail, so its bodies must not queue behind
 * background work nobody is watching: behind four slots held by other requests the preview read
 * "Couldn't load the full message" at the stall bound while the body sat one ask away. And the
 * sentence says what is true after a Retry: a re-ask in the air reads as loading again.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const NOW = new Date("2026-09-24T08:00:00.000Z");
let seq = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function msg(id: string, folder: Folder, hour: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: folder === "ohmail/Screener" ? "stranger@example.test" : `${id}@example.test` },
    to: [], cc: [], date: `2026-09-24T${String(hour).padStart(2, "0")}:00:00.000Z`, folder,
    snippet: `one line of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** Four background messages whose bodies never answer, and a stranger's held mail. */
const BACKGROUND = ["b1", "b2", "b3", "b4"].map((id, i) => msg(id, "ohmail/News", 1 + i));
const heldOf = (n: number) => Array.from({ length: n }, (_, i) => msg(`h${i + 1}`, "ohmail/Screener", 6 + i));

const answer = (id: string): MessageBodyWire => ({
  text: `the whole of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
});

async function engineWith(
  seed: EngineMessage[], held: (id: string) => Promise<MessageBodyWire>, opts: { batch?: boolean } = {},
) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(seed.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  const asked: string[] = [];
  const batches: string[][] = [];
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: (id: string) => {
        asked.push(id);
        return id.startsWith("b") ? new Promise<MessageBodyWire>(() => {}) : held(id);
      },
      // The http adapter's batch route, where the rig asks for it: one request for many ids.
      ...(opts.batch ? {
        fetchBodies: async (ids: string[]) => {
          batches.push(ids);
          return Promise.all(ids.map(async (id) => ({ messageId: id, ...(await held(id)) })));
        },
      } : {}),
    },
  } as never);
  return { engine, asked, batches };
}

type Hydrate = (id: string, opts?: { retry?: boolean; urgent?: boolean }) => void;
type HydrateMany = (ids: string[], opts?: { urgent?: boolean }) => void;

async function mount(
  engine: OhmailEngine, hydrateBody: Hydrate,
  hydrateBodies: HydrateMany = (ids, o) => { void engine.hydrateBodies(ids, o); },
): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody, hydrateBodies, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: withBodyDoor(engine, h(KeymapProvider, { children: h(Probe) })),
    }));
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

const articles = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".scn-mails .hmail")];
const noteOf = (el: HTMLElement): string => el.querySelector(".hm-state")?.textContent ?? "";

beforeEach(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("the held preview's bodies are asked with urgency", () => {
  it("the selected sender's mounted held bodies are ONE urgent ask, never one per message", async () => {
    const { engine } = await engineWith(heldOf(6), async (id) => answer(id));
    const one: Array<[string[], { urgent?: boolean } | undefined]> = [];
    const each: string[] = [];
    await mount(engine, (id) => { each.push(id); }, (ids, opts) => { one.push([ids, opts]); });
    expect(one, "the preview a person is reading must not ask as background work").toHaveLength(1);
    // The newest three are mounted (`held-window.ts`); older letters are asked for as they mount.
    expect([...one[0]![0]].sort()).toEqual(["h4", "h5", "h6"]);
    expect(one[0]![1]).toEqual({ urgent: true });
    expect(each, "selection asks no single body and is no human re-ask").toEqual([]);
  });

  it("ten held on a server answering in 10 s, behind four busy slots, every mounted one draws by the stall bound (SCREENER-OLDER-HELD-BODIES)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = (id: string) => new Promise<MessageBodyWire>((r) => { setTimeout(() => r(answer(id)), 10_000); });
    const { engine, asked, batches } = await engineWith([...BACKGROUND, ...heldOf(10)], slow, { batch: true });
    for (const b of BACKGROUND) void engine.hydrateBody(b.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(asked.filter((id) => id.startsWith("b")), "premise: the four slots are taken").toHaveLength(4);
    await mount(engine, (id, opts) => { void engine.hydrateBody(id, opts); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });
    expect(batches, "one request for the mounted held letters").toHaveLength(1);
    const notes = articles().map(noteOf);
    expect(notes, "premise: the newest three of ten held messages drawn").toHaveLength(3);
    expect(notes.filter((n) => n.includes("Couldn't load"))).toEqual([]);
  });

  it("without a batch route the newest four ask urgently and every body still draws (the control)", async () => {
    const { engine } = await engineWith(heldOf(6), async (id) => answer(id));
    await mount(engine, (id, opts) => { void engine.hydrateBody(id, opts); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(articles().map((a) => a.querySelector(".hm-body")?.textContent ?? "").filter((t) => !t.includes("the whole of"))).toEqual([]);
  });

  it("behind four busy slots the held body is drawn, not 'Couldn't load' at the stall bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine, asked } = await engineWith([...BACKGROUND, ...heldOf(1)], async (id) => answer(id));
    for (const b of BACKGROUND) void engine.hydrateBody(b.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(asked.filter((id) => id.startsWith("b")), "premise: the four slots are taken").toHaveLength(4);
    await mount(engine, (id, opts) => { void engine.hydrateBody(id, opts); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });
    const [only] = articles();
    expect(only!.querySelector(".hm-body")!.textContent).toContain("the whole of h1");
    expect(noteOf(only!)).not.toContain("Couldn't load");
  });
});

describe("Retry says what is true while its re-ask is in the air", () => {
  it("after the stall face, Retry reads as loading again until the answer lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    const { engine } = await engineWith(heldOf(1), async (id) => { await late; return answer(id); });
    await mount(engine, (id, opts) => { void engine.hydrateBody(id, opts); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });
    const [only] = articles();
    expect(noteOf(only!), "premise: the stall face is up").toContain("Couldn't load");
    await act(async () => { only!.querySelector<HTMLButtonElement>(".hm-state button")!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(noteOf(articles()[0]!), "a pressed Retry with its request in the air is not a failure").toContain("Loading the full message");
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(articles()[0]!.querySelector(".hm-body")!.textContent).toContain("the whole of h1");
  });
});

describe("a held message over the download ceiling", () => {
  it("says why its body is empty, past the stall bound — never loading, never Couldn't load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine } = await engineWith(heldOf(1), async (id) => ({ ...answer(id), text: "", withheld: "too_large" }));
    await mount(engine, (id, opts) => { void engine.hydrateBody(id, opts); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });
    const note = noteOf(articles()[0]!);
    expect(note).toContain("Open it in your mail provider");
    expect(note).not.toContain("Couldn't load");
    expect(note).not.toContain("Loading the full message");
  });
});
