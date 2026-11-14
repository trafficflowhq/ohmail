/** @vitest-environment jsdom */
import type { EngineMessage, ScreenerSuggestionEntity } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import {
  acceptDestOf,
  filterChoices,
  filterCounts,
  nextAfterDecision,
  screenerKeys,
  type ScreenerKeyWords,
  type ScreenerState,
} from "@ohmail/app-logic/screener";
import { useKeymap, type BoundKey } from "@ohmail/app-logic/keys/keymap";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE OLD VIEW AND THE NEW SCREEN AGREE, over the same real state hook and mirror: who opens after a decision, the
 * Screener's own key table, the filter's groups and their counts, and Enter's gate (it files a sender with a real
 * suggestion where it says, and nothing else). The old view is driven by its keys as a person drives it; the new
 * screen's side is the logic it draws from (`@ohmail/app-logic/screener`), held drawn by the folder's own tests.
 * Where the two are meant to differ it is said here, with the reason.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
/* jsdom has no CSS.escape; the old view reads a row by its id with it. */
const css = ((globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {});
css.escape ??= (s: string) => s.replace(/["\\]/g, "\\$&");
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SENDERS = [
  "ada@one.example",
  "ben@two.example",
  "cleo@three.example",
  "dan@four.example",
  "eve@five.example",
];
let seq = 0;

function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener",
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/** A real suggestion: News for two senders, the Ohbox for one; the other two have none. */
function suggestion(i: number, dest: string | null): ScreenerSuggestionEntity | null {
  if (dest === null) return null;
  return {
    id: `sg-${i}`,
    messageId: `m${i}`,
    senderKey: SENDERS[i]!,
    decision: "yes",
    destination: dest,
    spam: false,
    confidence: 0.9,
    boughtAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
    actRefusal: null,
    actRefusedAt: null,
  } as ScreenerSuggestionEntity;
}
const DESTS = ["reads", null, "reads", "ohbox", null];

async function engineWith(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows: SyncChange[] = SENDERS.map(
    (from, i): SyncChange => ({
      type: "message",
      op: "create",
      id: `m${i}`,
      seq: ++seq,
      updatedAt: "2026-08-02T09:00:00.000Z",
      entity: held(`m${i}`, from, 9 + i),
    }),
  );
  for (let i = 0; i < SENDERS.length; i++) {
    const s = suggestion(i, DESTS[i]!);
    if (s)
      rows.push({
        type: "screener_suggestion",
        op: "create",
        id: s.id,
        seq: ++seq,
        updatedAt: NOW.toISOString(),
        entity: s,
      } as SyncChange);
  }
  await store.applyChanges(rows);
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(),
        hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    } as never,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  host?.remove();
  root = null;
  host = null;
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++)
    await act(async () => {
      await Promise.resolve();
    });
};

interface Seen {
  state: ScreenerState | null;
  selected: string | null;
  decided: { id: string; dest: string; read: boolean }[];
  bindings: BoundKey[];
}

async function mount(): Promise<Seen> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const engine = await engineWith();
  const seen: Seen = { state: null, selected: null, decided: [], bindings: [] };
  function Keys(): null {
    seen.bindings = useKeymap().bindings;
    return null;
  }
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const real = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const state = React.useMemo(
      (): ScreenerState => ({
        ...real,
        decide: (sender, dest, opts) => {
          seen.decided.push({ id: sender.id, dest, read: opts?.read === true });
          real.decide(sender, dest, opts);
        },
      }),
      [real],
    );
    seen.state = state;
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null,
      screened: null,
      spam: null,
    });
    seen.selected = sel.waiting ?? null;
    return h(React.Fragment, null, [
      h(ScreenerView, {
        key: "view",
        owed: false,
        state,
        segment: "waiting",
        settled: true,
        selection: sel as never,
        onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
        hydrateBody: () => {},
        hydrateBodies: () => {},
        full: false,
        onFull: () => {},
      } as never),
      h(Keys, { key: "keys" }),
    ]);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        timeZone: "UTC",
        now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
  return seen;
}

async function key(k: string, shiftKey = false): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: shiftKey ? k.toUpperCase() : k, shiftKey, bubbles: true }),
    );
  });
  await flush();
}

const PER_DEST = { ohbox: "w", reads: "w", receipts: "w", screened: "w", spam: "w" };
const WORDS: ScreenerKeyWords = {
  next: "w",
  prev: "w",
  accept: "w",
  applyAll: "w",
  card: "w",
  segPrev: "w",
  segNext: "w",
  undo: "w",
  close: "w",
  file: PER_DEST,
  fileRead: PER_DEST,
};
/* `suggested`: the open sender's real suggestion, as the new screen hands it (null leaves Enter inert). */
const newTable = (state: ScreenerState, suggested: ReturnType<typeof acceptDestOf> = null) =>
  screenerKeys({
    words: WORDS,
    segment: "waiting",
    step: { down: () => {}, up: () => {} },
    decidable: true,
    decide: () => {},
    suggested,
    applyAll: state.suggestedCount > 0 ? () => {} : null,
    card: () => {},
    go: () => {},
    undo: () => {},
    escape: null,
  });

describe("the old Screener and the new screen", () => {
  it("open the same sender after a decision: the one below, never the top", async () => {
    const seen = await mount();
    const ids = seen.state!.waiting.map((w) => w.id);
    await key("j");
    await key("j");
    const from = seen.selected!;
    expect(ids.indexOf(from)).toBe(2);
    await key("n");
    expect(seen.decided).toEqual([{ id: from, dest: "screened", read: false }]);
    const exiting = new Set([from]);
    expect(seen.selected).toBe(nextAfterDecision(ids, from, (id) => !exiting.has(id)));
  });

  it("bind the same Screener keys, with Shift only on the three that let a sender in", async () => {
    const seen = await mount();
    const theirs = new Set(seen.bindings.filter((b) => b.group === "screener").map((b) => b.chord));
    const ours = new Set(
      newTable(seen.state!)
        .filter((b) => b.group === "screener")
        .map((b) => b.chord),
    );
    /* z takes the last decision back through the frame's one undo door, which this place binds; the old view left
       z to the shell's own binding. Every other chord is the old view's. */
    expect([...ours].filter((c) => !theirs.has(c))).toEqual(["z"]);
    expect([...theirs].filter((c) => !ours.has(c))).toEqual([]);
    expect([...ours].filter((c) => c.startsWith("shift+")).sort()).toEqual(["shift+c", "shift+o", "shift+r"]);
  });

  it("group the queue the same way, with the same counts", async () => {
    const seen = await mount();
    const state = seen.state!;
    const counts = filterCounts(state.waiting, state.isExiting);
    const chips = [...host!.querySelectorAll<HTMLElement>('[role="group"] button[aria-pressed]')]
      .map((b) => b.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((s) => /\d$/.test(s));
    const words: Record<string, string> = {
      reads: en.screener.pileReads,
      ohbox: en.screener.pileOhbox,
      none: en.screener.filterNone,
    };
    const all = filterChoices(counts).reduce((n, id) => n + counts[id], 0);
    expect(chips).toEqual([
      `${en.screener.filterAll} ${all}`,
      ...filterChoices(counts).map((id) => `${words[id]} ${counts[id]}`),
    ]);
  });

  it("let Enter file a sender with a real suggestion where it says, and nothing else", async () => {
    const seen = await mount();
    const at = (id: string) => seen.state!.waiting.find((w) => w.id === id)!;
    /* Walk to the first sender with no real suggestion. */
    for (let i = 0; i < SENDERS.length && acceptDestOf(at(seen.selected!)) !== null; i++) await key("j");
    expect(acceptDestOf(at(seen.selected!))).toBeNull();
    await key("Enter");
    expect(seen.decided).toEqual([]);
    const enter = (id: string) =>
      newTable(seen.state!, acceptDestOf(at(id))).find((b) => b.chord === "Enter")?.disabled;
    expect(enter(seen.selected!)).toBe(true);
    await key("j");
    const suggested = seen.selected!;
    const dest = acceptDestOf(at(suggested));
    expect(dest).not.toBeNull();
    expect(enter(suggested)).toBe(false);
    await key("Enter");
    expect(seen.decided).toEqual([{ id: suggested, dest, read: false }]);
  });
});
