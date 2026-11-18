/** @vitest-environment jsdom */
/**
 * ═══ AN INVITATION WE CANNOT SHOW SAYS SO, IN THE READING PANE ═══════════════════════════════
 *
 * The 2026-09-16 report's first move: an Outlook Web Access invitation whose mail system sent the
 * event as a LINK — no `text/calendar` part, no card, and the pane rendered OWA's boilerplate AS
 * the message. That silence is what sent a user to another mail app.
 *
 * MUTATION-WATCHED (each reddens the case named and no other): the flag forced false → the two
 * "says so" cases; the line rendered unconditionally → the two "says nothing" controls.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const DE_MERGED = fillFrom(en as never, de as never) as never;
const EN_LINE = (en as unknown as Record<string, Record<string, string>>).body!.invitationWithoutEvent!;
const DE_LINE = (de as unknown as Record<string, Record<string, string>>).body!.invitationWithoutEvent!;

const NOW = new Date("2026-09-16T12:00:00.000Z");

/** The OWA body a reader was shown instead of an event — the boilerplate, verbatim in shape. */
const OWA_BODY =
  "<p>Microsoft Outlook Web Access: <a href=\"https://example.invalid/owa/x\">open this invitation</a>. "
  + "To receive meeting invitations as .iCalendar attachments instead, change your settings.</p>";

function msg(id: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Austausch ${id}`,
    from: { name: "A Colleague", address: "colleague@example.invalid" },
    to: [{ name: "Me", address: "me@x.invalid" }], cc: [],
    date: "2026-09-16T08:29:52.000Z", folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-16T08:30:10.000Z",
    ...extra,
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

afterEach(async () => {
  await unmount();
  setActiveCatalog(DEFAULT_LOCALE, null);
});

/** The reading pane through its chrome, as `block-notice-surfaces.test.tsx` drives it. */
async function mountPane(
  open: EngineMessage, opts: { html?: string; locale?: "en" | "de" } = {},
): Promise<HTMLDivElement> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const html = opts.html ?? OWA_BODY;
  const locale = opts.locale ?? "en";
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? DE_MERGED : en, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            ownAddresses: ["me@x.invalid"],
            absoluteTime: false,
            onToggleAbsoluteTime: () => {},
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            openAttachmentPreview: () => {},
            conversationOf: () => [],
            bodyOf: (m: EngineMessage) => ({
              text: m.snippet, state: "full", html, loadedRemoteContent: false,
              unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            hydrateThread: () => {},
            openReply: () => {},
            forward: () => {},
          },
          children: h(MessagePane as never, {
            message: open, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
  await settle();
  return host;
}

describe("the reading pane says an invitation arrived whose event it cannot show", () => {
  it("renders the line for an invitation with no event", async () => {
    const el = await mountPane(msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>));
    expect(el.textContent).toContain(EN_LINE);
  });

  /** German reads German — the line is catalogue copy, not a literal in the component. */
  it("renders the German line for a German reader", async () => {
    const el = await mountPane(
      msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>), { locale: "de" },
    );
    expect(el.textContent).toContain(DE_LINE);
  });

  /**
   * THE POSITIVE CONTROL ON THE OTHER ARM: a message whose event CAN be shown — the flag is
   * false, which is what the server answers whenever a calendar part exists — says nothing. The
   * card itself is the attachment strip's and is held by `mime-calendar.test.ts`.
   */
  it("says nothing when the flag is false", async () => {
    const el = await mountPane(msg("withcard", { invitationWithoutEvent: false } as Partial<EngineMessage>));
    expect(el.textContent).not.toContain(EN_LINE);
  });

  /** An older mirror or server leaves the field ABSENT, which must read exactly like false. */
  it("says nothing when the field is absent", async () => {
    const el = await mountPane(msg("older"));
    expect(el.textContent).not.toContain(EN_LINE);
  });

  /**
   * THE LINE IS NOT THE MAIL. `.msg-body` is the one element that holds the message and nothing
   * else — `test/conversation.test.ts` and `test/inline-reply.test.ts` select on it — so product
   * speech about the message belongs beside it, never inside it.
   */
  it("keeps the line OUTSIDE .msg-body", async () => {
    const el = await mountPane(msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>));
    expect(el.textContent).toContain(EN_LINE);
    expect(el.querySelector(".msg-body")!.textContent).not.toContain(EN_LINE);
  });
});
