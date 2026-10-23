/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { eq } from "drizzle-orm";
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
import { escapeAsParagraphs } from "../app/shell/rich-text";
import { editorOf } from "./fixtures/rich-editor-driver";
import { withNodeBlobs } from "./fixtures/node-blobs";

/**
 * A MESSAGE WHOSE FORMATTING WAS REMOVED CAN BE SENT, through the shipped shell over
 * the real API: bold, autosaved, cleared, retyped plain, Send. Every press used to answer
 * "Sending didn't work — your draft is kept" while the row stayed bold: the editor reports no
 * formatting as `html: ""`, the builders dropped the key, and the server refuses a body-only edit
 * of a formatted row. A formatted draft reopened from Drafts opened as plain text and failed the
 * same way. The web app and the desktop window render this same shell.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const app = createApp(apiRoutes);
const compose = messages.compose as unknown as Record<string, string>;
const TO = [{ name: null, address: "lena@atelier.example" }];
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

/**
 * The shell over the real API. `seedRich` opens that formatted draft from Drafts; `reply` opens a
 * letter from Lena in its correspondent's view and answers it inline; else Compose.
 */
async function world(seedRich?: string, reply = false) {
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
  const net = { offline: false };
  const fetchImpl: FetchLike = async (url, init) => {
    if (net.offline) throw new TypeError("Failed to fetch");
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
  };
  let seededId: string | null = null;
  if (seedRich !== undefined) {
    const res = await fetchImpl("http://localhost/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId, subject: "Kept", html: seedRich, to: TO, cc: [], bcc: [] }),
    });
    seededId = ((await res.json()) as { id: string }).id;
  }
  let letter: string | null = null;
  if (reply) {
    const threadId = await seedThread(db, { accountId: s.accountId, subject: "Plans", lastMessageAt: FIXED_NOW });
    letter = (await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, subject: "Plans", fromAddress: "lena@atelier.example",
      date: FIXED_NOW, unread: false, folder: "INBOX",
    })).id;
    await seedBody(db, { messageId: letter, text: "Shall we meet?" });
  }
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store });
  const roster: MailboxFacts[] = [{
    id: mailboxId, address, status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: "2026-09-09T08:59:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z", organizerRole: "organizer" as const, organizedBy: null,
    organizeConsentedAt: "2026-09-01T00:00:00.000Z",
  } as MailboxFacts];
  const rows = async () => db.select().from(drafts);
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
  if (seededId !== null) {
    await act(async () => { window.location.hash = "#/drafts"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => q(`.draft-row[data-id="${seededId}"] .draft-open`) !== null, "the draft in Drafts", 8000);
    const open = q<HTMLElement>(`.draft-row[data-id="${seededId}"] .draft-open`)!;
    await act(async () => { open.click(); });
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Kept", "the editor on the draft", 8000);
  } else if (letter !== null) {
    await act(async () => {
      window.location.hash = `#/address/${encodeURIComponent("lena@atelier.example")}/m/${letter}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  } else {
    await act(async () => { window.location.hash = "#/compose"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  }
  if (letter === null) await waitFor(() => q(".view-compose .rte-surface") !== null, "the compose editor", 8000);
  /** Another device's write, straight to the server: this mirror has not heard of it. */
  const putElsewhere = async (id: string, body: Record<string, unknown>) => fetchImpl(`http://localhost/drafts/${id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { delivered, rows, engine, seededId, putElsewhere, letter, net };
}

const q = <T extends Element = Element>(sel: string): T | null => container.querySelector<T>(sel);
async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function body(html: string): Promise<void> {
  const surface = q<HTMLElement>(".view-compose .rte-surface")!;
  await act(async () => { editorOf(surface).commands.setContent(html); });
}
async function waitFor(p: () => boolean | Promise<boolean>, what: string, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await p()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}
const pause = async (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const sendButton = (): HTMLButtonElement | null =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(".view-compose button"))
    .find((b) => (b.textContent ?? "").trim().startsWith("Send") && !/later/i.test(b.textContent ?? "")) ?? null;
const status = (): string => q(".view-compose .send-status")?.textContent ?? "";
const notes = (): string => Array.from(container.querySelectorAll(".view-compose .send-note")).map((n) => n.textContent ?? "").join(" | ");
async function pressSend(w: { delivered: OutboundMessage[] }): Promise<void> {
  await act(async () => { sendButton()!.click(); });
  await waitFor(() => w.delivered.length > 0 || status().includes(compose.statusFailed!), "an outcome", 8000);
}
async function startBold(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  await typeInto("#compose-to", "lena@atelier.example");
  await typeInto("#compose-subject", "Hi");
  await body("<p><strong>bold words</strong></p>");
  await waitFor(async () => (await w.rows()).some((r) => (r.html ?? "").includes("<strong>")), "the bold autosave", AUTOSAVE_DELAY_MS + 6000);
}

/** Bold autosaved and heard back, then the connection drops, the bold is cleared and plain text typed. */
async function clearedOffline(w: Awaited<ReturnType<typeof world>>): Promise<string> {
  await startBold(w);
  const id = (await w.rows())[0]!.id;
  await waitFor(() => (w.engine.read().get<EngineDraft>("draft", id)?.html ?? "").includes("<strong>"), "the mirror holds the bold", 8000);
  w.net.offline = true;
  await body(escapeAsParagraphs("typed offline"));
  return id;
}
/** Escape closes Compose; back online, the queue replays and the draft is opened again from Drafts. */
async function closeReconnectReopen(w: Awaited<ReturnType<typeof world>>, id: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await waitFor(() => q(".view-compose") === null, "the composer closed", 8000);
  await pause(300);
  w.net.offline = false;
  await act(async () => { await w.engine.flushPending(); });
  await act(async () => { await w.engine.syncOnce(); });
  await act(async () => { window.location.hash = "#/drafts"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await waitFor(() => q(`.draft-row[data-id="${id}"] .draft-open`) !== null, "the draft in Drafts", 8000);
  await act(async () => { q<HTMLElement>(`.draft-row[data-id="${id}"] .draft-open`)!.click(); });
  await waitFor(() => q(".view-compose .rte-surface") !== null, "the reopened editor", 8000);
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

describe("a message whose formatting was removed, through the shell over the real API", () => {
  it("an inline reply, bold, autosaved, cleared and sent: the plain text goes", async () => {
    const w = await world(undefined, true);
    await waitFor(() => (q(".view-address")?.textContent ?? "").includes("Plans"), "the letter on screen", 8000);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true })); });
    await waitFor(() => q(".reply-editor .rte-surface") !== null, "the inline reply", 8000);
    const surface = q<HTMLElement>(".reply-editor .rte-surface")!;
    await act(async () => { editorOf(surface).commands.setContent("<p><strong>bold reply</strong></p>"); });
    await waitFor(async () => (await w.rows()).some((r) => (r.html ?? "").includes("<strong>")), "the bold reply autosave", AUTOSAVE_DELAY_MS + 6000);
    await act(async () => { editorOf(surface).commands.setContent(escapeAsParagraphs("plain reply")); });
    const send = Array.from(container.querySelectorAll<HTMLButtonElement>(".reply-actions button"))
      .find((b) => (b.textContent ?? "").trim().startsWith("Send") && !b.classList.contains("reply-send-done"))!;
    await act(async () => { send.click(); });
    const replyFailed = messages.reply.statusFailed as string;
    await waitFor(() => w.delivered.length > 0 || (q(".send-status")?.textContent ?? "").includes(replyFailed), "an outcome", 8000);
    expect(w.delivered.map((m) => [m.text.split("\n\n")[0], m.html ?? null])).toEqual([["plain reply", null]]);
    expect((await w.rows()).filter((r) => r.status === "draft")).toEqual([]);
  }, 40_000);

  it("bold, autosaved, cleared and retyped plain: Send delivers the plain text and Drafts is empty", async () => {
    const w = await world();
    await startBold(w);
    await body(escapeAsParagraphs("plain words"));
    await waitFor(async () => (await w.rows())[0]?.html === null, "the cleared autosave", AUTOSAVE_DELAY_MS + 6000);
    await pressSend(w);
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["plain words", null]]);
    expect((await w.rows()).filter((r) => r.status === "draft")).toEqual([]);
    expect(status()).not.toContain(compose.statusFailed);
  }, 40_000);

  it("cleared and sent at once, before the pause saves: the send's own save makes it plain", async () => {
    const w = await world();
    await startBold(w);
    await body(escapeAsParagraphs("typed plain"));
    await pressSend(w);
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["typed plain", null]]);
    expect(status()).not.toContain(compose.statusFailed);
  }, 40_000);

  it("cleared offline, a pause, Escape: back online the draft holds the words typed offline", async () => {
    const w = await world();
    const id = await clearedOffline(w);
    await pause(AUTOSAVE_DELAY_MS + 800);
    await closeReconnectReopen(w, id);
    const r = (await w.rows()).find((x) => x.id === id)!;
    expect([r.body, r.html]).toEqual(["typed offline", null]);
    expect(q(".view-compose .rte-surface")!.textContent).toContain("typed offline");
  }, 60_000);

  it("cleared offline and closed at once: back online the draft holds the words typed offline", async () => {
    const w = await world();
    const id = await clearedOffline(w);
    await closeReconnectReopen(w, id);
    const r = (await w.rows()).find((x) => x.id === id)!;
    expect([r.body, r.html]).toEqual(["typed offline", null]);
    expect(q(".view-compose .rte-surface")!.textContent).toContain("typed offline");
  }, 60_000);

  it("a formatted draft reopened from Drafts shows its formatting and sends with it", async () => {
    const w = await world("<p><strong>kept bold</strong></p>");
    expect(q(".view-compose .rte-surface")!.innerHTML).toContain("<strong>kept bold</strong>");
    await pressSend(w);
    expect(w.delivered.length).toBe(1);
    expect(w.delivered[0]!.html ?? "").toContain("<strong>kept bold</strong>");
    expect((await w.rows()).find((r) => r.id === w.seededId)!.status).toBe("sent");
  }, 40_000);

  it("a formatted draft reopened, cleared and sent goes as plain text", async () => {
    const w = await world("<p><strong>kept bold</strong></p>");
    await body(escapeAsParagraphs("now plain"));
    await pressSend(w);
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["now plain", null]]);
    expect((await w.rows()).filter((r) => r.status === "draft")).toEqual([]);
  }, 40_000);

  it("a save the server refused no longer promises the draft is saved", async () => {
    const w = await world();
    await typeInto("#compose-to", "lena@atelier.example");
    await typeInto("#compose-subject", "Hi");
    await body(escapeAsParagraphs("mine"));
    await waitFor(async () => (await w.rows()).length === 1, "the first autosave", AUTOSAVE_DELAY_MS + 6000);
    expect(notes()).toContain(compose.draftNote);
    const id = (await w.rows())[0]!.id;
    expect((await w.putElsewhere(id, { subject: "Hi", html: "<p><strong>theirs</strong></p>", to: TO, cc: [], bcc: [] })).status).toBe(200);
    await body(escapeAsParagraphs("mine, more"));
    await pause(AUTOSAVE_DELAY_MS + 1500);
    // Never flattened: the other device's formatting stands, and the screen does not say "saved".
    expect((await w.rows())[0]!.html).toBe("<p><strong>theirs</strong></p>");
    expect(notes()).not.toContain(compose.draftNote);
    expect(notes()).toContain(compose.draftNotSaved);
  }, 40_000);

  it("controls: bold kept sends formatted; never formatted sends plain", async () => {
    const w = await world();
    await startBold(w);
    await pressSend(w);
    expect(w.delivered.length).toBe(1);
    expect(w.delivered[0]!.html ?? "").toContain("<strong>bold words</strong>");
    for (const r of roots) await act(async () => { r.unmount(); });
    roots = [];
    document.body.innerHTML = "";
    const p = await world();
    await typeInto("#compose-to", "lena@atelier.example");
    await typeInto("#compose-subject", "Hi");
    await body(escapeAsParagraphs("plain all along"));
    await waitFor(async () => (await p.rows()).length === 1, "the plain autosave", AUTOSAVE_DELAY_MS + 6000);
    await pressSend(p);
    expect(p.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["plain all along", null]]);
  }, 60_000);
});
