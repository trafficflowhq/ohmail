/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineMessage } from "@ohmail/client-engine";
import en from "../messages/en.json";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import {
  EMBEDDED_CALENDAR, EXCHANGE_ICAL, GOOGLE, HOSTILE_DURATION, TWO_EVENTS, type InviteShape,
} from "../../../packages/core/test/fixtures/invite-shapes";
import { OWA_STUB } from "../../../packages/core/test/fixtures/owa-invitation-stub";

/**
 * EVERY INVITATION SHOWS ITS EVENT ONCE, AT THE TOP OF THE MESSAGE (owner report 2026-10-22: "here
 * I still see no calendar preview.. and sometimes I see the same one double"). The card lived in
 * the attachment strip under the body, one per calendar part: Google's invitation drew two, an
 * Outlook or Teams invitation's card sat under a long html body out of view, and an embedded
 * calendar part drew none. Each case serves the parts ingest stores for a real invitation shape.
 */

const EN_BODY = (en as unknown as Record<string, Record<string, string>>).body!;

/* ── the live shell: the Ohbox reader and an open News card ────────────────────────────────── */

let shapes: InviteShape[] = [];
let stubLetter = false;
let folder = "INBOX";
const idOf = (shape: InviteShape): string => `msg-${shape.name}`;
const STUB_ID = "msg-owa-stub";

const letter = (id: string, subject: string) => ({
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: ISO, folder, snippet: subject, unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
const adaRule = () => ({
  id: "rule_ada", kind: "sender", match: "ada@example.test", destination: folder, priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  shapes = [];
  stubLetter = false;
  folder = "INBOX";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const shape = shapes.find((s) => idOf(s) === decodeURIComponent(list[1]!));
      return json({ items: (shape?.parts ?? []).map((p) => ({
        id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
        inline: p.inline, contentId: p.contentId, messageId: idOf(shape!),
      })) });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body) {
      const id = decodeURIComponent(body[1]!);
      const shape = shapes.find((s) => idOf(s) === id);
      return json({
        text: id === STUB_ID ? OWA_STUB : shape?.text ?? "", html: shape?.html ?? null,
        loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      const id = decodeURIComponent(bytes[1]!);
      const part = shapes.flatMap((s) => s.parts).find((p) => p.id === id);
      // Served untyped, so the bytes stay the runtime's own Blob (jsdom's has no `text()`).
      return new Response(part?.bytes ?? "", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

async function mountWith(served: InviteShape[], opts: { stub?: boolean } = {}): Promise<void> {
  shapes = served;
  stubLetter = opts.stub === true;
  let seq = 1;
  const creates = [
    { type: "rule", op: "create", id: "rule_ada", seq: seq++, updatedAt: ISO, entity: adaRule() },
    ...served.map((s) => ({ type: "message", op: "create", id: idOf(s), seq: seq++, updatedAt: ISO, entity: letter(idOf(s), s.name) })),
    ...(stubLetter ? [{ type: "message", op: "create", id: STUB_ID, seq: seq++, updatedAt: ISO, entity: { ...letter(STUB_ID, "Think tank"), hasAttachments: false, attachmentCount: 0 } }] : []),
  ];
  answerSyncWith(() => new Response(JSON.stringify({
    changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c2", hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
  await tick(30_000);
}

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
};

/** Let the list, the calendar pass and the redraw land. */
async function settleCards(): Promise<void> {
  for (let i = 0; i < 40; i++) await tick(50);
}

async function openInReader(id: string): Promise<HTMLElement> {
  await goHash(`#/ohbox/m/${id}`);
  await settleCards();
  const body = document.querySelector<HTMLElement>(".msg-body");
  expect(body, "the reader shows no body").not.toBeNull();
  return document.body;
}

/** The card stands before the mail and outside it. */
function expectAbove(card: Element | null, mail: Element | null): void {
  expect(card, "no event card").not.toBeNull();
  expect(mail, "the premise: the mail element").not.toBeNull();
  expect(mail!.contains(card!), "the card is inside the mail").toBe(false);
  expect(card!.compareDocumentPosition(mail!) & Node.DOCUMENT_POSITION_FOLLOWING, "the card is under the mail").toBeTruthy();
}

describe("the reader shows one card per event, above the mail", () => {
  it("Google's invitation (alternative + invite.ics) shows one card", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expect(page.querySelector(".ics-card .ics-summary")?.textContent).toBe("Quarterly planning");
  }, 60_000);

  it("the strip lists Google's invite.ics once, as a plain tile, and draws no card", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    // The nameless alternative is the body the card reads, not a second invite.ics.
    expect(page.querySelectorAll(".att-strip .att-tile")).toHaveLength(1);
    expect(page.querySelector(".att-strip .ics-card")).toBeNull();
    expect(page.querySelector(".att-strip .att-head")).toBeNull();
  }, 60_000);

  it("an Exchange invitation's card comes before its long html body, not under it", async () => {
    await mountWith([EXCHANGE_ICAL]);
    const page = await openInReader(idOf(EXCHANGE_ICAL));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(page.querySelector(".ics-card"), page.querySelector(".msg-body"));
  }, 60_000);

  it("an embedded calendar part (inline, under multipart/related) shows its card", async () => {
    await mountWith([EMBEDDED_CALENDAR]);
    const page = await openInReader(idOf(EMBEDDED_CALENDAR));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expect(page.querySelector(".ics-card .ics-summary")?.textContent).toBe("Site visit");
  }, 60_000);

  it("two different events show two cards (control)", async () => {
    await mountWith([TWO_EVENTS]);
    const page = await openInReader(idOf(TWO_EVENTS));
    expect([...page.querySelectorAll(".ics-card .ics-summary")].map((n) => n.textContent))
      .toEqual(["Workshop day one", "Workshop day two"]);
  }, 60_000);

  it("a crafted DURATION past the range of a Date: one card, and the reader stays", async () => {
    await mountWith([HOSTILE_DURATION]);
    const page = await openInReader(idOf(HOSTILE_DURATION));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(page.querySelector(".ics-card"), page.querySelector(".msg-body"));
  }, 60_000);

  it("an Outlook Web App stub shows the note and no card (control)", async () => {
    await mountWith([], { stub: true });
    const page = await openInReader(STUB_ID);
    expect(page.textContent).toContain(EN_BODY.invitationOwaLink);
    expect(page.querySelector(".ics-card")).toBeNull();
  }, 60_000);

  it("the card is text only: no link, no button", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    const events = page.querySelector(".msg-events");
    expect(events, "no event block").not.toBeNull();
    expect(events!.querySelectorAll("a, button")).toHaveLength(0);
  }, 60_000);
});

describe("an open News card shows the event above the issue", () => {
  it("one card, before the card's text", async () => {
    folder = "ohmail/News";
    await mountWith([GOOGLE]);
    await goHash("#/reads");
    await tick(1_000);
    const card = document.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${idOf(GOOGLE)}"]`);
    expect(card, "News does not show the letter").not.toBeNull();
    await act(async () => { card!.querySelector<HTMLButtonElement>(".sc-x")!.click(); });
    await settleCards();
    expect(card!.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(card!.querySelector(".ics-card"), card!.querySelector(".sc-clip"));
  }, 60_000);
});

/* ── a conversation panel and the Screener's preview, on the real attachment seam ──────────── */

const h = React.createElement;
const NOW = new Date(ISO);
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function engineServing(shape: InviteShape): OhmailEngine {
  return new OhmailEngine({
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: ISO }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async () => shape.parts.map((p) => ({
        id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
        inline: p.inline, contentId: p.contentId, messageId: idOf(shape),
      })),
      fetchAttachment: async (id: string) =>
        new Response(shape.parts.find((p) => p.id === id)!.bytes, { headers: { "content-type": "application/octet-stream" } }).blob(),
    },
  } as never);
}

const engineMessage = (shape: InviteShape): EngineMessage => ({
  ...letter(idOf(shape), shape.name),
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
} as unknown as EngineMessage);

async function mountSurface(shape: InviteShape, surface: "card" | "screener"): Promise<HTMLElement> {
  const { MessageCard } = await import("../app/shell/MessageCard.js");
  const { HeldMail } = await import("../app/views/ScreenerView.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const { useMessageAttachments } = await import("../app/shell/attachments.js");
  const engine = engineServing(shape);
  const message = engineMessage(shape);
  const view = surface === "card"
    ? h(MessageCard as never, { message, now: NOW } as never)
    : h(HeldMail as never, {
      messageId: message.id, message: { id: message.id, snippet: message.snippet },
      from: "Ada Organizer", subject: message.subject, body: shape.text,
    } as never);
  function WithSeam() {
    const attachments = useMessageAttachments(engine, null, { conversationOf: () => [], onDownloadAllFailed: () => {} });
    return h(MessageChromeProvider as never, {
      value: {
        ownAddresses: ["mila@example.test"], absoluteTime: false, onToggleAbsoluteTime: () => {},
        replyTo: null, replyBody: { text: "", html: "" }, onReplyBody: () => {}, closeReply: () => {},
        sendReply: () => {}, replySendState: () => ({ phase: "idle" }), openSenderMenu: () => {},
        openAttachmentPreview: () => {}, conversationOf: () => [],
        bodyOf: () => ({ text: shape.text, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
        hydrateBody: () => {}, hydrateBodies: () => {}, hydrateThread: () => {}, openReply: () => {}, forward: () => {},
        attachments,
      },
      children: view,
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", now: NOW, children: h(WithSeam) }));
  });
  await settleCards();
  return host;
}

describe("a conversation panel and the Screener preview show the event above the mail", () => {
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    root = null;
    host = null;
  });

  it("a conversation panel: one card for Google's pair, before .pm-body", async () => {
    const el = await mountSurface(GOOGLE, "card");
    expect(el.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(el.querySelector(".ics-card"), el.querySelector(".pm-body"));
  }, 60_000);

  it("the Screener's preview: one card for Google's pair, before .hm-body", async () => {
    const el = await mountSurface(GOOGLE, "screener");
    expect(el.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(el.querySelector(".ics-card"), el.querySelector(".hm-body"));
  }, 60_000);
});
