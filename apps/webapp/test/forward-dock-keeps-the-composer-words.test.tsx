/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { drafts } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, type EngineDraft, type FetchLike } from "@ohmail/client-engine";
import {
  FIXED_NOW, makeDeps, seedBody, seedMailbox, seedMessage, seedSession, seedThread,
} from "../../../packages/api/test/helpers.js";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { editorOf } from "./fixtures/rich-editor-driver";
import { withNodeBlobs } from "./fixtures/node-blobs";

/**
 * A FORWARD ROW THE DOCK WROTE, OPENED IN THE COMPOSER WHILE THE DOCK'S WRITE OF IT WAITS (its create
 * queued offline, or a save in the air), edited there and left: Forward again never writes or sends
 * the dock's older words over the composer's; while the composer still holds it, Forward starts a new
 * forward. Over the shipped shell, the real HttpAdapter (which moves a save's stated version along
 * this client's own saves) and the real API.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const app = createApp(apiRoutes);
const TO = "colleague@atelier.example";
const SAVED = AUTOSAVE_DELAY_MS + 8000;
let roots: Root[] = [];
let container: HTMLElement;

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
    foldersEnabledAt: "2026-09-01T00:00:00.000Z",
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const q = <T extends Element = Element>(sel: string): T | null => container.querySelector<T>(sel);
async function waitFor(p: () => boolean | Promise<boolean>, what: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await p()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}
const go = async (hash: string) => act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

/** A letter from Lena open in her view, and another draft in Drafts the composer moves on to. */
async function world() {
  const delivered: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
    async messageInSent() { return false; },
    async close() { /* nothing */ },
  });
  const { db, deps } = await withNodeBlobs(() => makeDeps(FIXED_NOW, {}, { sendAdapter: factory }));
  const s = await seedSession(db, { now: FIXED_NOW });
  const address = "me@lichtgrat.example";
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address });
  /** No network at all, or the PUTs of one row held in the air until `wait` settles. */
  const net: { offline: boolean; gate: { id: string; wait: Promise<void> } | null; inAir: number } = { offline: false, gate: null, inAir: 0 };
  const fetchImpl: FetchLike = async (url, init) => {
    if (net.offline) throw new TypeError("Failed to fetch");
    const gate = net.gate;
    if (init?.method === "PUT" && gate !== null && String(url).includes(gate.id)) { net.inAir += 1; await gate.wait; }
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
  };
  const threadId = await seedThread(db, { accountId: s.accountId, subject: "Plans", lastMessageAt: FIXED_NOW });
  const letter = (await seedMessage(db, {
    accountId: s.accountId, mailboxId, threadId, subject: "Plans", fromAddress: "lena@atelier.example",
    date: FIXED_NOW, unread: false, folder: "INBOX",
  })).id;
  await seedBody(db, { messageId: letter, text: "Shall we meet?" });
  const other = await fetchImpl("http://localhost/drafts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mailboxId, subject: "Another letter", body: "other words", to: [{ name: null, address: "bo@atelier.example" }], cc: [], bcc: [],
    }),
  });
  const otherId = ((await other.json()) as { id: string }).id;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store });
  const roster = [{
    id: mailboxId, address, status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: "2026-09-09T08:59:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z", organizerRole: "organizer", organizedBy: null,
    organizeConsentedAt: "2026-09-01T00:00:00.000Z",
  } as MailboxFacts];
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, {
        children: h(AppShell as never, { demo: false, engine, consentTransport, mailboxFacts: async () => roster } as never),
      }) }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  const letterHash = `#/address/${encodeURIComponent("lena@atelier.example")}/m/${letter}`;
  await go(letterHash);
  await waitFor(() => (q(".view-address")?.textContent ?? "").includes("Plans"), "the letter on screen");
  const rows = async () => db.select().from(drafts);
  const body = async (id: string) => (await rows()).find((r) => r.id === id)?.body;
  return { delivered, rows, body, engine, net, letter, letterHash, otherId };
}
type World = Awaited<ReturnType<typeof world>>;

const dock = (): HTMLElement | null => q<HTMLElement>(".reply[data-reply-for] .rte-surface");
async function forwardOn(): Promise<void> {
  await waitFor(() => q(".abar-fwd button") !== null, "Forward");
  await act(async () => { q<HTMLElement>(".abar-fwd button")!.click(); });
  await waitFor(() => dock() !== null && q(".reply[data-reply-for] .rcp-input") !== null, "the forward dock");
}
async function dockWrites(text: string): Promise<void> {
  await act(async () => { editorOf(dock()!).commands.setContent(`<p>${text}</p>`); });
}
/** Forward on the letter, To typed, then (after `between`) the note. */
async function forwardWith(note: string, between = (): void => {}): Promise<void> {
  await forwardOn();
  const input = q<HTMLInputElement>(".reply[data-reply-for] .rcp-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, `${TO}, `);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  between();
  await dockWrites(note);
}
async function closeDockAndOpen(id: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await waitFor(() => dock() === null, "the dock closed");
  await go("#/drafts");
  await waitFor(() => q(`.draft-row[data-id="${id}"] .draft-open`) !== null, `${id} in Drafts`);
  await act(async () => { q<HTMLElement>(`.draft-row[data-id="${id}"] .draft-open`)!.click(); });
  await waitFor(() => q(".view-compose .rte-surface") !== null, "the composer on the forward row");
}
const composerWrites = async (text: string) => act(async () => {
  editorOf(q<HTMLElement>(".view-compose .rte-surface")!).commands.setContent(`<p>${text}</p>`);
});
/** The forward rows this page lists, a create still queued included. */
const forwardRows = (w: World) => w.engine.read().list<EngineDraft>("draft").filter((d) => d.forwardOfMessageId === w.letter);
/** The composer writes over the row and moves on to the other draft; Forward again on the letter. */
async function composerEditsAndLeaves(w: World, row: string): Promise<void> {
  await composerWrites("composer words two");
  await waitFor(async () => (await w.body(row)) === "composer words two", "the composer's save", SAVED);
  await go("#/drafts");
  await waitFor(() => q(`.draft-row[data-id="${w.otherId}"] .draft-open`) !== null, "the other draft in Drafts");
  await act(async () => { q<HTMLElement>(`.draft-row[data-id="${w.otherId}"] .draft-open`)!.click(); });
  await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Another letter", "the composer on the other draft");
  await go(w.letterHash);
  await forwardOn();
}

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* blocked */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {},
      removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("a dock's forward row the composer took while the dock's write waited", () => {
  it("its create queued offline: Forward opens the composer's words, writes on them, and Send sends them", async () => {
    const w = await world();
    await forwardWith("dock note one", () => { w.net.offline = true; });
    await waitFor(() => forwardRows(w).length > 0, "the forward's create queued", SAVED);
    await closeDockAndOpen(forwardRows(w)[0]!.id);
    w.net.offline = false;
    await act(async () => { await w.engine.flushPending(); });
    await waitFor(async () => (await w.rows()).some((r) => r.forwardOfMessageId === w.letter), "the create landed");
    const row = (await w.rows()).find((r) => r.forwardOfMessageId === w.letter)!.id;
    await waitFor(() => w.engine.read().get<EngineDraft>("draft", row) != null, "the landed row in the mirror");
    await composerEditsAndLeaves(w, row);
    expect(dock()!.textContent, "Forward opened other words than the composer's").toBe("composer words two");
    await dockWrites("composer words two, and more");
    await waitFor(async () => (await w.body(row)) === "composer words two, and more", "the dock's save on the row", SAVED);
    const send = [...container.querySelectorAll<HTMLButtonElement>(".reply[data-reply-for] button")]
      .find((b) => (b.textContent ?? "").trim().startsWith("Send"))!;
    await act(async () => { send.click(); });
    await waitFor(() => w.delivered.length > 0, "the forward delivered");
    expect(w.delivered.map((m) => m.text.split("\n")[0]), "the send carried other words").toEqual(["composer words two, and more"]);
  }, 120_000);

  it("a save of it in the air: the composer's words stay on the row, and the dock's are a new draft", async () => {
    const w = await world();
    await forwardWith("dock note one");
    await waitFor(async () => (await w.rows()).some((r) => r.forwardOfMessageId === w.letter && r.body === "dock note one"), "the dock's row", SAVED);
    const row = (await w.rows()).find((r) => r.forwardOfMessageId === w.letter)!.id;
    let release: () => void = () => {};
    w.net.gate = { id: row, wait: new Promise<void>((r) => { release = r; }) };
    await dockWrites("dock note one, second");
    await waitFor(() => w.net.inAir > 0, "the dock's save in the air", SAVED);
    await closeDockAndOpen(row);
    w.net.gate = null;
    release();
    await waitFor(async () => (await w.body(row)) === "dock note one, second", "the dock's save landed");
    await composerEditsAndLeaves(w, row);
    await dockWrites(`${dock()!.textContent ?? ""} plus`);
    await waitFor(async () => (await w.rows()).some((r) => r.body?.endsWith(" plus") === true), "the dock's save", SAVED);
    const shown = (await w.rows()).map((r) => [r.id === row ? "row" : r.id === w.otherId ? "other" : "new", r.status, r.body]);
    expect(shown.sort(), "the dock wrote its older words over the composer's").toEqual([
      ["new", "draft", "dock note one, second plus"], ["other", "draft", "other words"], ["row", "draft", "composer words two"],
    ]);
  }, 120_000);

  it("its create queued offline and the composer still on it: Forward starts a new forward, and both are kept", async () => {
    const w = await world();
    await forwardWith("dock note one", () => { w.net.offline = true; });
    await waitFor(() => forwardRows(w).length > 0, "the forward's create queued", SAVED);
    await closeDockAndOpen(forwardRows(w)[0]!.id);
    await composerWrites("composer words two");
    await waitFor(() => forwardRows(w).some((d) => d.body === "composer words two"), "the composer's save queued", SAVED);
    await go(w.letterHash);
    await forwardOn();
    expect(dock()!.textContent, "Forward opened the forward the composer holds").toBe("");
    await dockWrites("second forward");
    await waitFor(() => forwardRows(w).some((d) => d.body === "second forward"), "the dock's save queued", SAVED);
    w.net.offline = false;
    const kept = async () => (await w.rows()).filter((r) => r.status === "draft").map((r) => r.body).sort();
    const both = ["composer words two", "other words", "second forward"];
    for (let i = 0; i < 100 && JSON.stringify(await kept()) !== JSON.stringify(both); i++) {
      await act(async () => { await w.engine.flushPending(); await new Promise((r) => setTimeout(r, 100)); });
    }
    expect(await kept(), "a forward's words were lost or left twice").toEqual(both);
  }, 120_000);
});
