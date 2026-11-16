/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  messageDisplayTime,
  type EngineAdapter,
  type EngineMessage,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { metaLine } from "../app/shell/format";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * "Ohbox ·", AND THE SEPARATOR THAT INTRODUCED NOTHING.
 *
 * ── WALKED ON A LIVE ACCOUNT, 2026-08-04 ────────────────────────────────────────────────
 *
 * A message with **no `Date:` header** rendered a blank stamp and a dangling separator. Spam
 * and scripts omit `Date:` routinely; it is optional in practice and nothing in this pipeline
 * substitutes for it. `packages/core/src/mime.ts:459` writes `parsed.date ?? null`,
 * `dto/materialize.ts` passes the null through, and `messageDisplayTime` answers `""` —
 * correctly, because there is no instant to format. Three surfaces then interpolated that empty
 * string into templates that had already committed to the separator.
 *
 * A dangling "·" is not cosmetic. It is the interface asserting a second fact follows, when
 * there is none — the same untrue statement as this slice's five siblings, made in punctuation.
 *
 * ── WHERE THE FALLBACK BELONGS, AND WHERE IT DOES NOT ───────────────────────────────────
 *
 * The acceptance asks for IMAP INTERNALDATE and that is the right value — but it is not
 * reachable from any surface, and it is not reachable from the DTO either:
 *
 *  1. **Nothing persists it.** INTERNALDATE is read only for ORDERING, into an in-memory cache
 *     (`arrivalKey`, `packages/core/src/adapters/imap.ts:70`). `messages` has no column for it.
 *     The only always-present stamps `dto/materialize.ts` could coalesce to are `createdAt` /
 *     `updatedAt` — when OUR worker wrote the row — and `imap.ts:44-48` already records why
 *     that is the wrong answer: an imported mailbox "leaves every message stamped with the
 *     import time".
 *  2. **A non-null `MessageDTO.date` would desynchronise two orderings.** The server sorts by
 *     `messages.date`, still NULL; the client's `byDateDesc` reads a missing date as 0, i.e.
 *     oldest. A value synthesized on the wire would put an undated message NEWEST on the client
 *     and OLDEST on the server, and contract §5.2 makes the server's order the order.
 *
 * So the DTO is deliberately unchanged, the real repair is owed at ingest — where INTERNALDATE
 * is in hand and one write fixes every surface — and this file holds the display rule that
 * stops the product asserting a fact it does not have in the meantime. It stays correct after
 * the ingest fix lands: a date that is always present simply means no part is ever dropped.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

/** A real-shaped row. `date: null` is the whole point and is the DEFAULT here. */
function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: `${over.id}@spam.invalid` },
    to: [], cc: [], date: null, folder: "INBOX",
    snippet: "no date header on this one", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  } as EngineMessage;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  /* The DATED sibling's stamp renders in the reader's zone; pinned so this file keeps testing the
     SEPARATOR rather than the machine's timezone. */
  setActiveFormatZone("UTC");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setActiveFormatZone(null);
  host.remove();
});

const render = async (children: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children,
      }),
    );
  });
};

describe("the premise: an undated message really does reach the client with no stamp", () => {
  it("`messageDisplayTime` answers the empty string, and that is correct", () => {
    // Not a defect to fix in the formatter: there is no instant, so any string it invented
    // would be a claim about when a message was sent. The defect is what the CALLERS did with
    // the empty answer.
    expect(messageDisplayTime(msg({ id: "a" }), NOW, "UTC")).toBe("");
    expect(messageDisplayTime(msg({ id: "a", date: "not-a-date" }), NOW, "UTC")).toBe("");
  });
});

describe("the separator is never printed without a value on both sides", () => {
  it("metaLine drops empty parts rather than spacing around them", () => {
    /**
     * Mutation: make `metaLine` a plain `parts.join(" · ")`. Every assertion below except the
     * first goes red, with exactly the strings the walk found — "Ohbox · " and "thread (3) · ".
     */
    expect(metaLine("Ohbox", "09:12")).toBe("Ohbox · 09:12");
    expect(metaLine("Ohbox", "")).toBe("Ohbox");
    expect(metaLine("", "09:12")).toBe("09:12");
    expect(metaLine("thread (3)", "")).toBe("thread (3)");
    expect(metaLine("Ohbox", null, "from the archive")).toBe("Ohbox · from the archive");
    expect(metaLine(undefined, null, "")).toBe("");
    // Shape, not spelling: no output may begin or end with the separator, ever.
    for (const out of [metaLine("Ohbox", ""), metaLine("", "09:12"), metaLine("a", null, "b")]) {
      expect(out).not.toMatch(/^\s*·/);
      expect(out).not.toMatch(/·\s*$/);
    }
  });

  it("a search hit for an undated message says where it is and stops", async () => {
    const { SearchView } = await import("../app/views/SearchView.js");
    const { KeymapProvider } = await import("@ohmail/app/keys");

    const store = new MemoryMirrorStore();
    await store.load();
    const row = msg({ id: "nodate", subject: "Kingfisher invoice", folder: "INBOX" });
    await store.applyChanges([
      { type: "message", op: "create", id: row.id, seq: ++seq, updatedAt: row.updatedAt, entity: row },
    ]);
    const engine = new OhmailEngine({
      store,
      now: () => NOW,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
      } as unknown as EngineAdapter,
    });

    await render(
      h(KeymapProvider, {
        children: h(SearchView as never, {
          engine, version: 1, now: NOW, query: "kingfisher",
          onQuery: () => {}, onOpen: () => {},
        } as never),
      }),
    );

    const where = host.querySelector(".hit .where");
    expect(where, "the premise: the hit rendered").not.toBeNull();
    // The walked string, exactly.
    expect(where!.textContent).not.toBe("Ohbox · ");
    expect(where!.textContent).toBe("Ohbox");
  });

  it("the open message's header does not introduce a stamp it does not have", async () => {
    const { MessagePane } = await import("../app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

    const open = msg({ id: "open", subject: "No date on this one" });
    const sibling = msg({ id: "sib", subject: "No date on this one" });

    host.className = "read-col";
    await render(
      h(MessageChromeProvider as never, {
        value: {
          ownAddresses: [],
          replyTo: null,
          replyBody: "",
          onReplyBody: () => {},
          closeReply: () => {},
          sendReply: () => {},
          replySendState: () => ({ phase: "idle" }),
          openSenderMenu: () => {},
          // Three in the thread, so the pane takes the conversation path.
          conversationOf: () => [open, sibling, msg({ id: "sib2" })],
          bodyOf: (m: Record<string, unknown>) => ({ text: m.snippet as string, state: "snippet" }),
          hydrateBody: () => {},
          hydrateThread: () => {},
        },
        children: h(MessagePane as never, {
          message: open, tags: [], now: NOW,
          onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
        } as never),
      } as never),
    );

    // The focused message wears its own header; an undated one leaves the stamp slot empty
    // rather than dangling a separator.
    const stamp = host.querySelector(".conv-focus .msg-from .t");
    expect(stamp, "the premise: the focused message rendered its header").not.toBeNull();
    const t = stamp!.textContent ?? "";
    expect(t, "a separator with nothing after it").not.toMatch(/·\s*$/);
    // The header no longer carries "thread (N)" — and the count line is gone with the
    // panel redesign, which forbids restating the thread as a number anywhere.
    expect(host.querySelector(".conv-head")).toBeNull();
    expect(host.textContent).not.toContain("on this conversation");
  });

  it("a thread sibling's panel with no stamp renders no stamp element at all", async () => {
    // A panel's header guards its stamp (`{rel ? … : null}`, `MessageHeader`); a dateless one
    // leaves no empty `.t time`. Red by rendering the stamp button unconditionally.
    const { ConversationPanels } = await import("../app/shell/Conversation.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

    await render(
      h(MessageChromeProvider as never, {
        value: chromeStub(),
        children: h(ConversationPanels as never, {
          messages: [msg({ id: "s1" }), msg({ id: "focus" })],
          focusedId: "focus",
          focusedPanel: h("article", { className: "pm conv-focus", "data-conv-id": "focus" }),
          now: NOW,
          threadSubject: "Subject s1",
        } as never),
      } as never),
    );

    expect(host.querySelectorAll(".pm").length, "the premise: the panels rendered").toBe(2);
    expect(host.querySelectorAll(".pm .msg-from .t time").length).toBe(0);
  });

  it("and a DATED sibling's panel still renders one — the guard did not just delete the slot", async () => {
    const { ConversationPanels } = await import("../app/shell/Conversation.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

    await render(
      h(MessageChromeProvider as never, {
        value: chromeStub(),
        children: h(ConversationPanels as never, {
          messages: [msg({ id: "s1", date: "2026-08-04T09:12:00.000Z" }), msg({ id: "focus" })],
          focusedId: "focus",
          focusedPanel: h("article", { className: "pm conv-focus", "data-conv-id": "focus" }),
          now: NOW,
          threadSubject: "Subject s1",
        } as never),
      } as never),
    );

    expect(host.querySelectorAll(".pm .msg-from .t time").length).toBe(1);
    expect(host.querySelector(".pm .msg-from .t time")!.textContent).toBe("09:12");
  });
});

/** The inert chrome a bare panel needs: bodies answer as snippets, nothing dispatches. */
function chromeStub(): Record<string, unknown> {
  return {
    ownAddresses: [],
    replyTo: null,
    replyBody: { text: "", html: "" },
    onReplyBody: () => {},
    closeReply: () => {},
    sendReply: () => {},
    replySendState: () => ({ phase: "idle" }),
    openSenderMenu: () => {},
    conversationOf: () => [],
    bodyOf: (m: Record<string, unknown>) => ({
      text: m.snippet as string, state: "snippet", html: null,
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
    hydrateBody: () => {},
    hydrateThread: () => {},
  };
}
