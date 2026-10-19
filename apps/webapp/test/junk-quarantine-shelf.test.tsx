/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "../app/shell/screener-state.js";
import type { JunkWindowControl } from "../app/shell/junk-window.js";
import type { JunkItemWire } from "../app/api-client.js";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { fillFrom } from "../app/shell/locale.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE QUARANTINE SHELF (FOLDERS-ON-SCREENER-LISTS-NO-QUARANTINE-PILE). With "Use folders" on the
 * third segment is the provider's Junk, read live; the letters ohmail keeps in ohmail/Quarantine
 * (AI placements, mailboxes without a Junk folder, verdicts not yet moved) were listed nowhere.
 * The server names them (`held`), and the segment lists them under the window with the Spam
 * preview's own Not spam choices, moving only what it lists.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };

let viewportNarrow = false;
function setViewport(narrow: boolean): void {
  viewportNarrow = narrow;
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    get matches() { return viewportNarrow && query.includes("max-width"); },
    media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;
}

const NOW = new Date("2026-10-19T12:00:00.000Z");
const MARK = NOW.getTime() - 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;

function msg(id: string, at: number, address: string, subject = `Probe subject ${id}`): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: `<${id}@x>`,
    subject, from: { name: "Probe Sender", address }, to: [], cc: [],
    date: iso(at), folder: "ohmail/Quarantine" as EngineMessage["folder"], snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(at),
  } as EngineMessage;
}

/** What the engine sent to the server, flattened — the moves a press made. */
let sent: string[] = [];

async function seededEngine(extra: EngineMessage[] = []): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    msg("q1", MARK + 60_000, "q1@spammer.invalid", "Cheap watches"),
    msg("q2", MARK + 120_000, "q2@spammer.invalid", "Lottery win"),
    ...extra,
  ].map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })) as SyncChange[]);
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (...args: unknown[]) => { sent.push(JSON.stringify(args)); return { changes: [], seq: null }; },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  } as never);
}

function item(uid: number): JunkItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity: "7", subject: `junk ${uid}`, from: { name: null, address: `s${uid}@example.invalid` },
    date: iso(MARK + uid * 60_000), messageIdHeader: `<mid-${uid}@x>`, seen: false, origin: "provider",
  };
}

function control(over: Partial<JunkWindowControl> & { query?: string } = {}): JunkWindowControl {
  const { query = "", ...rest } = over;
  return {
    supported: true, phase: "ready", items: [], visible: rest.items ?? [],
    mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "ok" }],
    nextCursor: null, olderLoading: false,
    reload: vi.fn(), loadOlder: vi.fn(),
    bodyFor: () => ({ phase: "ready", text: "" }), openBody: vi.fn(),
    rescue: vi.fn(), rescuing: () => false, dismissRescue: vi.fn(),
    search: { query, setQuery: vi.fn(), phase: query ? "local" : "idle", hits: [], localCount: (rest.items ?? []).length, mailboxes: [], truncated: false, searchServer: vi.fn() },
    sweep: { phase: "none", preview: null, requesting: false, request: vi.fn(), dismiss: vi.fn() },
    held: null,
    ...rest,
  } as JunkWindowControl;
}
const heldOf = (ids: string[], truncated = false) => ({ ids: new Set(ids), truncated });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(
  engine: OhmailEngine, junk: JunkWindowControl | undefined, opts: { locale?: "en" | "de" } = {},
): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    const [sel, setSel] = React.useState<string | null>(null);
    const [full, setFull] = React.useState(false);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state: ScreenerState = useScreenerState(engine, v, (() => {}) as never);
    return h(ScreenerView, {
      owed: false, state, segment: "spam", settled: true,
      selection: { waiting: null, screened: null, spam: sel } as never,
      onSelect: (_seg: string, id: string) => setSel(id),
      hydrateBody: () => {}, hydrateBodies: () => {}, full, onFull: setFull, junk,
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: opts.locale ?? "en",
      messages: (opts.locale === "de" ? fillFrom(messages as never, de as never) : messages) as never,
      timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

const text = (): string => host!.textContent ?? "";
const rowIds = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".row")].map((r) => r.getAttribute("data-id") ?? r.id);
const selectedId = (): string | null =>
  host!.querySelector<HTMLElement>(".row.sel, .row[aria-selected='true']")?.getAttribute("data-id") ?? null;
const buttonByText = (needle: string): HTMLButtonElement | null =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").includes(needle)) ?? null;
const click = async (el: Element | null): Promise<void> => {
  expect(el, "expected a control to click").not.toBeNull();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};
const press = async (key: string): Promise<void> => {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
};

beforeEach(() => {
  sent = [];
  setViewport(false);
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe("the Quarantine shelf under the Junk window", () => {
  it("folders on with both letters held lists both under In ohmail/Quarantine", async () => {
    await mount(await seededEngine(), control({ held: heldOf(["q1", "q2"]) }));
    expect(text()).toContain("In ohmail/Quarantine");
    expect(text()).toContain(messages.screener.quarantineShelfNote);
    expect(text()).toContain("q1@spammer.invalid");
    expect(text()).toContain("q2@spammer.invalid");
    expect(host!.querySelector('[aria-label="In ohmail/Quarantine"]')).not.toBeNull();
  });

  it("only held letters are listed; no held list shows no rows and no heading", async () => {
    await mount(await seededEngine(), control({ held: heldOf(["q1"]) }));
    expect(text()).toContain("q1@spammer.invalid");
    expect(text()).not.toContain("q2@spammer.invalid");
    await act(async () => { root!.unmount(); });
    host!.remove();
    await mount(await seededEngine(), control({ held: null }));
    expect(text()).not.toContain("spammer.invalid");
    expect(text()).not.toContain("In ohmail/Quarantine");
  });

  it("folders off is the Spam segment over the whole pile, no shelf heading", async () => {
    await mount(await seededEngine(), undefined);
    expect(text()).toContain("q1@spammer.invalid");
    expect(text()).toContain("q2@spammer.invalid");
    expect(text()).not.toContain("In ohmail/Quarantine");
  });

  it("Not spam → Ohbox moves the held letter and not the sender's letter filed to Junk; folders off moves both", async () => {
    const sibling = msg("p1", MARK + 30_000, "q1@spammer.invalid", "Older watches");
    await mount(await seededEngine([sibling]), control({ held: heldOf(["q1"]) }));
    await click(host!.querySelector('.row[data-id="q1"]') ?? [...host!.querySelectorAll(".row")].find((r) => (r.textContent ?? "").includes("q1@spammer")) ?? null);
    await click(buttonByText(messages.screener.notSpam));
    await click(buttonByText(messages.screener.notSpamOhbox));
    const moved = sent.join("\n");
    expect(moved).toContain("q1");
    expect(moved).not.toContain("p1");
    // Control: the folders-off segment releases the whole pile of the sender.
    await act(async () => { root!.unmount(); });
    host!.remove();
    sent = [];
    await mount(await seededEngine([msg("p1", MARK + 30_000, "q1@spammer.invalid", "Older watches")]), undefined);
    await click([...host!.querySelectorAll(".row")].find((r) => (r.textContent ?? "").includes("q1@spammer")) ?? null);
    await click(buttonByText(messages.screener.notSpam));
    await click(buttonByText(messages.screener.notSpamOhbox));
    const both = sent.join("\n");
    expect(both).toContain("q1");
    expect(both).toContain("p1");
  });

  it("in German the shelf speaks German, and the word Junk is nowhere", async () => {
    await mount(await seededEngine(), control({ held: heldOf(["q1"], true) }), { locale: "de" });
    expect(text()).toContain(de.screener.quarantineShelf);
    expect(text()).toContain(de.screener.quarantineShelfNote);
    expect(text()).toContain(de.screener.quarantineShelfTruncated);
    const said = [text(), ...[...host!.querySelectorAll("[aria-label], [placeholder]")]
      .flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? ""])];
    expect(said.filter((s) => /\bJunk\b/.test(s))).toEqual([]);
  });

  it("the no-folder sentence names the mailbox and never says there is nothing to show", async () => {
    await mount(await seededEngine(), control({
      held: heldOf(["q1"]),
      mailboxes: [
        { id: "mb1", address: "a@example.invalid", window: "ok" },
        { id: "mb2", address: "b@example.invalid", window: "no_junk_folder" },
      ],
    }));
    expect(text()).toContain("b@example.invalid has no Junk folder of its own");
    expect(text()).not.toMatch(/nothing to show/i);
    expect(messages.screener.junkNoFolder).not.toMatch(/nothing to show/i);
    expect(de.screener.junkNoFolder).not.toMatch(/nichts zu zeigen/i);
    expect(text()).toContain("q1@spammer.invalid");
  });

  it("j/k walk the window's rows, then the shelf's", async () => {
    await mount(await seededEngine(), control({ items: [item(5), item(4)], held: heldOf(["q1", "q2"]) }));
    const order = rowIds();
    expect(order.slice(0, 2)).toEqual(["mb1:7:5", "mb1:7:4"]);
    expect(order).toHaveLength(4);
    const seen: Array<string | null> = [selectedId()];
    for (let i = 0; i < 3; i++) { await press("j"); seen.push(selectedId()); }
    expect(seen).toEqual(order);
    await press("j");
    expect(selectedId()).toBe(order[3]);
    await press("k");
    expect(selectedId()).toBe(order[2]);
  });

  it("a typed query filters the shelf; no match hides the heading", async () => {
    await mount(await seededEngine(), control({ held: heldOf(["q1", "q2"]), query: "lottery" }));
    expect(text()).toContain("q2@spammer.invalid");
    expect(text()).not.toContain("q1@spammer.invalid");
    await act(async () => { root!.unmount(); });
    host!.remove();
    await mount(await seededEngine(), control({ held: heldOf(["q1", "q2"]), query: "invoice" }));
    expect(text()).not.toContain("spammer.invalid");
    expect(text()).not.toContain("In ohmail/Quarantine");
  });

  it("the cut sentence appears only when the answer was cut", async () => {
    await mount(await seededEngine(), control({ held: heldOf(["q1"], false) }));
    expect(text()).not.toContain(messages.screener.quarantineShelfTruncated);
    await act(async () => { root!.unmount(); });
    host!.remove();
    await mount(await seededEngine(), control({ held: heldOf(["q1"], true) }));
    expect(text()).toContain(messages.screener.quarantineShelfTruncated);
  });

  it("on a narrow viewport a tap on a shelf row opens the full preview", async () => {
    setViewport(true);
    await mount(await seededEngine(), control({ held: heldOf(["q1"]) }));
    await click([...host!.querySelectorAll(".row")].find((r) => (r.textContent ?? "").includes("q1@spammer")) ?? null);
    expect(host!.querySelector(".view-screener.scn-full")).not.toBeNull();
    expect(buttonByText(messages.screener.notSpam)).not.toBeNull();
  });
});
