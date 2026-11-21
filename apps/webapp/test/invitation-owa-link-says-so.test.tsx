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
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { setRenderedLinksSink } from "../../../packages/letter-body/src/rendered-links";
import { answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";

const EN = en.body;

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

let reported = new Map<string, readonly string[]>();

function setup() {
  installShellEnv();
  vi.setSystemTime(NOW);
  reported = new Map();
  setRenderedLinksSink((surface, hrefs) => {
    if (hrefs.length === 0) reported.delete(surface);
    else reported.set(surface, hrefs);
  });
}

beforeEach(setup);

afterEach(async () => {
  await teardownShellEnv();
  setRenderedLinksSink(null);
});

const refused = async () => { throw new Error("This action is outside the invitation test"); };
const junkWire: JunkWire = {
  list: async () => ({
    mailboxes: [{ id: "mb", address: msg("junk").to[0]!.address, window: "ok" }],
    items: [{
      mailboxId: "mb", uid: 1, uidValidity: "7", subject: "Think tank held",
      from: msg("junk").from, date: NOW.toISOString(), messageIdHeader: null, seen: false, origin: "provider",
    }],
    nextCursor: null,
  }),
  body: async () => ({ subject: "Think tank held", text: STUB }),
  rescue: refused,
  dismissRescue: refused,
  search: refused,
  sweepPreview: async () => ({ mailboxes: [], movable: 0, pending: false }),
  sweepRequest: refused,
  isGone: () => false,
  codeOf: () => null,
};

type Segment = "Waiting" | "Screened out" | "Spam" | "Junk";
async function mount(segment: Segment, text: string) {
  const folders: Record<Segment, EngineMessage["folder"]> = {
    Waiting: "ohmail/Screener", "Screened out": "ohmail/Screened",
    Spam: "ohmail/Quarantine", Junk: "ohmail/Quarantine",
  };
  const letter = msg("held", { folder: folders[segment] });
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", id: letter.id, seq: 1, updatedAt: letter.updatedAt, entity: letter,
  }]);
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" }),
      fetchBody: async () => ({ text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
  if (segment === "Junk") answerConsentWith({ foldersEnabledAt: NOW.toISOString() });
  window.location.hash = "#/screener/waiting";
  await engine.start();
  const view = within(await mountShell([mailbox({ id: "mb", lastSyncAt: NOW.toISOString() })], {
    engine, junkWire: segment === "Junk" ? junkWire : "none",
  }));
  await tick(500);
  fireEvent.click(view.getByRole("button", { name: new RegExp(`^${segment}(?:$|[, ])`) }));
  await tick(500);
  const reading = within(view.getByRole("region", { name: en.frame.landmark.reading }));
  const article = reading.getByRole("article");
  expect(article.textContent).toContain("Think tank held");
  return article;
}

const reportedHrefs = (): string[] => [...reported.values()].flat();

describe("the other body surfaces say the same", () => {
  it("the Screener's preview: the stub line above .hm-body, with the link", async () => {
    const article = await mount("Waiting", STUB);
    const note = within(article).getByRole("note");
    const body = within(article).getByText(/Microsoft Outlook Web Access:/);
    expect(note.textContent).toContain(EN.invitationOwaLink);
    expect(within(note).getByRole("link", { name: EN.invitationOwaOpenSetting }).getAttribute("href")).toBe(HREF);
    expect(body.textContent).not.toContain(EN.invitationOwaLink);
    expect(note.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reportedHrefs()).toContain(HREF);
  });

  it("a dull Screener preview (spam, junk, screened out) says nothing: a lure there gets no ohmail voice", async () => {
    for (const [index, segment] of (["Screened out", "Spam", "Junk"] as const).entries()) {
      if (index > 0) {
        await teardownShellEnv();
        setup();
      }
      const article = await mount(segment, STUB);
      expect(within(article).queryByRole("note")).toBeNull();
      expect(article.textContent).not.toContain(EN.invitationOwaLink);
      expect(reportedHrefs()).not.toContain(HREF);
      expect(within(article).getByText(/Microsoft Outlook Web Access:/)).toBeTruthy();
    }
  });

  it("the Screener's preview of ordinary mail says nothing", async () => {
    const article = await mount("Waiting", ORDINARY);
    expect(within(article).getByText(/Here is the calendar for next week:/)).toBeTruthy();
    expect(within(article).queryByRole("note")).toBeNull();
    expect(reportedHrefs()).not.toContain(HREF);
  });
});
