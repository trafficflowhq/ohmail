/** @vitest-environment jsdom */
/**
 * ═══ LOAD IT NOW READS A LETTER EMPTIED FOR SPACE AND KEEPS IT NOWHERE ═══════════════════════════
 *
 * A letter whose text was emptied for space says so, and where the mailbox is still read it offers
 * Load it now: the text from the mail server for this view (`GET /messages/:id/live-body`), drawn
 * through the reader's own body renderer. The engine's store is left exactly as it was: no body is
 * written, nothing is queued, and opening the letter again shows the emptied state. Driven through
 * the real reading pane over a real engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine, bodyOf, type EngineMessage } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { liveBodyVia } from "../app/shell/live-body";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const ISO = "2026-11-07T09:00:00.000Z";
const NOW = new Date(ISO);
const ID = "m_emptied";
const LIVE_TEXT = "Hi Sam, here is the final version of the kitchen plans.";
const entity = {
  id: ID, accountId: "acct", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "Kitchen plans, final version", from: { name: "Tom", address: "tom@example.com" },
  to: [{ name: "Sam", address: "sam@example.com" }], cc: [], date: "2017-06-14T14:20:00.000Z", folder: "INBOX",
  snippet: "Hi Sam, here is the final version", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let asked: string[] = [];
let liveAnswer: () => Response = () => json({ text: LIVE_TEXT, html: null });

/** The account's server: one message, its body withheld for space, and the live read. */
async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = new URL(url, "http://localhost").pathname + new URL(url, "http://localhost").search;
  asked.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
  if (path.includes("/sync")) {
    return json({
      changes: { creates: [{ type: "message", op: "create", id: ID, seq: 1, updatedAt: ISO, entity }], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: ISO,
    });
  }
  if (path.includes("/live-body")) return liveAnswer();
  if (path.includes("/body") || path.includes("/messages/bodies")) {
    const one = { messageId: ID, text: "", html: null, loadedRemoteContent: false, withheld: "storage_cap" };
    return path.includes("/messages/bodies") ? json({ items: [one] }) : json(one);
  }
  return json({});
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  asked = [];
  liveAnswer = () => json({ text: LIVE_TEXT, html: null });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); });
}

async function emptiedEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "/api", fetch: serve }) });
  await engine.syncOnce();
  await engine.hydrateBody(ID);
  return engine;
}

async function mountPane(engine: OhmailEngine, status = "connected"): Promise<HTMLDivElement> {
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const message = engine.read().get<EngineMessage>("message", ID)!;
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: NOW,
      children: h(MessageChromeProvider as never, {
        value: {
          ownAddresses: ["sam@example.com"], absoluteTime: false, onToggleAbsoluteTime: () => {},
          replyTo: null, replyBody: { text: "", html: "" }, onReplyBody: () => {}, closeReply: () => {},
          sendReply: () => {}, replySendState: () => ({ phase: "idle" }), openSenderMenu: () => {},
          openAttachmentPreview: () => {}, conversationOf: () => [],
          bodyOf: (m: EngineMessage) => bodyOf(engine.read(), m),
          hydrateBody: () => {}, hydrateThread: () => {}, openReply: () => {}, forward: () => {},
          mailboxStatusOf: () => status,
          liveBody: liveBodyVia((path) => serve(`/api${path}`)),
        },
        children: h(MessagePane as never, {
          message, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
        } as never),
      } as never),
    }));
  });
  await settle();
  return host;
}

const pressLoad = async (el: HTMLElement): Promise<void> => {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent === "Load it now");
  expect(b, "no Load it now").toBeTruthy();
  await act(async () => { b!.click(); });
  await settle();
};

describe("a letter emptied for space", () => {
  it("says why and where it is, offers Load it now and Storage settings", async () => {
    const el = await mountPane(await emptiedEngine());
    expect(el.textContent).toContain(en.body.withheld);
    expect(el.textContent).toContain("Load it now fetches it from your mail server for this view. It is not stored.");
    expect(el.querySelector<HTMLAnchorElement>(".emptied a")?.getAttribute("href")).toBe("#/settings/storage");
  });

  it("Load it now draws the server's text in the reader and leaves the engine's store unchanged", async () => {
    const engine = await emptiedEngine();
    const version = engine.read().version();
    const before = JSON.stringify(engine.read().get("message_body", ID));
    const el = await mountPane(engine);
    asked = [];
    await pressLoad(el);
    expect(el.querySelector(".msg-body")?.textContent).toContain(LIVE_TEXT);
    expect(el.textContent).toContain("Loaded from your mail server for this view. Not stored on Cloud.");
    expect(asked).toEqual([`GET /api/messages/${ID}/live-body`]);
    expect(engine.read().version()).toBe(version);
    expect(JSON.stringify(engine.read().get("message_body", ID))).toBe(before);
    expect(bodyOf(engine.read(), engine.read().get<EngineMessage>("message", ID)!).state).toBe("withheld");
    expect(engine.pendingMutations()).toEqual([]);
  });

  it("a refusal is said and Load it now stays", async () => {
    liveAnswer = () => json({ error: { code: "letter_gone", message: "gone" } }, 410);
    const el = await mountPane(await emptiedEngine());
    await pressLoad(el);
    expect(el.textContent).toContain("Your mail server no longer holds this letter where ohmail last saw it.");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Load it now")).toBe(true);
  });

  it("no Load it now for a mailbox ohmail no longer reads", async () => {
    const el = await mountPane(await emptiedEngine(), "disabled");
    expect(el.textContent).toContain(en.body.withheldRemoved);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Load it now")).toBe(false);
  });
});
