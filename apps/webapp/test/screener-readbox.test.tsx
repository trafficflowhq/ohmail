/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * SCR-READBOX — the demoting piles have no "mark read" affordance.
 *
 * Owner UX feedback: a read/seen checkbox is meaningless for mail you are triaging OUT — held in
 * the Screener, or spam. You don't read what you screen out. So the ✓ ("& mark read") half of the
 * decision capsule is kept for the three admitting destinations (Ohbox, News, Receipts) and gone
 * from the two demoting ones (Screen out, Spam).
 *
 * Two things are asserted, and they are the two halves of the fix:
 *  1. THE UI. Render the real waiting Screener and confirm the ✓ exists for the mail piles and
 *     does NOT exist for Screen out / Spam — not merely hidden, absent from the tree. Mutation
 *     watch: before the DecisionBar edit the ✓ rendered for all five, so the absence assertions go
 *     red.
 *  2. THE FUNNEL. Every decision path (the ✓, o/r/c/n/x, ⇧Enter on an AI suggestion of a demoting
 *     destination) converges on `ScreenerState.decide`, which clamps `read` to false for the
 *     demoting piles. Asserted structurally: a screened decision taken WITH read:true emits no
 *     `mark_seen` mutation, while the same read:true to News does. Before the clamp both emitted
 *     one, so this is a projection someone remembers to keep narrow turned into a guard.
 *
 * `apps/webapp` typechecks its tests, so the state and mutation shapes below are checked too.
 */

// See the sync-liveness harness for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/** An engine over a mirror already holding `held`, with every mutation it issues recorded. */
async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
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

/** Mount the REAL waiting Screener over the REAL state hook; nothing is faked. */
async function mount(engine: OhmailEngine): Promise<{ latest: () => ScreenerState }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");

  let live: ScreenerState | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    live = state;
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
  return { latest: () => live! };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async () => json({})) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const label = (l: string) => host!.querySelector(`[aria-label="${l}"]`);

describe("SCR-READBOX — the demoting piles have no read/seen checkbox", () => {
  it("the ✓ renders for Ohbox / News / Receipts and NOT for Screen out / Spam", async () => {
    await mount(await engineWith([msg("m0", "stranger@example.com", 11)]));

    // The three admitting destinations keep the "& mark read" ✓.
    expect(label("Ohbox, mark read")).toBeTruthy();
    expect(label("News, mark read")).toBeTruthy();
    expect(label("Receipts, mark read")).toBeTruthy();

    // The two demoting destinations have none — absent from the tree, not hidden. You don't
    // read what you triage out.
    expect(label("Screened out, mark read")).toBeNull();
    expect(label("Spam, mark read")).toBeNull();

    // Exactly three ✓ halves; all five destinations still file (the main segment survives).
    expect(host!.querySelectorAll(".decide .d-read")).toHaveLength(3);
    expect(host!.querySelectorAll(".decide .d-main")).toHaveLength(5);
  });

  it("a screened decision taken WITH read:true emits no mark_seen — while News does", async () => {
    const engine = await engineWith([
      msg("a", "screenme@example.com", 11),
      msg("b", "readme@example.com", 10),
    ]);
    const { latest } = await mount(engine);

    const st = latest();
    const waiting = st.waiting;
    expect(waiting.length).toBe(2);
    const a = waiting.find((w) => w.from.address === "screenme@example.com")!;
    const b = waiting.find((w) => w.from.address === "readme@example.com")!;
    // Premise: both are derived rows whose held ids ARE message ids — the shape mark_seen needs,
    // so a green cannot mean "there was nothing to mark".
    expect(a.derived).toBe(true);
    expect(a.held.length).toBeGreaterThan(0);
    const aHeld = a.held.map((held) => held.id);
    const bHeld = b.held.map((held) => held.id);

    await act(async () => {
      // read:true on BOTH. The clamp is the only thing that distinguishes them.
      st.decide(a, "screened", { read: true, scope: "sender", quiet: true });
      st.decide(b, "reads", { read: true, scope: "sender", quiet: true });
      st.flush();
    });
    await flush();

    const markSeens = sent.filter((m) => m.kind === "mark_seen");
    // One mark_seen — the Reads decision's — and none for the screened one.
    expect(markSeens).toHaveLength(1);
    const seenIds = markSeens.flatMap((m) => (m as { messageIds: string[] }).messageIds);
    expect(seenIds).toEqual(bHeld);
    for (const id of aHeld) expect(seenIds).not.toContain(id);

    // Both decisions were still FILED — the mail is triaged, only the read flag is clamped.
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(2);
  });
});
