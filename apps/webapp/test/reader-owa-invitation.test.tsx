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
import en from "../messages/en.json";
import de from "../messages/de.json";
import { setRenderedLinksSink } from "../../../packages/letter-body/src/rendered-links";
import { mountInvitationLetter } from "./fixtures/reader-invitation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const EN = (en as unknown as Catalog).body!;
const DE = (de as unknown as Catalog).body!;

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
const ONPREM_STUB = STUB.replaceAll(BASE, "https://mail.corp.example/owa/");
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

let unmountReader: (() => void) | null = null;
let reported = new Map<string, readonly string[]>();

function unmount() {
  unmountReader?.();
  unmountReader = null;
}

afterEach(() => { unmount(); setRenderedLinksSink(null); });

type Body = { text: string; state?: "full" | "snippet" | "loading" };

function mount(open: EngineMessage, body: Body, opts: { surface?: "card"; locale?: "en" | "de" } = {}) {
  unmount();
  reported = new Map();
  setRenderedLinksSink((surface, hrefs) => {
    if (hrefs.length === 0) reported.delete(surface);
    else reported.set(surface, hrefs);
  });
  const reader = mountInvitationLetter(open, body, { locale: opts.locale, sibling: opts.surface === "card" });
  unmountReader = reader.unmount;
  return reader.element;
}

const reportedHrefs = (): string[] => [...reported.values()].flat();
const settingLink = (el: HTMLElement): HTMLAnchorElement | null =>
  [...el.querySelectorAll<HTMLAnchorElement>("[role=note] a")][0] ?? null;

describe("the reading pane: an OWA invitation stub", () => {
  it("says so, with the remedy and the setting's link, when the header fact is absent (Cloud desktop)", () => {
    const el = mount(msg("owa"), { text: STUB });
    expect(el.textContent).toContain(EN.invitationOwaLink);
    expect(el.textContent).toContain(EN.invitationOwaRemedy);
    const a = settingLink(el);
    expect(a?.getAttribute("href")).toBe(HREF);
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.textContent).toBe(EN.invitationOwaOpenSetting);
    expect(reportedHrefs()).toContain(HREF);
  });

  it("says so when the header fact is false", () => {
    const el = mount(msg("owa", { invitationWithoutEvent: false } as Partial<EngineMessage>), { text: STUB });
    expect(el.textContent).toContain(EN.invitationOwaLink);
  });

  it("the stub line wins over the generic one when the header fact is true", () => {
    const el = mount(msg("owa", { invitationWithoutEvent: true } as Partial<EngineMessage>), { text: STUB });
    expect(el.textContent).toContain(EN.invitationOwaLink);
    expect(el.textContent).not.toContain(EN.invitationWithoutEvent);
    expect(el.querySelectorAll("[role=note]")).toHaveLength(1);
  });

  it("a stub naming another sign-in realm gets the same constant link", () => {
    const realm = STUB.replaceAll(BASE, "https://outlook.office365.com/owa/attacker-federated.example/");
    const el = mount(msg("realm"), { text: realm });
    expect(settingLink(el)?.getAttribute("href")).toBe(HREF);
    expect(reportedHrefs()).toContain(HREF);
  });

  it("the stub line claims nothing about who delivered it: anyone can send a stub", () => {
    expect(EN.invitationOwaLink).not.toMatch(/mail server/i);
    expect(DE.invitationOwaLink).not.toMatch(/mailserver/i);
  });

  it("on-premises Exchange: the line and the remedy, no link", () => {
    const el = mount(msg("onprem"), { text: ONPREM_STUB });
    expect(el.textContent).toContain(EN.invitationOwaLink);
    expect(settingLink(el)).toBeNull();
    expect(reportedHrefs()).not.toContain(HREF);
  });

  it("the note stands outside .msg-body, which still holds the whole stub", () => {
    const el = mount(msg("owa"), { text: STUB });
    const mail = el.querySelector("[data-read-body]")!;
    expect(mail.textContent).not.toContain(EN.invitationOwaLink);
    expect(mail.textContent).toContain("Microsoft Outlook Web Access:");
    expect(mail.textContent).toContain("select Send meeting invitations in iCalendar format.");
    expect(mail.querySelector("[role=note]")).toBeNull();
  });

  it("reads German for a German reader", () => {
    const el = mount(msg("owa"), { text: STUB }, { locale: "de" });
    expect(el.textContent).toContain(DE.invitationOwaLink);
    expect(el.textContent).toContain(DE.invitationOwaRemedy);
    expect(settingLink(el)?.textContent).toBe(DE.invitationOwaOpenSetting);
  });
});

describe("the reading pane: everything else stays as it was", () => {
  it("the header fact with an ordinary body keeps the generic line", () => {
    const el = mount(msg("hdr", { invitationWithoutEvent: true } as Partial<EngineMessage>), { text: "Agenda attached." });
    expect(el.textContent).toContain(EN.invitationWithoutEvent);
    expect(el.textContent).not.toContain(EN.invitationOwaLink);
  });

  it("a real .ics invitation (fact false, ordinary body) says nothing", () => {
    const el = mount(
      msg("ics", { invitationWithoutEvent: false, hasAttachments: true, attachmentCount: 1 } as Partial<EngineMessage>),
      { text: "You are invited to Think tank.\nWhen: Thursday 14:00" },
    );
    expect(el.querySelector("[role=note]")).toBeNull();
  });

  it("ordinary mail with an Outlook calendar link says nothing", () => {
    const el = mount(msg("plain"), { text: ORDINARY });
    expect(el.textContent).not.toContain(EN.invitationOwaLink);
    expect(el.querySelector("[role=note]")).toBeNull();
    expect(reportedHrefs()).not.toContain(HREF);
  });

  it("a snippet or a loading body is never read for the stub", () => {
    for (const state of ["snippet", "loading"] as const) {
      const el = mount(msg(`s-${state}`), { text: STUB, state });
      expect(el.textContent, state).not.toContain(EN.invitationOwaLink);
    }
  });
});

describe("the other body surfaces say the same", () => {
  it("a conversation panel: the invitation link follows the body, outside its text", () => {
    const el = mount(msg("card"), { text: STUB }, { surface: "card" });
    expect(el.textContent).toContain(EN.invitationOwaLink);
    expect(settingLink(el)?.getAttribute("href")).toBe(HREF);
    const mail = el.querySelector("[data-read-body]")!;
    const note = el.querySelector("[role=note]")!;
    expect(mail.textContent).not.toContain(EN.invitationOwaLink);
    expect(mail.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a conversation panel keeps the generic line for the header fact", () => {
    const el = mount(msg("card2", { invitationWithoutEvent: true } as Partial<EngineMessage>), { text: "Agenda." }, { surface: "card" });
    expect(el.textContent).toContain(EN.invitationWithoutEvent);
  });
});
