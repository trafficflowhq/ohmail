/** The whole shell over a memory mirror and a fake sync, as reply-survives-its-parent mounts it. */
import { vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, mutationEffects,
  type EngineMessage, type EngineMutation, type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
export const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const NOW = new Date("2026-09-16T09:00:00.000Z");
export const GONE = "This message was moved or deleted elsewhere.";
export const SENDER = "colleague@example.invalid";
export const S: {
  roots: Root[]; seq: number; store: MirrorStore | null; engine: OhmailEngine | null;
  pending: SyncChange[]; mobile: boolean; extra: Record<string, unknown>;
} = { roots: [], seq: 0, store: null, engine: null, pending: [], mobile: false, extra: {} };

export function setup(): void {
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* blocked */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: S.mobile && /max-width/.test(query), media: query,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  S.seq = 0; S.store = null; S.engine = null; S.pending = []; S.mobile = false; S.extra = {};
}

export async function teardown(): Promise<void> {
  for (const root of S.roots) await act(() => { root.unmount(); });
  S.roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
}

export const msg = (id: string, o: Partial<EngineMessage> = {}): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: SENDER, name: "The colleague" },
  to: [{ address: "me@example.invalid", name: "Me" }], cc: [],
  date: "2026-09-16T08:29:00.000Z", unread: false, labels: [], snippet: `snippet ${id}`,
  updatedAt: "2026-09-16T08:29:00.000Z", ...o,
} as unknown as EngineMessage);

export async function storeWith(rows: EngineMessage[], extra: SyncChange[] = []): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  await s.applyChanges([{
    type: "rule", op: "create", id: "r1", seq: ++S.seq, updatedAt: NOW.toISOString(),
    entity: { id: "r1", kind: "sender", match: SENDER, destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z" },
  }, ...extra] as SyncChange[]);
  for (const m of rows) {
    await s.applyChanges([{ type: "message", op: "create", id: m.id, seq: ++S.seq, updatedAt: m.updatedAt, entity: m }] as SyncChange[]);
  }
  return s;
}

export function engineOver(s: MirrorStore, more: Record<string, unknown> = {}): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = S.pending;
        S.pending = [];
        return {
          changes: { creates: page.filter((c) => c.op !== "delete"), updates: [], moves: [], deletes: page.filter((c) => c.op === "delete") },
          cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++S.seq}` }).map((e) => ({
          type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
          id: e.id, seq: ++S.seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        })) as SyncChange[];
        await s.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
    ...more,
  } as never);
}

export const consentTransport = {
  foldersStorable: true,
  state: async () => ({ seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90, foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

export async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

export async function shell(s: MirrorStore, engine: OhmailEngine, hash = "#/ohbox"): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  S.store = s; S.engine = engine;
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, { demo: false, engine, consentTransport, mailboxFacts: async () => ROSTER } as never),
      }) }),
    }));
  });
  return container;
}

export async function click(el: Element | null, what: string): Promise<void> {
  if (!el) throw new Error(`no ${what}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export async function tombstone(id: string): Promise<void> {
  S.pending = [{ type: "message", op: "delete", id, seq: ++S.seq, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange];
  await act(async () => { await S.engine!.syncOnce(); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

export const text = (el: HTMLElement, sel: string): string => el.querySelector(sel)?.textContent ?? "";
