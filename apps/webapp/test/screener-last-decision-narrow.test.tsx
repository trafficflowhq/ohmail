/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, mutationEffects,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider, ToastHost, useToast } from "@ohmail/ui";
import messages from "../messages/en.json";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE LAST DECISION ON A PHONE LANDS SOMEWHERE. At phone width the preview is a
 * fixed layer over the whole app; deciding the last waiting sender from it left that layer up
 * and empty, over the navigation and the list's "No one's waiting.". The view now honours `full`
 * only while a sender resolves and hands it back on the same condition. The stylesheet's own
 * narrow rules are loaded, so "covered" is the cascade's answer, not a class name.
 * Mutations watched red: the effect's `onFull(false)` dropped (last decision, Undo, hand-back),
 * and the section's class reading raw `full` (a host that has not cleared yet).
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/** A 414px phone: every max-width at or above it matches, every min-width above it does not.
 *  The ladder's edges are fractional (`699.98px`), so the number is read with its decimals. */
const WIDTH = 414;
function phoneMatch(query: string): boolean {
  const conds = [...query.matchAll(/\((min|max)-width:\s*(\d+(?:\.\d+)?)px\)/g)];
  if (conds.length === 0) return false;
  return conds.every(([, side, px]) => (side === "max" ? WIDTH <= Number(px) : WIDTH >= Number(px)));
}

/** The two rules that decide whether `.scn-read` covers the app, lifted from the narrow block. */
function narrowScreenerRules(): string {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  const re = /@media[^{]*max-width: 699\.98px[^{]*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const block = src.slice(re.lastIndex, i - 1);
    for (const sel of [/\.view-screener \.scn-read \{[^}]*\}/, /\.view-screener\.scn-full \.scn-read \{[^}]*\}/]) {
      const hit = sel.exec(block)?.[0];
      if (hit) out.push(hit);
    }
    re.lastIndex = i;
  }
  return out.join("\n");
}

const NOW = new Date("2026-09-27T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let style: HTMLStyleElement | null = null;

function msg(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-27T09:00:00.000Z", folder: "ohmail/Screener" as Folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-27T09:00:00.000Z",
  };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
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
          .map((e) => ({ type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}) }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

/** The host's `full`, as the shell holds it — or a host whose clear has not landed (`sticky`). */
let hostFull = false;
let fullCalls: boolean[] = [];

async function mount(engine: OhmailEngine, opts: { full?: boolean; sticky?: boolean } = {}): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  function Probe(): React.ReactElement {
    const toast = useToast();
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, toast, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    const [full, setFull] = React.useState(opts.full ?? false);
    hostFull = full;
    const onFull = React.useCallback((f: boolean) => {
      fullCalls.push(f);
      if (!opts.sticky) setFull(f);
    }, []);
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full, onFull,
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(KeymapProvider, { children: h(Probe) }) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };

const section = (): HTMLElement => host!.querySelector<HTMLElement>("section.view-screener")!;
const readCol = (): HTMLElement => host!.querySelector<HTMLElement>(".view-screener .scn-read")!;
const rowIds = (): string[] => [...host!.querySelectorAll(".view-screener .rows .row[data-id]")].map((n) => n.getAttribute("data-id")!);
/** Drawn: neither the element nor an ancestor computes to `display: none`. */
const drawn = (el: Element): boolean => {
  for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).display === "none") return false;
  return true;
};
/** Covered: a drawn fixed layer that is not this element's own ancestor stands over the viewport. */
const covered = (el: Element): boolean =>
  [...document.querySelectorAll("*")].some((n) => !n.contains(el) && getComputedStyle(n).position === "fixed" && drawn(n));
const segmentTabs = (): HTMLElement => host!.querySelector<HTMLElement>(".view-screener [role=tablist]")!;
const emptyWaiting = (): HTMLElement | undefined =>
  [...host!.querySelectorAll<HTMLElement>(".empty")].find((n) => (n.textContent ?? "").includes(messages.screener.empty.waiting.title));

async function tapRow(id: string): Promise<void> {
  const row = host!.querySelector<HTMLButtonElement>(`.view-screener .row[data-id="${id}"]`);
  if (!row) throw new Error(`no row ${id} — on screen: ${rowIds().join(", ")}`);
  await act(async () => { row.click(); });
  await flush();
}
async function pressBar(label: string): Promise<void> {
  const b = [...readCol().querySelectorAll<HTMLButtonElement>(".d-btns .d-main")].find((x) => (x.textContent ?? "").includes(label));
  if (!b) throw new Error(`no "${label}" in the preview's decision bar`);
  await act(async () => { b.click(); });
  await flush();
}
const undoButton = (): HTMLButtonElement | null => document.querySelector(".toast-held .toast-act");

beforeEach(() => {
  sent = [];
  fullCalls = [];
  hostFull = false;
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: phoneMatch(query), media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    }),
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = (typeof input === "string" ? input : String(input)).replace(/^\/api/, "");
    if (path.startsWith("/screener")) return json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    return json({});
  }) as typeof fetch;
  style = document.createElement("style");
  style.textContent = narrowScreenerRules();
  document.head.appendChild(style);
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  style?.remove();
  root = null;
  host = null;
  style = null;
});

describe("the last decision on a phone lands somewhere", () => {
  it("premise: the stylesheet's narrow rules are loaded and the full-screen preview does cover the view", async () => {
    expect(style!.textContent, "both narrow rules were lifted from app.css").toMatch(/scn-full[^{]*\{[^}]*position: fixed/);
    await mount(await engineWith([msg("m1", "one@example.test")]));
    expect(drawn(readCol()), "a phone hides the read column until a sender is opened").toBe(false);
    await tapRow("m1");
    expect(section().className).toContain("scn-full");
    expect(drawn(readCol()) && getComputedStyle(readCol()).position, "the preview is the fixed layer").toBe("fixed");
    expect(covered(segmentTabs()), "and it stands over the list's own navigation").toBe(true);
  });

  it("deciding the only waiting sender returns to the list, where 'No one's waiting.' is drawn and reachable", async () => {
    await mount(await engineWith([msg("m1", "one@example.test")]));
    await tapRow("m1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await pressBar("Ohbox");
    expect(section().className, "full mode left with the sender").not.toContain("scn-full");
    expect(hostFull, "and was handed back to the host").toBe(false);
    await tick(400); // the row's exit
    const empty = emptyWaiting();
    expect(empty, "the list says nobody is waiting").toBeDefined();
    expect(empty!.closest(".scn-read"), "in the list pane, not the read column").toBeNull();
    expect(drawn(empty!), "and it is drawn").toBe(true);
    expect(drawn(readCol()), "the empty read column is not").toBe(false);
    expect(drawn(segmentTabs()) && !covered(segmentTabs()), "the segment tabs are reachable").toBe(true);
    await tick(COMMIT_MS + 20_000); // past the commit, as the tester waited
    expect(sent.filter((m) => m.kind === "screener_decide"), "the decision was sent").toHaveLength(1);
    expect(section().className).not.toContain("scn-full");
    expect(drawn(emptyWaiting()!)).toBe(true);
  });

  it("control: with a second sender waiting the preview advances to it and full mode stays", async () => {
    await mount(await engineWith([msg("m1", "one@example.test"), msg("m2", "two@example.test")]));
    await tapRow("m1");
    expect(readCol().textContent).toContain("Subject m1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await pressBar("Ohbox");
    await tick(400);
    expect(section().className, "still full-screen").toContain("scn-full");
    expect(hostFull).toBe(true);
    expect(fullCalls, "nothing handed full mode back").not.toContain(false);
    expect(readCol().textContent, "on the next sender").toContain("Subject m2");
    expect(readCol().textContent).not.toContain("Subject m1");
  });

  it("Undo after the last decision brings the sender back to the list and does not reopen the preview", async () => {
    await mount(await engineWith([msg("m1", "one@example.test")]));
    await tapRow("m1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await pressBar("Ohbox");
    await tick(1000);
    expect(undoButton(), "the Undo window is kept").not.toBeNull();
    await act(async () => { undoButton()!.click(); });
    await flush();
    expect(rowIds(), "the sender is back in the list").toContain("m1");
    expect(section().className, "and the preview stays closed").not.toContain("scn-full");
    expect(drawn(readCol())).toBe(false);
    await tick(COMMIT_MS * 2);
    expect(sent.filter((m) => m.kind === "screener_decide"), "an undone decision is never sent").toHaveLength(0);
  });

  it("a host still holding full with nobody to show (decided elsewhere) is not honoured, and is told", async () => {
    await mount(await engineWith([]), { full: true, sticky: true });
    expect(hostFull, "the premise: the host still says full").toBe(true);
    expect(section().className).not.toContain("scn-full");
    expect(drawn(readCol())).toBe(false);
    expect(fullCalls, "the view handed it back").toContain(false);
    expect(drawn(emptyWaiting()!)).toBe(true);
  });
});
