/** @vitest-environment jsdom */
/**
 * ═══ LOAD IT NOW READS A LETTER EMPTIED FOR SPACE AND KEEPS IT NOWHERE ═══════════════════════════
 *
 * A letter whose text was emptied for space says so, and where the mailbox is still read it offers
 * Load it now: the text from the mail server for this view (`GET /messages/:id/live-body`), drawn
 * through the reader's own body renderer. The engine's store is left exactly as it was: no body is
 * written, nothing is queued, and opening the letter again shows the emptied state. Driven through
 * the new reader's column in the frame over a real engine (the reader's mail world, its letters read
 * from the engine's own store); the words are the new reader's catalogue's, by key.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { HttpAdapter, OhmailEngine, bodyOf } from "@ohmail/client-engine";
import { liveBodyVia } from "@ohmail/app-logic/reading/live-body";
import { letterBody } from "@ohmail/app/reader/body";
import { mountReader } from "../../../packages/app/test/reader/support/mail.js";
import readerEn from "../../../packages/app/messages/reader.en.json" with { type: "json" };

process.env.NEXT_PUBLIC_API_BASE = "/api";

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const ISO = "2026-11-07T09:00:00.000Z";
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

beforeEach(() => {
  asked = [];
  liveAnswer = () => json({ text: LIVE_TEXT, html: null });
});
afterEach(() => {
  cleanup();
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

/** The new reader's column with the letter open, over the real engine; its body drawn by the reader's own part. */
async function mountColumn(engine: OhmailEngine): Promise<HTMLElement> {
  mountReader({
    letters: [],
    open: ID,
    parts: { body: letterBody },
    presented: () => engine.read(),
    host: {
      engine,
      wires: { liveBody: liveBodyVia((path) => serve(`/api${path}`)) } as never,
      mailboxes: async () => [{ id: "mb_1", address: "sam@example.com", status: "active" }],
    } as never,
  });
  await settle();
  return screen.getByRole("region", { name: "Reading" });
}

const pressLoad = async (pane: HTMLElement): Promise<void> => {
  const b = within(pane).getByRole("button", { name: readerEn.body.liveLoad });
  await act(async () => { fireEvent.click(b); });
  await settle();
};

describe("a letter emptied for space", () => {
  it("Load it now draws the server's text in the reader and leaves the engine's store unchanged", async () => {
    const engine = await emptiedEngine();
    const version = engine.read().version();
    const before = JSON.stringify(engine.read().get("message_body", ID));
    const pane = await mountColumn(engine);
    asked = [];
    await pressLoad(pane);
    const letter = pane.querySelector<HTMLElement>(`[data-conv-id="${ID}"]`)!;
    expect(letter.querySelector("[data-read-body]")?.textContent).toContain(LIVE_TEXT);
    expect(pane.textContent).toContain(readerEn.body.keptLoaded);
    expect(asked).toEqual([`GET /api/messages/${ID}/live-body`]);
    expect(engine.read().version()).toBe(version);
    expect(JSON.stringify(engine.read().get("message_body", ID))).toBe(before);
    expect(bodyOf(engine.read(), engine.read().get<EngineMessage>("message", ID)!).state).toBe("withheld");
    expect(engine.pendingMutations()).toEqual([]);
  });

  it("a refusal is said and Load it now stays", async () => {
    liveAnswer = () => json({ error: { code: "letter_gone", message: "gone" } }, 410);
    const pane = await mountColumn(await emptiedEngine());
    await pressLoad(pane);
    expect(pane.textContent).toContain(readerEn.body.liveGone);
    expect(within(pane).getAllByRole("button").some((b) => b.textContent === readerEn.body.liveLoad)).toBe(true);
  });
});
