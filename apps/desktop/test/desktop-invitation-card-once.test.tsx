/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineAdapter, type EngineMessage } from "@ohmail/client-engine";
import messages from "../../webapp/messages/en.json";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { useMessageAttachments } from "../../webapp/app/shell/attachments.js";
import { MessageChromeProvider } from "../../webapp/app/shell/message-chrome.js";
import { MessagePane } from "../../webapp/app/shell/MessagePane.js";
import { EXCHANGE_ICAL, GOOGLE, type InviteShape } from "../../../packages/core/test/fixtures/invite-shapes";

/**
 * ON THE DESKTOP, A MEETING INVITATION SHOWS ITS EVENT ONCE, ABOVE THE MAIL (owner screenshot
 * 2026-10-22). The window armed as the desktop arms it, the reading pane over the real attachment
 * seam, a Google invitation's two calendar parts (the alternative and invite.ics) as ingest
 * stores them: one card, before the body, and invite.ics once in the strip (the nameless
 * alternative is the body the card reads, never a tile). Exchange's alternative alone: its tile.
 */

for (const name of ["text", "arrayBuffer"] as const) {
  if (typeof (Blob.prototype as unknown as Record<string, unknown>)[name] !== "function") {
    (Blob.prototype as unknown as Record<string, () => Promise<unknown>>)[name] = function (this: Blob) {
      return new Promise((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = () => no(fr.error);
        if (name === "text") fr.readAsText(this);
        else fr.readAsArrayBuffer(this);
      });
    };
  }
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const NOW = new Date("2026-10-22T09:00:00.000Z");
const ID = "m-google";
const shell = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };

beforeAll(() => {
  enableDesktopAttachments();
});

const message = {
  id: ID, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Invitation: Quarterly planning", from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [{ name: "Mila Reader", address: "mila@example.test" }], cc: [],
  date: "2026-10-22T08:00:00.000Z", folder: "INBOX", snippet: GOOGLE.text, unread: false,
  hasAttachments: true, attachmentCount: 2,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-22T08:00:00.000Z",
} as unknown as EngineMessage;

function engineServing(shape: InviteShape): OhmailEngine {
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => shape.parts.map((p) => ({
      id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
      inline: p.inline, contentId: p.contentId, messageId: ID,
    })),
    fetchAttachment: async (id: string) => new Blob([shape.parts.find((p) => p.id === id)!.bytes], { type: "application/octet-stream" }),
  };
  return new OhmailEngine({ adapter });
}

function Desktop({ engine }: { engine: OhmailEngine }) {
  const attachments = useMessageAttachments(engine, ID, { conversationOf: () => [], onDownloadAllFailed: () => {} });
  return h(MessageChromeProvider as never, {
    value: {
      ownAddresses: ["mila@example.test"], absoluteTime: false, onToggleAbsoluteTime: () => {},
      replyTo: null, replyBody: { text: "", html: "" }, onReplyBody: () => {}, closeReply: () => {},
      sendReply: () => {}, replySendState: () => ({ phase: "idle" }), openSenderMenu: () => {},
      openAttachmentPreview: () => {}, conversationOf: () => [],
      bodyOf: () => ({ text: GOOGLE.text, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      hydrateBody: () => {}, hydrateBodies: () => {}, hydrateThread: () => {}, openReply: () => {}, forward: () => {},
      attachments,
    },
    children: h(MessagePane as never, {
      message, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
    } as never),
  } as never);
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  shell.__TAURI_INTERNALS__ = { invoke: async () => null };
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:tauri://localhost/obj";
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  delete shell.__TAURI_INTERNALS__;
});

async function until(done: () => boolean, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 20) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

describe("the desktop reading pane: one event card, above the mail", () => {
  it("a Google invitation's two calendar parts draw one card before the body", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Desktop, { engine: engineServing(GOOGLE) }),
    })));
    await until(() => host!.querySelectorAll("button.att-tile").length > 0 && host!.querySelector(".ics-card") !== null);
    // Settle past the arrival: a second card would land with the same texts.
    await until(() => false, 300);
    const cards = host.querySelectorAll(".ics-card");
    expect(cards, "the invitation drew no card, or one per part").toHaveLength(1);
    const body = host.querySelector(".msg-body");
    expect(body, "the premise: the pane drew the body").not.toBeNull();
    expect(body!.contains(cards[0]!)).toBe(false);
    expect(cards[0]!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING, "the card is under the body").toBeTruthy();
    const tiles = host.querySelectorAll("button.att-tile");
    expect(tiles, "invite.ics is listed twice, or the file left the strip").toHaveLength(1);
    expect(tiles[0]!.querySelector(".att-name")?.textContent).toBe("invite.ics");
  });

  it("an Exchange invitation (the alternative only) draws its card and keeps its one tile", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Desktop, { engine: engineServing(EXCHANGE_ICAL) }),
    })));
    await until(() => host!.querySelector(".ics-card") !== null);
    await until(() => false, 300);
    expect(host.querySelectorAll(".ics-card")).toHaveLength(1);
    const tiles = host.querySelectorAll(".att-strip .att-tile");
    expect(tiles, "the only copy of the event left the strip").toHaveLength(1);
    expect(tiles[0]!.querySelector(".att-name")?.textContent).toBe("invite.ics");
  });
});
