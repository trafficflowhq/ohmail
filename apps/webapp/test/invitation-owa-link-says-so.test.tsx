/** @vitest-environment jsdom */
/**
 * ═══ A MEETING INVITATION THAT ARRIVED AS AN OUTLOOK WEB APP LINK SAYS SO, ON EVERY BODY SURFACE ═══
 *
 * Reported 2026-10-19: on a desktop signed in to Cloud, an Exchange invitation served over IMAP
 * as an OWA link showed no card and no note. That desktop holds no headers, so the header fact is
 * false there; the body text is the evidence it has. The note names the setting, links only to the
 * rebuilt Microsoft 365 options page, reports that link to the shell, and stays outside the mail.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";
import { setRenderedLinksSink } from "../../../packages/letter-body/src/rendered-links";

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

type Catalog = Record<string, Record<string, string>>;
const DE_MERGED = fillFrom(en as never, de as never) as never;
const EN = (en as unknown as Catalog).body!;

const NOW = new Date("2026-10-19T09:00:00.000Z");

const BASE = "https://outlook.office365.com/owa/tenant.example/";
const OPTS = `${BASE}?path=/options/popandimap`;
/** The link ohmail offers: constants only, never the message's /owa/<segment>/ (a sign-in realm). */
const HREF = "https://outlook.office365.com/owa/?path=/options/popandimap";
const STUB = [
  "Microsoft Outlook Web Access:",
  `${BASE}?itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&exvsurl=1&path=/calendar/item`,
  "",
  "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
  `${OPTS}&extra=1 and select Send meeting invitations in iCalendar format.`,
].join("\n");
const ORDINARY = `Here is the calendar for next week:\n${BASE}?itemid=AAMk&path=/calendar/item\nSee you there.`;

function msg(id: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Think tank ${id}`,
    from: { name: "A Colleague", address: "colleague@example.invalid" },
    to: [{ name: "Me", address: "me@x.invalid" }], cc: [],
    date: "2026-10-19T08:29:52.000Z", folder: "INBOX", snippet: "Microsoft Outlook Web Access:", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-19T08:30:10.000Z",
    ...extra,
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let reported = new Map<string, readonly string[]>();

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
  setRenderedLinksSink(null);
  setActiveCatalog(DEFAULT_LOCALE, null);
});

type Body = { text: string; state?: "full" | "snippet" | "loading" };

async function mount(open: EngineMessage, body: Body, opts: { locale?: "en" | "de"; dull?: boolean } = {}) {
  await unmount();
  reported = new Map();
  setRenderedLinksSink((surface, hrefs) => {
    if (hrefs.length === 0) reported.delete(surface);
    else reported.set(surface, hrefs);
  });
  const locale = opts.locale ?? "en";
  const { HeldMail } = await import("../app/views/ScreenerView.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const view = h(HeldMail as never, {
    messageId: open.id, message: { id: open.id, snippet: open.snippet },
    from: "A Colleague", subject: open.subject, body: open.snippet, ...(opts.dull ? { dull: true } : {}),
  } as never);
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
            bodyOf: () => ({
              text: body.text, state: body.state ?? "full", html: null, loadedRemoteContent: false,
              unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            hydrateBodies: () => {},
            hydrateThread: () => {},
            openReply: () => {},
            forward: () => {},
          },
          children: view,
        } as never),
      }),
    );
  });
  await settle();
  return host;
}

const reportedHrefs = (): string[] => [...reported.values()].flat();
const settingLink = (el: HTMLElement): HTMLAnchorElement | null =>
  [...el.querySelectorAll<HTMLAnchorElement>("[role=note] a")][0] ?? null;

describe("the other body surfaces say the same", () => {
  it("the Screener's preview: the stub line above .hm-body, with the link", async () => {
    const el = await mount(msg("held"), { text: STUB });
    expect(el.textContent).toContain(EN.invitationOwaLink);
    expect(settingLink(el)?.getAttribute("href")).toBe(HREF);
    expect(el.querySelector(".hm-body")!.textContent).not.toContain(EN.invitationOwaLink);
    expect(reportedHrefs()).toContain(HREF);
  });

  it("a dull Screener preview (spam, junk, screened out) says nothing: a lure there gets no ohmail voice", async () => {
    const el = await mount(msg("held-dull"), { text: STUB }, { dull: true });
    expect(el.querySelector("[role=note]")).toBeNull();
    expect(el.textContent).not.toContain(EN.invitationOwaLink);
    expect(reportedHrefs()).not.toContain(HREF);
    expect(el.querySelector(".hm-body")!.textContent).toContain("Microsoft Outlook Web Access:");
  });

  it("the Screener's preview of ordinary mail says nothing", async () => {
    const el = await mount(msg("held2"), { text: ORDINARY });
    expect(el.querySelector("[role=note]")).toBeNull();
  });
});
