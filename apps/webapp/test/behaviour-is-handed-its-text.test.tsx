/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryMirrorStore,
  mutationEffects,
  OhmailEngine,
  type SyncChange,
} from "@ohmail/client-engine";
import type { Translator, TranslationValue } from "@ohmail/app-logic/text";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * Behaviour is handed its words. A hook that moves out of the web shell reads no catalogue of its own: the mount
 * hands it a `Translator`, and every sentence it makes leaves through that reader. Each case mounts the hook with NO
 * intl provider and a recording reader, and sees the sentence's key come out of it. Before each cut the hook asked
 * the web's catalogue itself and threw here ("No intl context found").
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A reader that answers each key with itself in guillemets and remembers what it was asked, and with what. */
function recording(): { t: Translator; asked: string[]; values: Array<Record<string, TranslationValue> | undefined> } {
  const asked: string[] = [];
  const values: Array<Record<string, TranslationValue> | undefined> = [];
  const t: Translator = (key, v) => {
    asked.push(key);
    values.push(v);
    return `«${key}»`;
  };
  return { t, asked, values };
}

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-04T09:00:00.000Z", folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-04T09:00:00.000Z",
  };
}

/** An engine over a mirror holding one stranger's letter in the Screener, answering each press from the mirror. */
async function engineWith(messages: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(el: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  return host;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("the zone model is handed its reader", () => {
  it("the arrows' labels in the key registry are the handed reader's words", async () => {
    // The registry as the frame mounts it (`Frame.tsx` `OwnKeys`): its context over the one store.
    const { KeymapContext, useKeymapStore } = await import("@ohmail/app-logic/keys");
    const KeymapProvider = ({ children }: { children?: React.ReactNode }): React.ReactElement =>
      h(KeymapContext.Provider, { value: useKeymapStore() }, children);
    const { useBinding } = await import("@ohmail/app-logic/keys/keymap");
    const { useZoneNav } = await import("@ohmail/app-logic/keys/zone-nav");
    const { t, asked } = recording();
    function Probe(): React.ReactElement {
      useZoneNav(t, {});
      return h("output", null, useBinding("ArrowLeft")?.label ?? "(no binding)");
    }
    const el = await mount(h(KeymapProvider, null, h(Probe)));
    expect(asked).toContain("zoneMenu");
    expect(el.querySelector("output")?.textContent).toMatch(/^«zone(Menu|List)»$/);
  });
});

describe("the Screener's state is handed its text", () => {
  it("a decision's sentence, its pile name and its Undo leave through the handed readers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const engine = await engineWith([held("h1", "giulia@terracotta.example")]);
    await engine.start();
    const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
    const screener = recording();
    const other = recording();
    const toasts: Array<{ message: string; action?: string }> = [];
    let latest: { waiting: unknown[]; decide: (s: unknown, d: string, o: { read: boolean; scope: string }) => void } | null = null;
    const text = {
      screener: screener.t, screening: other.t, ohbox: other.t, session: other.t,
      piles: { ohbox: "the-ohbox-pile", reads: "r", receipts: "c", screened: "s", spam: "x" },
      places: {}, locale: "en", zone: () => "UTC",
    };
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      latest = useScreenerState(
        engine, null, v, ((message: string, o?: { action?: string }) => { toasts.push({ message, action: o?.action }); }) as never,
        text as never,
      ) as never;
      return null;
    }
    await mount(h(Probe));
    await settleFirstPaint();
    expect(latest!.waiting).toHaveLength(1);
    await act(async () => { latest!.decide(latest!.waiting[0], "ohbox", { read: false, scope: "sender" }); });
    expect(toasts.at(-1)).toEqual({ message: "«toastFiled»", action: "«toastUndo»" });
    expect(screener.values[screener.asked.indexOf("toastFiled")]).toMatchObject({ dest: "the-ohbox-pile" });
  });
});

describe("sending is handed its text", () => {
  it("a sent letter's sentence leaves through the handed reader, and a held copy's time through the handed label", async () => {
    const { useMailSend, sentCopySay } = await import("@ohmail/app-logic/writing/mail-send");
    const engine = new OhmailEngine({
      store: new MemoryMirrorStore(),
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }),
        fetchBody: async () => null,
        mutate: async (_m: EngineMutation) => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
      } as never,
    });
    await engine.start();
    const { t, asked } = recording();
    const said: string[] = [];
    let send!: (m: unknown) => void;
    function Probe(): null {
      const mail = useMailSend(
        engine, null, ((text: string) => { said.push(text); }) as never,
        { t, scheduleLabel: (when: string) => `at ${when}` } as never, (() => {}) as never,
      );
      send = mail.send as unknown as (m: unknown) => void;
      return null;
    }
    await mount(h(Probe));
    await act(async () => {
      send({ kind: "mail_send", inReplyTo: null, body: "See you Friday.", subject: "Friday", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1" });
    });
    for (let i = 0; i < 100 && said.length === 0; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(said).toEqual(["«compose.toastSent»"]);
    expect(asked).toContain("compose.toastSent");
    const note = { state: "pending", until: "2026-08-04T12:00:00.000Z" } as never;
    expect((sentCopySay as unknown as (n: unknown, l: (w: string) => string) => { values: { time: string } })(note, (w) => `at ${w}`).values.time)
      .toBe("at 2026-08-04T12:00:00.000Z");
  });
});
